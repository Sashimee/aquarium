#!/bin/sh
set -eu

# /app/web/assets is a persistent volume on Dokploy, so earlier builds' hashed chunks stay servable
# for open tabs. Every start copies this build in (fresh mtime) and prunes what no build has
# refreshed within ASSET_RETENTION_DAYS. Without a volume the copy is a harmless no-op.
assets=/app/web/assets
retention_days="${ASSET_RETENTION_DAYS:-7}"

cp -Rf /app/assets-current/. "$assets/"
find "$assets" -type f -mtime "+$retention_days" -delete
find "$assets" -mindepth 1 -type d -empty -delete

exec "$@"
