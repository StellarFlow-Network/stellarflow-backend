# PR: Asynchronous S3 Media & PDF Export Cleaner Worker

**Closes #979**

---

## Summary

Implements a daily Celery beat worker that automatically purges temporary CSV export files and PDF payment receipts from the `stellarflow-temp-exports` S3 bucket. Objects older than 24 hours are deleted in bulk; each run emits structured logs reporting the total number of objects deleted and total storage space reclaimed (bytes and MB).

---

## Problem

User-generated CSV exports (`user_activity_export.py`) and PDF payment receipts (`receipt_service.py`) are written to object storage but never cleaned up. Over time this accumulates unbounded storage cost from temporary files that are no longer needed after their presigned download URLs expire.

---

## Solution — File-by-File Walkthrough

### 1. `app/services/s3_export_cleaner.py` *(new)*

Core cleanup service. Uses the existing **sync `boto3`** client (matching every other S3 call in the codebase) to:

1. Paginate through all objects in the configured bucket using `list_objects_v2` + `ContinuationToken` — handles buckets with > 1,000 objects correctly.
2. Collect any object whose `LastModified` timestamp is older than the configured TTL (default 24 h).
3. Delete stale objects in batches of up to 1,000 via `delete_objects` (S3 hard limit).
4. Return a structured summary dict (`objects_scanned`, `objects_deleted`, `bytes_reclaimed`, `mb_reclaimed`, `errors`, timestamps, `duration_ms`).

Key design choices:
- **Dry-run mode** (`S3_CLEANER_DRY_RUN=true`) lets operators validate behaviour before enabling real deletes.
- **Injectable `s3_client`** parameter enables unit-test mocking without patching.
- Structured `structlog` log lines at each phase: `started`, `scan_complete`, `batch_deleted`, `completed` — matches the project-wide logging convention.

### 2. `app/tasks.py` *(modified)*

Added `purge_s3_temp_exports` Celery task following the exact pattern of all existing tasks:

```python
@celery_app.task(
    bind=True,
    base=DatabaseTask,
    name="app.tasks.purge_s3_temp_exports",
    autoretry_for=(OSError,),
    retry_backoff=True,
    max_retries=3,
)
def purge_s3_temp_exports(self: DatabaseTask, dry_run: bool = False) -> dict:
    from app.services.s3_export_cleaner import run_s3_export_cleanup
    return run_s3_export_cleanup(dry_run=dry_run)
```

- `autoretry_for=(OSError,)` — retries on transient network/S3 errors (not `asyncpg.PostgresError` since this task is DB-free).
- Lazy import of the service inside the task body (same pattern as `stake_treasury_idle_balances`).

### 3. `app/celery_app.py` *(modified)*

Registered the daily beat schedule entry:

```python
"purge-s3-temp-exports": {
    "task": "app.tasks.purge_s3_temp_exports",
    "schedule": crontab(minute="0", hour="2"),   # 02:00 UTC daily
},
```

Runs at 02:00 UTC every day — chosen to avoid overlap with peak-hour analytics tasks.

### 4. `alembic/versions/0009_add_s3_cleanup_run_log.py` *(new)*

Migration that creates `s3_cleanup_run_log` — an append-only audit table so operators can query historical cleanup runs (objects deleted, bytes reclaimed, errors, duration) without relying on log aggregation alone.

Columns: `id` (SHA-256 dedup key), `bucket`, `prefix`, `ttl_hours`, `dry_run`, `objects_scanned`, `objects_deleted`, `bytes_reclaimed`, `error_count`, `duration_ms`, `started_at`, `completed_at`, `created_at`.

Indexes on `started_at`, `(bucket, started_at)`, and `created_at` for efficient time-range queries.

### 5. `app/routers/s3_cleaner.py` *(new)*

Two FastAPI endpoints under `/api/v1/storage`:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/cleanup/trigger` | Enqueue a cleanup run immediately (supports `?dry_run=true`) |
| `GET` | `/cleanup/status` | List recent cleanup run log entries with pagination |

Follows the same router pattern as `app/routers/revenue.py` (structlog, asyncpg pool, Pydantic response models, `.delay()` dispatch).

### 6. `app/main.py` *(modified)*

Registered the new router with a soft-import guard (same pattern used by all existing routers):

```python
try:
    from app.routers import s3_cleaner as s3_cleaner_router
    _HAS_S3_CLEANER_ROUTER = True
except ImportError:
    _HAS_S3_CLEANER_ROUTER = False
...
if _HAS_S3_CLEANER_ROUTER:
    app.include_router(s3_cleaner_router.router, prefix="/api/v1")
```

### 7. `.env.example` *(modified)*

Added documentation and default values for the four new environment variables:

```
S3_TEMP_EXPORTS_BUCKET=stellarflow-temp-exports
S3_TEMP_EXPORTS_PREFIX=
S3_TEMP_EXPORTS_TTL_HOURS=24
S3_CLEANER_DRY_RUN=false
```

---

## Acceptance Criteria Verification

| Criterion | Implementation |
|-----------|---------------|
| ✅ Daily worker scanning S3 bucket `stellarflow-temp-exports` | `crontab(minute="0", hour="2")` beat entry → `purge_s3_temp_exports` task → `run_s3_export_cleanup()` paginated `list_objects_v2` |
| ✅ Purge objects with creation timestamps older than 24 hours | `cutoff = datetime.now(UTC) - timedelta(hours=ttl_hours)` compared against `obj["LastModified"]` |
| ✅ Log total storage space reclaimed on each cleanup run | `s3_export_cleaner.completed` structlog event emits `bytes_reclaimed`, `mb_reclaimed`, `objects_deleted`, `duration_ms` |

---

## No Breaking Changes

- No existing task names were modified.
- No existing tables were altered.
- No existing service files were changed.
- The new router is registered with the same soft-import guard all other routers use — if the file is absent the app still boots.
- `boto3` was already a pinned dependency (`>=1.34.0`); no new packages added.

---

## How to Apply

```bash
# Run the migration
alembic upgrade 0009_add_s3_cleanup_run_log

# Add to .env
S3_TEMP_EXPORTS_BUCKET=stellarflow-temp-exports
S3_TEMP_EXPORTS_TTL_HOURS=24
S3_CLEANER_DRY_RUN=false        # set true first run to validate

# Restart Celery beat — new schedule is picked up automatically
celery -A app.celery_app beat --loglevel=info
```
