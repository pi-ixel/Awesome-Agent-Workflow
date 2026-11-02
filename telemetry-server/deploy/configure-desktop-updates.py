"""Configure an existing systemd/nginx telemetry host; never accepts private keys.

Run with Python 3.11+ as root. This does not deploy code or restart telemetry.
"""

import argparse
import base64
import subprocess
from datetime import UTC, datetime
from pathlib import Path


def run(*args: str) -> None:
    subprocess.run(args, check=True, capture_output=True, text=True)


def configure(public_key: str, nginx_config: Path) -> None:
    if len(base64.b64decode(public_key, validate=True)) != 32:
        raise ValueError("Expected a base64 Ed25519 public key")
    original = nginx_config.read_text()
    anchor = "    location / {"
    marker = "location /api/v1/desktop/uploads/"
    if marker not in original and anchor not in original:
        raise ValueError("Unknown nginx layout; configure the Desktop upload location manually")
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    folder = Path("/etc/systemd/system/aaw-telemetry.service.d")
    folder.mkdir(exist_ok=True)
    target = folder / "desktop-updates.conf"
    if target.exists():
        target.with_suffix(f".conf.backup-{stamp}").write_bytes(target.read_bytes())
    target.write_text(
        "[Service]\n"
        f"Environment=AAW_TELEMETRY_DESKTOP_UPDATE_PUBLIC_KEY={public_key}\n"
        "Environment=AAW_TELEMETRY_DESKTOP_RELEASE_DIR=/var/lib/aaw-telemetry/desktop-releases\n"
        "Environment=AAW_TELEMETRY_DESKTOP_UPDATE_MAX_BYTES=536870912\n"
        "Environment=AAW_TELEMETRY_DESKTOP_UPDATE_QUOTA_BYTES=2147483648\n"
        "Environment=AAW_TELEMETRY_DESKTOP_UPDATE_LEASE_SECONDS=900\n"
    )
    run(
        "install",
        "-d",
        "-o",
        "aaw-telemetry",
        "-g",
        "aaw-telemetry",
        "-m",
        "0750",
        "/var/lib/aaw-telemetry/desktop-releases",
    )
    if marker not in original:
        block = """    # Desktop signed package uploads; ordinary routes keep their limits.
    location /api/v1/desktop/uploads/ {
        client_max_body_size 512m;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 660s;
        proxy_send_timeout 660s;
    }

"""
        nginx_config.with_suffix(f".conf.backup-{stamp}").write_text(original)
        nginx_config.write_text(original.replace(anchor, block + anchor, 1))
        try:
            run("nginx", "-t")
            run("nginx", "-s", "reload")
        except subprocess.CalledProcessError:
            nginx_config.write_text(original)
            raise
    else:
        run("nginx", "-t")
    run("systemctl", "daemon-reload")
    print(
        "Public key and cache configured; nginx validated. Restart telemetry after deploying code."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-key", required=True)
    parser.add_argument("--nginx-config", type=Path, required=True)
    options = parser.parse_args()
    configure(options.public_key.strip(), options.nginx_config)
