#!/usr/bin/env bash
set -euo pipefail

cd /opt/aaw-telemetry
test -f config/database.yaml

id -u aaw-telemetry >/dev/null 2>&1 || useradd --system --home-dir /opt/aaw-telemetry --shell /sbin/nologin aaw-telemetry

python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install .

umask 077
printf '%s\n' \
  "AAW_TELEMETRY_DATABASE_CONFIG_FILE=/opt/aaw-telemetry/config/database.yaml" \
  "AAW_TELEMETRY_PROJECTS_FILE=/opt/aaw-telemetry/config/projects.yaml" \
  "AAW_TELEMETRY_OBJECT_STORAGE_DIR=/var/lib/aaw-telemetry/objects" \
  "AAW_TELEMETRY_LOGGING_CONFIG_FILE=/opt/aaw-telemetry/config/logging.yaml" \
  "AAW_TELEMETRY_LOG_DIRECTORY=/var/log/aaw-telemetry" \
  "AAW_TELEMETRY_LOG_LEVEL=INFO" \
  "AAW_TELEMETRY_MAX_PATCH_BYTES=10485760" \
  "AAW_TELEMETRY_UPLOAD_SESSION_SECONDS=3600" \
  > /etc/aaw-telemetry.env
chmod 600 /etc/aaw-telemetry.env
chown root:aaw-telemetry config/database.yaml
chmod 600 config/database.yaml
chown root:aaw-telemetry config/logging.yaml
chmod 640 config/logging.yaml

set -a
source /etc/aaw-telemetry.env
set +a
.venv/bin/alembic upgrade head

install -m 644 deploy/aaw-telemetry.service /etc/systemd/system/aaw-telemetry.service
chmod -R go-w /opt/aaw-telemetry
chown -R root:aaw-telemetry /opt/aaw-telemetry
chmod 750 /opt/aaw-telemetry

systemctl daemon-reload
systemctl enable --now aaw-telemetry
