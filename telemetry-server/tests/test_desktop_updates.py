import base64
import hashlib
import json
import runpy
import sqlite3
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aaw_telemetry.config import Settings
from aaw_telemetry.middleware import RequestBodyLimitMiddleware
from aaw_telemetry.routers.desktop_updates import (
    Envelope,
    build_desktop_updates_router,
    verify_manifest,
)


@pytest.fixture
def update_cache(tmp_path):
    key = Ed25519PrivateKey.generate()
    public = base64.b64encode(
        key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode()
    settings = Settings(
        database_url="sqlite://",
        desktop_release_dir=tmp_path,
        desktop_update_public_key=public,
        desktop_update_max_bytes=2048,
    )
    app = FastAPI()
    app.include_router(build_desktop_updates_router(settings))
    app.add_middleware(
        RequestBodyLimitMiddleware,
        max_bytes=1024,
        max_object_bytes=2048,
        max_issue_image_bytes=2048,
        max_desktop_update_bytes=2048,
    )

    def manifest(content=b"official package", version="0.2.0", **overrides):
        payload = {
            "schema": 1,
            "version": version,
            "platform": "windows-x86_64",
            "kind": "nsis",
            "file_name": f"AAW-Desktop-{version}-windows-x64-setup.exe",
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "notes": "测试",
        }
        payload.update(overrides)
        raw = json.dumps(payload).encode()
        return {
            "payload": base64.b64encode(raw).decode(),
            "signature": base64.b64encode(key.sign(raw)).decode(),
        }

    with TestClient(app) as client:
        yield client, manifest, settings


def claim(client, envelope):
    response = client.post("/api/v1/desktop/uploads", json=envelope)
    assert response.status_code == 200, response.text
    result = response.json()
    return result, {"Authorization": f"Bearer {result.get('token', '')}"}


def test_publish_only_after_verified_upload_and_deduplicate(update_cache):
    client, manifest, _ = update_cache
    envelope = manifest()
    first, headers = claim(client, envelope)
    assert first["status"] == "upload"
    assert client.get("/api/v1/desktop/latest").json() is None
    assert claim(client, envelope)[0]["status"] == "busy"
    url = f"/api/v1/desktop/uploads/{first['sha256']}"
    assert client.put(url, content=b"official package").status_code == 409
    assert client.put(url, headers=headers, content=b"corrupt").status_code == 422
    assert client.get("/api/v1/desktop/latest").json() is None
    assert client.put(url, headers=headers, content=b"official package").status_code == 200
    assert client.get("/api/v1/desktop/latest").json() == envelope
    assert claim(client, envelope)[0]["status"] == "ready"
    assert client.get(f"/api/v1/desktop/packages/{first['sha256']}").content == b"official package"


@pytest.mark.parametrize(
    "overrides",
    [
        {"platform": "linux"},
        {"version": "1.2.3-beta"},
        {"file_name": "../../bad.exe"},
        {"size": 99999},
        {"sha256": "bad"},
        {"schema": 2},
        {"kind": "portable"},
    ],
)
def test_reject_signed_but_invalid_manifest(update_cache, overrides):
    client, manifest, _ = update_cache
    assert client.post("/api/v1/desktop/uploads", json=manifest(**overrides)).status_code == 422


def test_signature_tamper_and_missing_key(update_cache):
    client, manifest, settings = update_cache
    envelope = manifest()
    envelope["payload"] = base64.b64encode(b"{}").decode()
    assert client.post("/api/v1/desktop/uploads", json=envelope).status_code == 422
    settings.desktop_update_public_key = ""
    assert client.post("/api/v1/desktop/uploads", json=manifest()).status_code == 503


def test_expired_lease_replaced_and_old_owner_rejected(update_cache):
    client, manifest, settings = update_cache
    old, old_headers = claim(client, manifest())
    with sqlite3.connect(settings.desktop_release_dir / "cache.sqlite") as db:
        db.execute("UPDATE packages SET expires=0")
    new, headers = claim(client, manifest())
    assert new["token"] != old["token"]
    url = f"/api/v1/desktop/uploads/{new['sha256']}"
    assert client.put(url, headers=old_headers, content=b"official package").status_code == 409
    assert client.put(url, headers=headers, content=b"official package").status_code == 200


def test_size_limit_cache_quota_and_numeric_version(update_cache):
    client, manifest, settings = update_cache
    for version in ["0.10.0", "0.9.0"]:
        content = version.encode()
        result, headers = claim(client, manifest(content, version))
        assert (
            client.put(
                f"/api/v1/desktop/uploads/{result['sha256']}", headers=headers, content=content
            ).status_code
            == 200
        )
    latest = json.loads(base64.b64decode(client.get("/api/v1/desktop/latest").json()["payload"]))
    assert latest["version"] == "0.10.0"
    result, headers = claim(client, manifest())
    url = f"/api/v1/desktop/uploads/{result['sha256']}"
    assert client.put(url, headers=headers, content=b"x" * 2049).status_code == 413
    assert client.put(url, headers=headers, content=b"x" * 17).status_code == 413
    settings.desktop_update_quota_bytes = 1
    assert client.post("/api/v1/desktop/uploads", json=manifest(b"different")).status_code == 503


def test_incomplete_files_not_advertised_and_invalid_download(update_cache):
    client, _, settings = update_cache
    (settings.desktop_release_dir / "unfinished.part").write_bytes(b"partial")
    assert client.get("/api/v1/desktop/latest").json() is None
    assert client.get("/api/v1/desktop/packages/invalid").status_code == 404
    assert client.get("/api/v1/desktop/packages/" + "a" * 64).status_code == 404


def test_release_signer_and_server_agree_on_exact_utf8_bytes(tmp_path, monkeypatch):
    # A deterministic test-only seed, never used in release configuration.
    seed = bytes([7]) * 32
    key = Ed25519PrivateKey.from_private_bytes(seed)
    public = base64.b64encode(
        key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode()
    monkeypatch.setenv("AAW_DESKTOP_SIGNING_KEY", base64.b64encode(seed).decode())
    monkeypatch.setenv("AAW_DESKTOP_UPDATE_PUBLIC_KEY", public)
    script = Path(__file__).resolve().parents[2] / "desktop/scripts/sign-update.py"
    sign = runpy.run_path(str(script))["sign"]
    artifact = tmp_path / "AAW-Desktop-0.2.0-windows-x64-setup.exe"
    artifact.write_bytes(b"abc")
    envelope = sign(artifact, "0.2.0", "中文更新说明")
    data = verify_manifest(Envelope(**envelope), public, 1024)
    assert data["notes"] == "中文更新说明"
    assert data["sha256"] == hashlib.sha256(b"abc").hexdigest()
    with pytest.raises(ValueError, match="stable"):
        sign(artifact, "0.2.0-beta", "")
    monkeypatch.setenv("AAW_DESKTOP_UPDATE_PUBLIC_KEY", "mismatch")
    with pytest.raises(ValueError, match="match"):
        sign(artifact, "0.2.0", "")


def test_active_upload_limit_and_rate_limit(update_cache):
    client, manifest, settings = update_cache
    for i in range(4):
        assert claim(client, manifest(str(i).encode()))[0]["status"] == "upload"
    assert client.post("/api/v1/desktop/uploads", json=manifest(b"fifth")).status_code == 503
    with sqlite3.connect(settings.desktop_release_dir / "cache.sqlite") as db:
        db.execute("UPDATE packages SET expires=0")
        db.execute("UPDATE attempts SET count=10")
    assert client.post("/api/v1/desktop/uploads", json=manifest(b"fifth")).status_code == 429
