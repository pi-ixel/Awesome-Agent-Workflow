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
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def sign(artifact: Path, version: str, notes: str) -> dict:
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
    parser.add_argument("--notes-file", type=Path)
    args = parser.parse_args()
    artifact = args.directory / f"AAW-Desktop-{args.version}-windows-x64-setup.exe"
    notes = (
        args.notes_file.read_text(encoding="utf-8")
        if args.notes_file
        else f"AAW Desktop {args.version}"
    )
    result = sign(artifact, args.version, notes)
    (args.directory / "desktop-update.json").write_text(
        json.dumps(result), encoding="utf-8"
    )
