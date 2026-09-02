"""Tests for the PDF payment receipt generator worker (Issue #772)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.receipt_notifications import (
    receipt_notification_text,
)
from app.services.receipt_service import (
    DEFAULT_URL_TTL_SECONDS,
    REQUIRED_FIELDS,
    ReceiptValidationError,
    _receipt_key,
    _s3_config,
    render_receipt_html,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RECEIPT_DATA = {
    "transaction_id": "tx-123",
    "user_id": "user-1",
    "asset": "USDC",
    "amount": "250.00",
    "sender_currency": "USD",
    "receiver_currency": "NGN",
    "output_amount": "415000.00",
    "fee": "3.50",
    "rate": "1660",
    "status": "COMPLETED",
    "provider": "TestAnchor",
    "reference": "REF-9",
    "stellar_tx_hash": "abc123",
    "recipient_email": "recipient@example.com",
}


def _mock_s3_client() -> MagicMock:
    client = MagicMock()
    client.put_object.return_value = {}
    client.generate_presigned_url.return_value = "https://s3.test/receipt.pdf?sig=x"
    return client


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------


def test_render_receipt_html_contains_fields():
    html = render_receipt_html(dict(RECEIPT_DATA))
    assert "tx-123" in html
    assert "USDC" in html
    assert "415000" in html
    assert "recipient@example.com" in html
    assert "StellarFlow" in html


def test_render_receipt_html_does_not_mutate_input():
    source = dict(RECEIPT_DATA)
    render_receipt_html(source)
    assert "brand_name" not in source
    assert source["transaction_id"] == "tx-123"


def test_render_receipt_html_defaults_for_empty():
    html = render_receipt_html({"transaction_id": "", "user_id": ""})
    assert html


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_generate_receipt_requires_transaction_id():
    from app.services.receipt_service import generate_payment_receipt

    with pytest.raises(ReceiptValidationError) as exc:
        generate_payment_receipt({"user_id": "u1"}, s3_client=_mock_s3_client())
    assert "transaction_id" in str(exc.value)


def test_required_fields_constant():
    assert REQUIRED_FIELDS == ("transaction_id", "user_id")


# ---------------------------------------------------------------------------
# S3 upload / full pipeline
# ---------------------------------------------------------------------------


def test_generate_payment_receipt_uploads_and_returns_link(monkeypatch):
    from app.services.receipt_service import generate_payment_receipt

    monkeypatch.setenv("RECEIPT_STORAGE_BUCKET", "test-bucket")
    monkeypatch.setenv("RECEIPT_NOTIFICATION_CHANNELS", "webhook")
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)

    with patch(
        "app.services.receipt_service.notify_receipt_ready"
    ) as mock_notify, patch(
        "app.services.receipt_service.render_receipt_pdf",
        return_value=b"%PDF-1.4 fake pdf",
    ):
        mock_notify.return_value = []
        result = generate_payment_receipt(
            dict(RECEIPT_DATA), s3_client=_mock_s3_client()
        )

    assert result["status"] == "READY"
    assert result["transaction_id"] == "tx-123"
    assert result["download_url"].startswith("https://s3.test/")
    assert result["key"].startswith("receipts/user-1/tx-123/")
    assert result["key"].endswith(".pdf")
    mock_notify.assert_called_once()


def test_receipt_key_is_sanitised():
    key = _receipt_key(
        {"transaction_id": "tx/123: ", "user_id": "user x", "receipt_id": "rid"}
    )
    assert "/" not in key.split("/", 2)[2]
    assert key.startswith("user_x/tx_123_/")


def test_s3_config_defaults(monkeypatch):
    monkeypatch.setenv("RECEIPT_STORAGE_BUCKET", "b")
    monkeypatch.delenv("RECEIPT_STORAGE_PREFIX", raising=False)
    monkeypatch.delenv("RECEIPT_DOWNLOAD_URL_TTL_SECONDS", raising=False)
    bucket, prefix, expiry = _s3_config()
    assert bucket == "b"
    assert prefix == "receipts"
    assert expiry == DEFAULT_URL_TTL_SECONDS


def test_s3_config_requires_bucket(monkeypatch):
    monkeypatch.delenv("RECEIPT_STORAGE_BUCKET", raising=False)
    monkeypatch.delenv("S3_BUCKET", raising=False)
    with pytest.raises(RuntimeError):
        _s3_config()


# ---------------------------------------------------------------------------
# Notification handlers
# ---------------------------------------------------------------------------


def test_receipt_notification_text_includes_tx():
    text = receipt_notification_text(RECEIPT_DATA)
    assert "tx-123" in text


def test_notify_via_email_skipped_without_smtp(monkeypatch):
    from app.services.receipt_notifications import notify_via_email

    monkeypatch.delenv("SMTP_HOST", raising=False)
    result = notify_via_email(
        {"recipient_email": "a@b.com", "transaction_id": "t1"}
    )
    assert result["ok"] is False
    assert "SMTP_HOST" in result["reason"]


def test_notify_via_email_handles_send_failure(monkeypatch):
    from app.services.receipt_notifications import notify_via_email

    monkeypatch.setenv("SMTP_HOST", "smtp.test")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setenv("SMTP_FROM", "f@x.com")
    with patch(
        "app.services.receipt_notifications.smtplib.SMTP_SSL",
        side_effect=OSError("boom"),
    ):
        result = notify_via_email(
            {
                "recipient_email": "a@b.com",
                "transaction_id": "t1",
                "download_url": "u",
                "expires_in_seconds": 100,
            }
        )
    assert result["ok"] is False
    assert result["error"] == "boom"


def test_notify_via_webhook_posts_to_discord(monkeypatch):
    from app.services.receipt_notifications import notify_via_webhook

    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.test/hook")
    with patch(
        "app.services.receipt_notifications._post_json", return_value=True
    ) as post:
        results = notify_via_webhook(
            {
                "transaction_id": "t1",
                "download_url": "u",
                "status": "COMPLETED",
            }
        )
    assert any(r["platform"] == "discord" and r["ok"] for r in results)
    post.assert_called_once()


def test_notify_receipt_ready_respects_channels(monkeypatch):
    from app.services.receipt_notifications import notify_receipt_ready

    monkeypatch.setenv("RECEIPT_NOTIFICATION_CHANNELS", "webhook")
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.test/hook")
    with patch(
        "app.services.receipt_notifications._post_json", return_value=True
    ) as post:
        results = notify_receipt_ready({"transaction_id": "t1"})
    assert results
    for result in results:
        assert result["channel"] == "webhook"
    post.assert_called_once()


# ---------------------------------------------------------------------------
# Celery task wrapper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_receipt_for_transaction_success(monkeypatch):
    from app.tasks import DatabaseTask, _receipt_for_transaction

    monkeypatch.setattr(DatabaseTask, "_database_url", "postgresql://u:p@h/db")

    row = {
        "id": "tx-1",
        "userId": "u-1",
        "asset": "USDC",
        "senderCurrency": "USD",
        "receiverCurrency": "NGN",
        "amount": "250",
        "outputAmount": "415000",
        "fee": "3.50",
        "rate": "1660",
        "status": "COMPLETED",
        "provider": "Anchor",
        "stellarTxHash": "0xabc",
        "reference": "R1",
        "errorMessage": None,
        "createdAt": __import__("datetime").datetime(2026, 8, 31),
        "updatedAt": __import__("datetime").datetime(2026, 8, 31, 12, 0, 0),
    }

    mock_conn = AsyncMock()
    mock_conn.fetch.return_value = [row]
    mock_cm = MagicMock()
    mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_cm.__aexit__ = AsyncMock(return_value=None)
    mock_pool = MagicMock()
    mock_pool.acquire.return_value = mock_cm
    mock_pool.close = AsyncMock()

    with patch(
        "app.tasks.asyncpg.create_pool", new=AsyncMock(return_value=mock_pool)
    ), patch(
        "app.tasks.generate_payment_receipt",
        return_value={"status": "READY", "download_url": "https://s3.test/x.pdf"},
    ) as gen:
        result = await _receipt_for_transaction(
            transaction_id="tx-1", user_id="u-1"
        )

    assert result["status"] == "READY"
    gen.assert_called_once()
    called_data = gen.call_args[0][0]
    assert called_data["transaction_id"] == "tx-1"
    assert called_data["user_id"] == "u-1"
    assert called_data["stellar_tx_hash"] == "0xabc"


@pytest.mark.asyncio
async def test_receipt_for_transaction_rejects_foreign_user(monkeypatch):
    from app.tasks import DatabaseTask, _receipt_for_transaction

    monkeypatch.setattr(DatabaseTask, "_database_url", "postgresql://u:p@h/db")
    row = {
        "id": "tx-1",
        "userId": "other-user",
        "asset": "USDC",
        "senderCurrency": "USD",
        "receiverCurrency": "NGN",
        "amount": "250",
        "outputAmount": "415000",
        "fee": "3.50",
        "rate": "1660",
        "status": "COMPLETED",
        "provider": "Anchor",
        "stellarTxHash": None,
        "reference": None,
        "errorMessage": None,
        "createdAt": __import__("datetime").datetime(2026, 8, 31),
        "updatedAt": None,
    }
    mock_conn = AsyncMock()
    mock_conn.fetch.return_value = [row]
    mock_cm = MagicMock()
    mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_cm.__aexit__ = AsyncMock(return_value=None)
    mock_pool = MagicMock()
    mock_pool.acquire.return_value = mock_cm
    mock_pool.close = AsyncMock()

    with patch(
        "app.tasks.asyncpg.create_pool", new=AsyncMock(return_value=mock_pool)
    ):
        with pytest.raises(PermissionError):
            await _receipt_for_transaction(transaction_id="tx-1", user_id="u-1")


@pytest.mark.asyncio
async def test_receipt_for_transaction_empty_result(monkeypatch):
    from app.tasks import DatabaseTask, _receipt_for_transaction

    monkeypatch.setattr(DatabaseTask, "_database_url", "postgresql://u:p@h/db")
    mock_conn = AsyncMock()
    mock_conn.fetch.return_value = []
    mock_cm = MagicMock()
    mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_cm.__aexit__ = AsyncMock(return_value=None)
    mock_pool = MagicMock()
    mock_pool.acquire.return_value = mock_cm
    mock_pool.close = AsyncMock()

    with patch(
        "app.tasks.asyncpg.create_pool", new=AsyncMock(return_value=mock_pool)
    ):
        with pytest.raises(LookupError):
            await _receipt_for_transaction(transaction_id="nx", user_id="u-1")
