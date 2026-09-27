#!/usr/bin/env bash
# /usr/local/bin/skutio-db-backup.sh — backup zilnic al bazei `skutio`, rulat de cron ca userul postgres.
# Format custom (-Fc): comprimat, restaurabil selectiv cu pg_restore. Păstrează ultimele 7 zile.
# Restaurare: pg_restore -d skutio --clean /var/backups/skutio-db/skutio-AAAA-LL-ZZ.dump
set -euo pipefail

DIR=/var/backups/skutio-db
KEEP_DAYS=7
FILE="$DIR/skutio-$(date +%F).dump"

mkdir -p "$DIR"
pg_dump -Fc skutio > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"          # fișierul final apare doar dacă dump-ul a reușit
find "$DIR" -name 'skutio-*.dump' -mtime +"$KEEP_DAYS" -delete

echo "backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
