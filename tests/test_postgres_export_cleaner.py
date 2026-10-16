from datetime import datetime, timedelta, timezone

from app.services.postgres_export_cleaner import _is_expired


def test_export_table_expiry_uses_24_hour_boundary():
    now = datetime(2026, 10, 16, 12, tzinfo=timezone.utc)

    assert _is_expired(now - timedelta(hours=24, seconds=1), now, 24)
    assert not _is_expired(now - timedelta(hours=24), now, 24)
    assert not _is_expired(None, now, 24)


def test_naive_database_timestamp_is_treated_as_utc():
    now = datetime(2026, 10, 16, 12, tzinfo=timezone.utc)
    created_at = (now - timedelta(hours=25)).replace(tzinfo=None)

    assert _is_expired(created_at, now, 24)