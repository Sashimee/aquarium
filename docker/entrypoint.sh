#!/bin/sh
set -eu

# On Dokploy /app/web/assets is a persistent volume, so earlier builds' hashed chunks stay servable
# for open tabs. Files are never rewritten in place: the previous container may still be serving
# them, so changed files are copied to a temp name and renamed into place.
assets=/app/web/assets
current=/app/assets-current
retention_days="${ASSET_RETENTION_DAYS:-7}"

case "$retention_days" in
  ''|*[!0-9]*)
    echo "ASSET_RETENTION_DAYS must be a whole number of days, got '$retention_days'" >&2
    exit 1
    ;;
esac
retention_days="$(printf '%s' "$retention_days" | sed 's/^0*\(.\)/\1/')"
if [ "$retention_days" -lt 1 ]; then
  echo "ASSET_RETENTION_DAYS must be at least 1, got '$ASSET_RETENTION_DAYS' (0 would delete the build just copied in)" >&2
  exit 1
fi

if mountpoint -q "$assets"; then
  find "$current" -type f | while IFS= read -r src; do
    rel="${src#"$current"/}"
    dest="$assets/$rel"
    mkdir -p "$(dirname "$dest")"
    if cmp -s "$src" "$dest" 2>/dev/null; then
      touch "$dest"
    else
      tmp="$(mktemp "$(dirname "$dest")/.tmp.XXXXXX")"
      cp "$src" "$tmp"
      chmod 644 "$tmp"
      mv -f "$tmp" "$dest"
    fi
    case "$rel" in
      *.br|*.gz) ;;
      *)
        for ext in br gz; do
          [ -e "$src.$ext" ] || rm -f "$dest.$ext"
        done
        ;;
    esac
  done
  find "$assets" -type f -mmin "+$((retention_days * 1440))" -delete
  find "$assets" -mindepth 1 -type d -empty -delete
fi

exec "$@"
