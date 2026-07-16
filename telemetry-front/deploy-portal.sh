#!/usr/bin/env bash
set -euo pipefail

release=/tmp/aaw-telemetry-portal-release.tar.gz
nginx_source=/tmp/aaw-telemetry-nginx.conf
portal=/opt/aaw-telemetry-portal
stage=/opt/aaw-telemetry-portal.stage
nginx_conf=/www/server/panel/vhost/nginx/aaw-telemetry.conf
stamp=$(date -u +%Y%m%dT%H%M%SZ)
portal_backup="${portal}.backup-${stamp}"
nginx_backup="${nginx_conf}.backup-${stamp}"

test -f "$release"
test -f "$nginx_source"
test -f "$nginx_conf"
test "$stage" = /opt/aaw-telemetry-portal.stage

rm -rf -- "$stage"
install -d -m 0755 "$stage"
tar -xzf "$release" -C "$stage"
test -f "$stage/bright.html"
test -f "$stage/config.js"
test -f "$stage/bright.js"

if test -d "$portal"; then
    mv "$portal" "$portal_backup"
fi
mv "$stage" "$portal"
chown -R root:root "$portal"
find "$portal" -type d -exec chmod 0755 {} +
find "$portal" -type f -exec chmod 0644 {} +

cp -p "$nginx_conf" "$nginx_backup"
install -o root -g root -m 0644 "$nginx_source" "$nginx_conf"
if ! nginx -t; then
    install -o root -g root -m 0644 "$nginx_backup" "$nginx_conf"
    nginx -t
    exit 1
fi

nginx -s reload
curl -fsS http://127.0.0.1:18081/portal/ >/dev/null
curl -fsS http://127.0.0.1:18081/api/v1/dashboard/overview >/dev/null

echo "portal_backup=$portal_backup"
echo "nginx_backup=$nginx_backup"
