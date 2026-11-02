"""Configure GitHub update signing from a Windows DPAPI-encrypted local backup.

Requires Python cryptography, PowerShell 7 and authenticated gh with repository access.
Never prints the private seed or places it in command-line arguments or the repository.
"""

import argparse
import base64
import json
import os
import subprocess
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)


def execute(args: list[str], value: str | None = None) -> str:
    result = subprocess.run(args, input=value, text=True, capture_output=True, check=False)
    if result.returncode:
        # Avoid accidentally echoing secret-bearing stdin in a tool's diagnostic.
        raise RuntimeError(
            f"{args[0]} failed (exit {result.returncode}); configuration incomplete"
        )
    return result.stdout.strip()


def configure(repo: str, server: str) -> None:
    if os.name != "nt":
        raise RuntimeError(
            "This backup workflow requires Windows DPAPI and PowerShell 7"
        )
    backup = (
        Path(os.environ["LOCALAPPDATA"]) / "AAW/release-signing/desktop-ed25519.dpapi"
    )

    def gh(*args: str, value: str | None = None) -> str:
        return execute(["gh", *args, "-R", repo], value)

    secrets = json.loads(gh("secret", "list", "--json", "name"))
    variables = json.loads(gh("variable", "list", "--json", "name,value"))
    existing = next(
        (v["value"] for v in variables if v["name"] == "AAW_DESKTOP_UPDATE_PUBLIC_KEY"),
        None,
    )
    if backup.exists():
        seed = execute(
            [
                "pwsh",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                ("$s=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); "
                "$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); "
                "try {[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))} "
                "finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}"),
            ],
            backup.read_text(),
        )
        key = Ed25519PrivateKey.from_private_bytes(
            base64.b64decode(seed, validate=True)
        )
    else:
        if existing or any(s["name"] == "AAW_DESKTOP_SIGNING_KEY" for s in secrets):
            raise RuntimeError(
                "Existing signing configuration found; restore its backup, do not rotate"
            )
        key = Ed25519PrivateKey.generate()
        seed = base64.b64encode(
            key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
        ).decode()
        encrypted = execute(
            [
                "pwsh",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                ("$s=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()) -AsPlainText -Force; "
                "[Console]::Write((ConvertFrom-SecureString $s))"),
            ],
            seed,
        )
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_text(encrypted, encoding="ascii")
    public = base64.b64encode(
        key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode()
    if existing and existing.strip() != public:
        raise RuntimeError(
            "Backup does not match the published public key; refusing rotation"
        )
    gh("secret", "set", "AAW_DESKTOP_SIGNING_KEY", value=seed)
    gh("variable", "set", "AAW_DESKTOP_UPDATE_PUBLIC_KEY", value=public)
    gh("variable", "set", "AAW_DESKTOP_UPDATE_SERVER", value=server)
    (Path(__file__).resolve().parents[1] / "update-public-key.txt").write_text(
        public + "\n", encoding="ascii"
    )
    print(f"GitHub configured. Encrypted backup: {backup}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="pi-ixel/Awesome-Agent-Workflow")
    parser.add_argument("--server", default="http://39.108.107.148:18081")
    args = parser.parse_args()
    configure(args.repo, args.server)
