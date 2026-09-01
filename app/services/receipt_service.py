"""PDF payment receipt generation and object-storage upload (Issue #772).

Renders a Jinja2 receipt template to HTML, compiles it into a PDF asset
with WeasyPrint, uploads the document to the configured S3 bucket and hands
the signed download link back to the caller so it can be dispatched via the
email/webhook notification handlers.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import boto3

from app.services.receipt_notifications import notify_receipt_ready

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"
RECEIPT_TEMPLATE_NAME = "receipt.html.jinja2"

REQUIRED_FIELDS = ("transaction_id", "user_id")
MAX_URL_TTL_SECONDS = 604800
DEFAULT_URL_TTL_SECONDS = 86400

_object_key_slug = re.compile(r"[^a-zA-Z0-9_.-]+")


class ReceiptValidationError(ValueError):
    """Raised when a receipt payload is missing required transaction fields."""


def _s3_config() -> tuple[str, str, int]:
    """Resolve S3 bucket, key prefix and presigned URL TTL from the environment."""
    bucket = os.getenv("RECEIPT_STORAGE_BUCKET", os.getenv("S3_BUCKET", ""))
    if not bucket:
        raise RuntimeError("RECEIPT_STORAGE_BUCKET or S3_BUCKET must be configured")
    prefix = os.getenv("RECEIPT_STORAGE_PREFIX", "receipts").strip("/")
    try:
        expiry = int(os.getenv("RECEIPT_DOWNLOAD_URL_TTL_SECONDS", str(DEFAULT_URL_TTL_SECONDS)))
    except ValueError as exc:
        raise RuntimeError("RECEIPT_DOWNLOAD_URL_TTL_SECONDS must be an integer") from exc
    if expiry < 1 or expiry > MAX_URL_TTL_SECONDS:
        raise RuntimeError(
            f"RECEIPT_DOWNLOAD_URL_TTL_SECONDS must be between 1 and {MAX_URL_TTL_SECONDS}"
        )
    return bucket, prefix, expiry


def _environment() -> Any:
    """Return the cached Jinja2 environment (lazy import keeps setup import-safe)."""
    from jinja2 import Environment, FileSystemLoader, select_autoescape

    environment = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=select_autoescape(["html", "jinja2", "html.jinja2"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    return environment


def _format_number(value: Any) -> str:
    """Format a numeric value as a plain string, stripping trailing zeros."""
    if value is None:
        return ""
    try:
        number = float(str(value))
    except (TypeError, ValueError):
        return str(value)
    if number == int(number):
        return str(int(number))
    return f"{number:,.10f}".rstrip("0").rstrip(".")


def render_receipt_html(receipt_data: dict[str, Any]) -> str:
    """Compile the receipt template into an HTML document string."""
    header = {
        "brand_name": receipt_data.get("brand_name", "StellarFlow"),
        "generated_at": receipt_data.get(
            "generated_at",
            datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        ),
        "receipt_id": receipt_data.get("receipt_id") or str(uuid4()),
        "transaction_id": receipt_data.get("transaction_id") or "",
        "user_id": receipt_data.get("user_id", ""),
        "recipient_email": receipt_data.get("recipient_email")
        or receipt_data.get("user_email", ""),
        "recipient_name": receipt_data.get("recipient_name", ""),
        "recipient_account": receipt_data.get("recipient_account", ""),
        "asset": receipt_data.get("asset", ""),
        "amount": _format_number(receipt_data.get("amount")),
        "sender_currency": receipt_data.get("sender_currency", ""),
        "receiver_currency": receipt_data.get("receiver_currency", ""),
        "output_amount": _format_number(receipt_data.get("output_amount")),
        "fee": _format_number(receipt_data.get("fee")),
        "rate": _format_number(receipt_data.get("rate")),
        "status": (receipt_data.get("status") or "COMPLETED").upper(),
        "provider": receipt_data.get("provider", ""),
        "reference": receipt_data.get("reference", ""),
        "stellar_tx_hash": receipt_data.get("stellar_tx_hash", ""),
        "completed_at": receipt_data.get("completed_at", ""),
        "created_at": receipt_data.get("created_at", ""),
    }
    template = _environment().get_template(RECEIPT_TEMPLATE_NAME)
    return template.render(**header)


def render_receipt_pdf(receipt_data: dict[str, Any]) -> bytes:
    """Compile the receipt template into a PDF document in memory.

    WeasyPrint is imported lazily because loading it pulls in native Pango
    libraries; this keeps the module importable in environments without them.
    """
    from weasyprint import HTML

    html = render_receipt_html(receipt_data)
    return HTML(string=html, base_url=str(TEMPLATE_DIR)).write_pdf()


def _receipt_key(receipt_data: dict[str, Any], bucket_suffix: str | None = None) -> str:
    transaction_id = receipt_data.get("transaction_id") or "unknown"
    receipt_id = receipt_data.get("receipt_id") or str(uuid4())
    user_id = receipt_data.get("user_id") or "unknown"
    safe_tx = _object_key_slug.sub("_", str(transaction_id))
    safe_user = _object_key_slug.sub("_", str(user_id))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{safe_user}/{safe_tx}/receipt-{receipt_id}-{stamp}{bucket_suffix or ''}.pdf"


def upload_receipt_pdf(
    pdf_bytes: bytes,
    receipt_data: dict[str, Any],
    s3_client: Any | None = None,
) -> dict[str, Any]:
    """Upload a rendered receipt PDF to S3 and return its signed download URL."""
    if not pdf_bytes:
        raise ValueError("pdf_bytes must be non-empty")
    bucket, prefix, expiry = _s3_config()
    client = s3_client or boto3.client("s3", region_name=os.getenv("AWS_REGION"))
    key = f"{prefix}/{_receipt_key(receipt_data)}"

    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=pdf_bytes,
        ContentType="application/pdf",
        ContentDisposition='attachment; filename="payment-receipt.pdf"',
        Metadata={
            "transaction_id": str(receipt_data.get("transaction_id", "")),
            "receipt_id": str(receipt_data.get("receipt_id", "")),
        },
    )

    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=expiry,
    )
    return {
        "bucket": bucket,
        "key": key,
        "download_url": url,
        "expires_in_seconds": expiry,
    }


def generate_payment_receipt(
    receipt_data: dict[str, Any],
    s3_client: Any | None = None,
) -> dict[str, Any]:
    """Render, store and dispatch a payment receipt for a completed payout.

    Returns a summary containing the stored object and the signed download
    link together with per-channel notification delivery results.
    """
    missing = [field for field in REQUIRED_FIELDS if not receipt_data.get(field)]
    if missing:
        raise ReceiptValidationError(
            f"receipt_data is missing required field(s): {', '.join(missing)}"
        )

    pdf_bytes = render_receipt_pdf(receipt_data)
    stored = upload_receipt_pdf(pdf_bytes, receipt_data, s3_client=s3_client)

    notifications = notify_receipt_ready({**receipt_data, **stored})

    return {
        "receipt_id": receipt_data.get("receipt_id"),
        "transaction_id": receipt_data.get("transaction_id"),
        "user_id": receipt_data.get("user_id"),
        "status": "READY",
        "pdf_bytes": len(pdf_bytes),
        **stored,
        "notifications": notifications,
    }