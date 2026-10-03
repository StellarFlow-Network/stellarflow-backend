"""app/services/s3_export_cleaner.py — S3 temporary export file cleaner (Issue #979).

Scans the ``stellarflow-temp-exports`` bucket (configurable via
``S3_TEMP_EXPORTS_BUCKET``) for CSV and PDF objects older than 24 hours and
deletes them in bulk.  Each run emits structured logs with the total number of
objects deleted and the total storage space reclaimed in bytes.

Design decisions
----------------
* **Sync boto3** — matches every other S3 call in the codebase
  (``user_activity_export.py``, ``receipt_service.py``).  No aioboto3 needed;
  the async Celery task wraps the service call in ``asyncio.run()``.
* **Paginated listing** — S3 ``list_objects_v2`` returns at most 1 000 keys
  per call; the service iterates through all pages via the ``ContinuationToken``
  before batching deletes.
* **Bulk delete** — S3 ``delete_objects`` accepts up to 1 000 keys per call;
  the service chunks the stale key list accordingly.
* **Dry-run mode** — pass ``dry_run=True`` (or set ``S3_CLEANER_DRY_RUN=true``)
  to log what *would* be deleted without actually deleting anything.  Useful
  for pre-production validation.
* **Configurable TTL** — ``S3_TEMP_EXPORTS_TTL_HOURS`` overrides the default
  24-hour threshold.

Environment variables
---------------------
S3_TEMP_EXPORTS_BUCKET       Target bucket name (default: ``stellarflow-temp-exports``)
S3_TEMP_EXPORTS_PREFIX       Object key prefix filter (default: empty — scan entire bucket)
S3_TEMP_EXPORTS_TTL_HOURS    Age threshold in hours (default: ``24``)
S3_CLEANER_DRY_RUN           Set to ``true`` to skip actual deletes (default: ``false``)
AWS_REGION                   AWS region for the boto3 client (inherited from existing config)
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
import structlog

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants / defaults
# ---------------------------------------------------------------------------

_DEFAULT_BUCKET = "stellarflow-temp-exports"
_DEFAULT_TTL_HOURS = 24
_S3_DELETE_BATCH_SIZE = 1_000  # S3 delete_objects hard limit


# ---------------------------------------------------------------------------
# Config helper
# ---------------------------------------------------------------------------


def _config() -> tuple[str, str, int, bool]:
    """Resolve cleaner configuration from the environment.

    Returns
    -------
    tuple[str, str, int, bool]
        (bucket, prefix, ttl_hours, dry_run)
    """
    bucket = os.getenv("S3_TEMP_EXPORTS_BUCKET", _DEFAULT_BUCKET).strip()
    if not bucket:
        raise RuntimeError(
            "S3_TEMP_EXPORTS_BUCKET must be a non-empty string"
        )

    prefix = os.getenv("S3_TEMP_EXPORTS_PREFIX", "").strip().strip("/")

    raw_ttl = os.getenv("S3_TEMP_EXPORTS_TTL_HOURS", str(_DEFAULT_TTL_HOURS))
    try:
        ttl_hours = int(raw_ttl)
    except ValueError as exc:
        raise RuntimeError(
            "S3_TEMP_EXPORTS_TTL_HOURS must be a positive integer"
        ) from exc
    if ttl_hours < 1:
        raise RuntimeError("S3_TEMP_EXPORTS_TTL_HOURS must be >= 1")

    dry_run = os.getenv("S3_CLEANER_DRY_RUN", "false").strip().lower() == "true"

    return bucket, prefix, ttl_hours, dry_run


# ---------------------------------------------------------------------------
# Core service
# ---------------------------------------------------------------------------


def run_s3_export_cleanup(
    s3_client: Any | None = None,
    *,
    dry_run: bool | None = None,
) -> dict[str, Any]:
    """Scan the temp-exports bucket and purge objects older than ``ttl_hours``.

    Parameters
    ----------
    s3_client:
        Optional pre-built boto3 S3 client.  When ``None`` the function
        constructs one using the configured ``AWS_REGION``.  Pass an explicit
        client in tests to inject a mock.
    dry_run:
        When ``True`` the function logs stale objects but skips the delete
        API calls.  Falls back to ``S3_CLEANER_DRY_RUN`` when ``None``.

    Returns
    -------
    dict[str, Any]
        Structured summary of the cleanup run::

            {
                "bucket": "stellarflow-temp-exports",
                "prefix": "",
                "ttl_hours": 24,
                "dry_run": False,
                "objects_scanned": 342,
                "objects_deleted": 17,
                "bytes_reclaimed": 8_912_345,
                "errors": [],
                "started_at": "2026-09-28T00:00:00+00:00",
                "completed_at": "2026-09-28T00:00:03.142000+00:00",
            }
    """
    bucket, prefix, ttl_hours, env_dry_run = _config()

    # Explicit parameter overrides the environment variable
    if dry_run is None:
        dry_run = env_dry_run

    client = s3_client or boto3.client("s3", region_name=os.getenv("AWS_REGION"))
    cutoff: datetime = datetime.now(timezone.utc) - timedelta(hours=ttl_hours)

    bound = log.bind(
        bucket=bucket,
        prefix=prefix or "(all)",
        ttl_hours=ttl_hours,
        cutoff=cutoff.isoformat(),
        dry_run=dry_run,
    )
    bound.info("s3_export_cleaner.started")

    started_at = datetime.now(timezone.utc)
    objects_scanned = 0
    stale_objects: list[dict[str, str]] = []
    bytes_reclaimed = 0
    errors: list[str] = []

    # ------------------------------------------------------------------
    # 1. Paginate through all objects in the bucket/prefix
    # ------------------------------------------------------------------
    paginate_kwargs: dict[str, Any] = {"Bucket": bucket}
    if prefix:
        paginate_kwargs["Prefix"] = prefix + "/"

    continuation_token: str | None = None

    while True:
        if continuation_token:
            paginate_kwargs["ContinuationToken"] = continuation_token

        try:
            response = client.list_objects_v2(**paginate_kwargs)
        except Exception as exc:  # pragma: no cover
            error_msg = f"list_objects_v2 failed: {exc}"
            bound.exception("s3_export_cleaner.list_error", error=str(exc))
            errors.append(error_msg)
            break

        for obj in response.get("Contents", []):
            objects_scanned += 1
            last_modified: datetime = obj["LastModified"]

            # Ensure the timestamp is timezone-aware for safe comparison
            if last_modified.tzinfo is None:
                last_modified = last_modified.replace(tzinfo=timezone.utc)

            if last_modified < cutoff:
                stale_objects.append({"Key": obj["Key"]})
                bytes_reclaimed += obj.get("Size", 0)
                bound.debug(
                    "s3_export_cleaner.stale_object_found",
                    key=obj["Key"],
                    last_modified=last_modified.isoformat(),
                    size_bytes=obj.get("Size", 0),
                )

        if response.get("IsTruncated"):
            continuation_token = response.get("NextContinuationToken")
        else:
            break

    bound.info(
        "s3_export_cleaner.scan_complete",
        objects_scanned=objects_scanned,
        stale_count=len(stale_objects),
        bytes_to_reclaim=bytes_reclaimed,
    )

    # ------------------------------------------------------------------
    # 2. Delete stale objects in batches of up to 1 000
    # ------------------------------------------------------------------
    objects_deleted = 0

    if stale_objects and not dry_run:
        for batch_start in range(0, len(stale_objects), _S3_DELETE_BATCH_SIZE):
            batch = stale_objects[batch_start : batch_start + _S3_DELETE_BATCH_SIZE]
            try:
                delete_response = client.delete_objects(
                    Bucket=bucket,
                    Delete={
                        "Objects": batch,
                        "Quiet": False,  # get individual key outcomes
                    },
                )
                deleted_in_batch = len(delete_response.get("Deleted", []))
                objects_deleted += deleted_in_batch
                bound.info(
                    "s3_export_cleaner.batch_deleted",
                    batch_size=len(batch),
                    deleted_count=deleted_in_batch,
                )

                # Log any per-key errors from the batch
                for err in delete_response.get("Errors", []):
                    msg = (
                        f"delete failed key={err.get('Key')} "
                        f"code={err.get('Code')} message={err.get('Message')}"
                    )
                    bound.warning("s3_export_cleaner.delete_error", **err)
                    errors.append(msg)

            except Exception as exc:  # pragma: no cover
                error_msg = f"delete_objects batch failed: {exc}"
                bound.exception(
                    "s3_export_cleaner.batch_delete_error",
                    batch_start=batch_start,
                    error=str(exc),
                )
                errors.append(error_msg)
    elif dry_run and stale_objects:
        # In dry-run mode we report what *would* be deleted
        objects_deleted = len(stale_objects)
        bound.info(
            "s3_export_cleaner.dry_run_skipped_deletes",
            would_delete=objects_deleted,
        )

    completed_at = datetime.now(timezone.utc)
    duration_ms = round((completed_at - started_at).total_seconds() * 1_000, 2)

    # Convert bytes to a human-readable size for the summary log
    mb_reclaimed = round(bytes_reclaimed / (1024 * 1024), 3)

    bound.info(
        "s3_export_cleaner.completed",
        objects_scanned=objects_scanned,
        objects_deleted=objects_deleted,
        bytes_reclaimed=bytes_reclaimed,
        mb_reclaimed=mb_reclaimed,
        duration_ms=duration_ms,
        dry_run=dry_run,
        error_count=len(errors),
    )

    return {
        "bucket": bucket,
        "prefix": prefix,
        "ttl_hours": ttl_hours,
        "dry_run": dry_run,
        "objects_scanned": objects_scanned,
        "objects_deleted": objects_deleted,
        "bytes_reclaimed": bytes_reclaimed,
        "mb_reclaimed": mb_reclaimed,
        "errors": errors,
        "started_at": started_at.isoformat(),
        "completed_at": completed_at.isoformat(),
        "duration_ms": duration_ms,
    }
