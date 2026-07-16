#!/usr/bin/env bash
set -euo pipefail

cd /opt/aaw-telemetry
umask 077

if [[ ! -f .env ]]; then
  mysql_password="$(openssl rand -hex 24)"
  mysql_root_password="$(openssl rand -hex 24)"
  printf '%s\n' \
    "MYSQL_PASSWORD=${mysql_password}" \
    "MYSQL_ROOT_PASSWORD=${mysql_root_password}" \
    > .env
  chmod 600 .env
fi

docker compose -f compose.remote.yaml up -d --build
