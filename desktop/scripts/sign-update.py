"""Sign the exact UTF-8 manifest bytes; never print or write the private key.

AAW_DESKTOP_SIGNING_KEY: base64 raw 32-byte Ed25519 seed (CI secret).
AAW_DESKTOP_UPDATE_PUBLIC_KEY: matching base64 public key (CI variable).
"""

import argparse
import base64
import hashlib
import json
import os
import re
from datetime import date
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def read_release_notes(path: Path, version: str) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    match = re.fullmatch(
        rf"# AAW Desktop {re.escape(version)}\n+发布日期：(?P<date>\d{{4}}-\d{{2}}-\d{{2}})\n+(?P<body>.+)",
        text, re.DOTALL,
    )
    if not match or not match["body"].strip():
        raise ValueError("Release notes must match the version and include a publication date and body")
    published_at = date.fromisoformat(match["date"]).isoformat()
    return match["body"].strip(), published_at


def sign(artifact: Path, version: str, notes: str, published_at: str | None = None) -> dict:
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("Only stable Desktop versions can be signed")
    if artifact.name != f"AAW-Desktop-{version}-windows-x64-setup.exe":
        raise ValueError("Installer filename does not match version")
    if not 0 < artifact.stat().st_size <= 512 * 1024 * 1024:
        raise ValueError("Installer size exceeds update limits")
    key = Ed25519PrivateKey.from_private_bytes(
        base64.b64decode(os.environ["AAW_DESKTOP_SIGNING_KEY"], validate=True)
    )
    public = base64.b64encode(
        key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode()
    if public != os.environ["AAW_DESKTOP_UPDATE_PUBLIC_KEY"]:
        raise ValueError(
            "Signing key does not match the public key embedded in Desktop"
        )
    payload = json.dumps(
        {
            "schema": 1,
            "version": version,
            "platform": "windows-x86_64",
            "kind": "nsis",
            "file_name": artifact.name,
            "size": artifact.stat().st_size,
            "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            "notes": notes,
            **({"published_at": date.fromisoformat(published_at).isoformat()} if published_at else {}),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()
    if len(base64.b64encode(payload)) > 64000:
        raise ValueError("Release notes exceed manifest size limit")
    return {
        "payload": base64.b64encode(payload).decode(),
        "signature": base64.b64encode(key.sign(payload)).decode(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--notes-file", type=Path, required=True)
    args = parser.parse_args()
    artifact = args.directory / f"AAW-Desktop-{args.version}-windows-x64-setup.exe"
    notes, published_at = read_release_notes(args.notes_file, args.version)
    result = sign(artifact, args.version, notes, published_at)
    (args.directory / "desktop-update.json").write_text(
        json.dumps(result), encoding="utf-8"
    )
