"""Restore the exact pinned Tauri sources used by the WebView2 benchmark."""
import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen

import apply_tauri_webview2_profile as patch

PACKAGES = {
    "tauri": ("2.12.4", "f316751027fc2644221d1a448564d519efb07067fda584879d9cda966391d212"),
    "tauri-runtime": ("2.12.2", "7c55766d99cea69055904d1735b93c2049302b2e09effd462120deb5581d78e9"),
    "tauri-runtime-wry": ("2.12.2", "8d61892587aea2a85245bcaec98c6fe46268874c0a0deae5535fb71ca7b93eae"),
}

if __name__ == "__main__":
    import subprocess
    import sys

    vendor = Path(__file__).resolve().parents[1] / "src-tauri" / "vendor-webview2-poc"
    vendor.mkdir(exist_ok=True)
    args = [sys.executable, patch.__file__]
    for option, (name, (version, checksum)) in zip(
        ("--tauri", "--runtime", "--runtime-wry"), PACKAGES.items(), strict=True
    ):
        stem = f"{name}-{version}"
        with urlopen(f"https://static.crates.io/crates/{name}/{stem}.crate", timeout=45) as response:
            payload = response.read()
        if hashlib.sha256(payload).hexdigest() != checksum:
            raise RuntimeError(f"Checksum mismatch: {stem}")
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
            archive.extractall(vendor, filter="data")
        args.extend([option, str(vendor / stem)])
    subprocess.run(args, check=True)
