"""Signed Desktop release cache. SQLite coordinates leases across ASGI workers.

Only completed, verified packages are advertised. No client-provided URL is fetched.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings

VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


class Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    payload: str = Field(max_length=64000)
    signature: str = Field(max_length=128)


def verify_manifest(envelope: Envelope, public_key: str, max_bytes: int) -> dict:
    if not public_key:
        raise HTTPException(503, "Desktop update signing key is not configured")
    try:
        payload = base64.b64decode(envelope.payload, validate=True)
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key, validate=True)).verify(
            base64.b64decode(envelope.signature, validate=True), payload
        )
        data = json.loads(payload)
        version = data["version"]
        valid = (
            VERSION.fullmatch(version)
            and data["schema"] == 1
            and data["platform"] == "windows-x86_64"
            and data["kind"] == "nsis"
            and data["file_name"] == f"AAW-Desktop-{version}-windows-x64-setup.exe"
            and type(data["size"]) is int
            and 0 < data["size"] <= max_bytes
            and re.fullmatch(r"[a-f0-9]{64}", data["sha256"])
            and isinstance(data.get("notes", ""), str)
        )
        if not valid:
            raise ValueError("Invalid manifest fields")
        return data
    except Exception as exc:
        raise HTTPException(422, "Invalid signed Desktop manifest") from exc


def build_desktop_updates_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/api/v1/desktop", tags=["desktop updates"])
    root = settings.desktop_release_dir

    @contextmanager
    def database():
        root.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(root / "cache.sqlite", timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.execute(
                "CREATE TABLE IF NOT EXISTS packages (hash TEXT PRIMARY KEY, "
                "envelope TEXT, size INTEGER, token TEXT, expires REAL, ready INTEGER)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS attempts (client TEXT PRIMARY KEY, "
                "started REAL, count INTEGER)"
            )
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def cleanup(db):
        now = time.time()
        # Lease duration bounds incomplete files, including abandoned uploads after restart.
        for path in root.glob("*.part"):
            if now - path.stat().st_mtime > settings.desktop_update_lease_seconds * 2:
                path.unlink(missing_ok=True)
        db.execute("DELETE FROM attempts WHERE started < ?", (now - 3600,))

    @router.get("/latest")
    def latest():
        candidates = []
        with database() as db:
            cleanup(db)
            for row in db.execute("SELECT * FROM packages WHERE ready=1"):
                try:
                    envelope = Envelope.model_validate_json(row["envelope"])
                    data = verify_manifest(
                        envelope,
                        settings.desktop_update_public_key,
                        settings.desktop_update_max_bytes,
                    )
                    path = root / f"{row['hash']}.exe"
                    if path.is_file() and path.stat().st_size == data["size"]:
                        candidates.append((tuple(map(int, data["version"].split("."))), envelope))
                except HTTPException:
                    continue
        return max(candidates, key=lambda item: item[0])[1] if candidates else None

    @router.post("/uploads")
    def claim(envelope: Envelope, request: Request):
        data = verify_manifest(
            envelope, settings.desktop_update_public_key, settings.desktop_update_max_bytes
        )
        digest = data["sha256"]
        now = time.time()
        client = request.client.host if request.client else "unknown"
        with database() as db:
            cleanup(db)
            row = db.execute("SELECT * FROM packages WHERE hash=?", (digest,)).fetchone()
            if row and row["ready"] and (root / f"{digest}.exe").is_file():
                return {"status": "ready"}
            if row and row["expires"] > now:
                return {"status": "busy"}
            attempt = db.execute("SELECT * FROM attempts WHERE client=?", (client,)).fetchone()
            count = attempt["count"] if attempt and attempt["started"] > now - 60 else 0
            if count >= 10:
                raise HTTPException(429, "Too many upload claims")
            db.execute(
                "INSERT OR REPLACE INTO attempts VALUES (?,?,?)",
                (client, attempt["started"] if count else now, count + 1),
            )
            reserved = db.execute(
                "SELECT COALESCE(SUM(size),0), COUNT(*) FROM packages WHERE ready=1 OR expires>?",
                (now,),
            ).fetchone()
            active = db.execute(
                "SELECT COUNT(*) FROM packages WHERE ready=0 AND expires>?", (now,)
            ).fetchone()[0]
            if active >= 4 or reserved[0] + data["size"] > settings.desktop_update_quota_bytes:
                raise HTTPException(503, "Release cache capacity reached")
            token = secrets.token_urlsafe(32)
            db.execute(
                "INSERT OR REPLACE INTO packages VALUES (?,?,?,?,?,0)",
                (
                    digest,
                    envelope.model_dump_json(),
                    data["size"],
                    token,
                    now + settings.desktop_update_lease_seconds,
                ),
            )
        return {"status": "upload", "token": token, "sha256": digest}

    @router.put("/uploads/{digest}")
    async def upload(digest: str, request: Request, authorization: str = Header(default="")):
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise HTTPException(404)
        with database() as db:
            row = db.execute("SELECT * FROM packages WHERE hash=?", (digest,)).fetchone()
            if (
                not row
                or row["ready"]
                or row["expires"] <= time.time()
                or not secrets.compare_digest(authorization, f"Bearer {row['token']}")
            ):
                raise HTTPException(409, "Upload lease expired or invalid")
            expected = row["size"]
        # Exclusive create prevents two requests using the same lease from racing.
        path = root / f"{digest}.{hashlib.sha256(authorization.encode()).hexdigest()}.part"
        try:
            stream = path.open("xb")
        except FileExistsError as exc:
            raise HTTPException(409, "Upload already in progress") from exc
        try:
            size, checksum = 0, hashlib.sha256()
            with stream:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > expected:
                        raise HTTPException(413, "Package exceeds signed size")
                    checksum.update(chunk)
                    stream.write(chunk)
            if size != expected or checksum.hexdigest() != digest:
                raise HTTPException(422, "Package checksum mismatch")
            with database() as db:
                current = db.execute("SELECT * FROM packages WHERE hash=?", (digest,)).fetchone()
                if current["token"] != row["token"] or current["expires"] <= time.time():
                    raise HTTPException(409, "Upload lease expired")
                verify_manifest(
                    Envelope.model_validate_json(current["envelope"]),
                    settings.desktop_update_public_key,
                    settings.desktop_update_max_bytes,
                )
                path.replace(root / f"{digest}.exe")
                db.execute(
                    "UPDATE packages SET ready=1, token='', expires=0 WHERE hash=?", (digest,)
                )
            return {"status": "ready"}
        finally:
            path.unlink(missing_ok=True)

    @router.get("/packages/{digest}")
    def download(digest: str):
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise HTTPException(404)
        with database() as db:
            row = db.execute(
                "SELECT * FROM packages WHERE hash=? AND ready=1", (digest,)
            ).fetchone()
        if not row or not (root / f"{digest}.exe").is_file():
            raise HTTPException(404)
        data = verify_manifest(
            Envelope.model_validate_json(row["envelope"]),
            settings.desktop_update_public_key,
            settings.desktop_update_max_bytes,
        )
        return FileResponse(root / f"{digest}.exe", filename=data["file_name"])

    return router
