#!/usr/bin/env bash
set -euo pipefail

# Nightly PostgreSQL backups using pg_dump.
#
# Expected env:
# - DATABASE_URL (preferred) e.g. postgresql://user:pass@host:5432/db?sslmode=require
#
# Optional env:
# - ENV_FILE: path to env file to source (default: .env if present)
# - BACKUP_DIR: output directory (default: backups/postgres)
# - BACKUP_RETENTION_DAYS: delete backups older than N days (default: 30)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
if [[ -z "${DATABASE_URL:-}" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set (and could not be loaded from ENV_FILE)." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups/postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
outfile="$BACKUP_DIR/pgdump_${timestamp}.dump"

tmpfile="${outfile}.tmp"
trap 'rm -f "$tmpfile"' EXIT

pg_dump \
  --no-owner \
  --no-acl \
  --format=custom \
  --file="$tmpfile" \
  "$DATABASE_URL"

mv "$tmpfile" "$outfile"
trap - EXIT

# Prune old backups (best-effort; don't fail the backup if prune fails)
if [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  find "$BACKUP_DIR" -type f -name "pgdump_*.dump" -mtime +"$BACKUP_RETENTION_DAYS" -delete || true
fi

echo "Backup written: $outfile"
