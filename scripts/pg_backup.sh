#!/usr/bin/env bash
set -euo pipefail

# Daily full PostgreSQL backups using pg_dump.
#
# Expected env:
# - DATABASE_URL (preferred) e.g. postgresql://user:pass@host:5432/db?sslmode=require
#
# Optional env:
# - ENV_FILE: path to env file to source (default: .env if present)
# - BACKUP_DIR: output directory (default: backups/postgres)
# - BACKUP_RETENTION_DAYS: delete local backups older than N days (default: 30)
# - BACKUP_S3_URI: optional s3://bucket/prefix destination; when set, AWS CLI is required
# - BACKUP_S3_KMS_KEY_ID: KMS key ARN/ID used for SSE-KMS (required with BACKUP_S3_URI)
# - BACKUP_S3_RETENTION_DAYS: Object Lock retention (default: BACKUP_RETENTION_DAYS)
# - BACKUP_S3_OBJECT_LOCK_MODE: COMPLIANCE or GOVERNANCE (default: COMPLIANCE)
# - DRY_RUN: validate and print actions without connecting to PostgreSQL or S3

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
if [[ -z "${DATABASE_URL:-}" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DRY_RUN="${DRY_RUN:-0}"
if [[ "$DRY_RUN" != "1" && -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set (and could not be loaded from ENV_FILE)." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups/postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_S3_RETENTION_DAYS="${BACKUP_S3_RETENTION_DAYS:-$BACKUP_RETENTION_DAYS}"
BACKUP_S3_OBJECT_LOCK_MODE="${BACKUP_S3_OBJECT_LOCK_MODE:-COMPLIANCE}"

if [[ ! "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: BACKUP_RETENTION_DAYS must be a non-negative integer." >&2
  exit 1
fi
if [[ ! "$BACKUP_S3_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: BACKUP_S3_RETENTION_DAYS must be a positive integer." >&2
  exit 1
fi
if [[ -n "${BACKUP_S3_URI:-}" && -z "${BACKUP_S3_KMS_KEY_ID:-}" ]]; then
  echo "ERROR: BACKUP_S3_KMS_KEY_ID is required when BACKUP_S3_URI is set." >&2
  exit 1
fi
if [[ -n "${BACKUP_S3_URI:-}" && ! "$BACKUP_S3_URI" =~ ^s3://[^/]+(/.*)?$ ]]; then
  echo "ERROR: BACKUP_S3_URI must be an s3://bucket[/prefix] URI." >&2
  exit 1
fi
if [[ "$BACKUP_S3_OBJECT_LOCK_MODE" != "COMPLIANCE" && "$BACKUP_S3_OBJECT_LOCK_MODE" != "GOVERNANCE" ]]; then
  echo "ERROR: BACKUP_S3_OBJECT_LOCK_MODE must be COMPLIANCE or GOVERNANCE." >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: would create a full custom-format pg_dump in $BACKUP_DIR."
  if [[ -n "${BACKUP_S3_URI:-}" ]]; then
    echo "Dry run: would upload with SSE-KMS and $BACKUP_S3_OBJECT_LOCK_MODE Object Lock for $BACKUP_S3_RETENTION_DAYS days to $BACKUP_S3_URI."
  else
    echo "Dry run: S3 upload is disabled (BACKUP_S3_URI is not set)."
  fi
  exit 0
fi

command -v pg_dump >/dev/null || { echo "ERROR: pg_dump is required." >&2; exit 1; }
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  command -v aws >/dev/null || { echo "ERROR: aws CLI is required for S3 uploads." >&2; exit 1; }
fi

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
outfile="$BACKUP_DIR/pgdump_${timestamp}.dump"

tmpfile="${outfile}.tmp"
trap 'rm -f "$tmpfile"' EXIT

pg_dump \
  --no-owner \
  --no-acl \
  --blobs \
  --format=custom \
  --file="$tmpfile" \
  "$DATABASE_URL"

mv "$tmpfile" "$outfile"
trap - EXIT

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  object_key="${BACKUP_S3_URI%/}/$(basename "$outfile")"
  retain_until="$(date -u -d "+${BACKUP_S3_RETENTION_DAYS} days" +"%Y-%m-%dT%H:%M:%SZ")"
  aws s3 cp "$outfile" "$object_key" \
    --region "${AWS_REGION:?AWS_REGION is required for S3 uploads}" \
    --sse aws:kms \
    --sse-kms-key-id "$BACKUP_S3_KMS_KEY_ID" \
    --checksum-algorithm SHA256 \
    --object-lock-mode "$BACKUP_S3_OBJECT_LOCK_MODE" \
    --object-lock-retain-until-date "$retain_until"
  echo "Backup uploaded: $object_key (retained until $retain_until)"
fi

# Prune old backups (best-effort; don't fail the backup if prune fails)
if [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  find "$BACKUP_DIR" -type f -name "pgdump_*.dump" -mtime +"$BACKUP_RETENTION_DAYS" -delete || true
fi

echo "Backup written: $outfile"
