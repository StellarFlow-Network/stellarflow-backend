"""Receipt download-link notification handlers (Issue #772).

Dispatches a signed S3 download URL for a generated payment receipt through
the configured channels:

* ``webhook`` — posts to the configured Discord / Slack incoming webhooks.
* ``email`` — sends an SMTP message with the link when SMTP is configured.

Handlers are best-effort: they never raise, returning per-channel delivery
results so the caller can record/surface failures without aborting.
"""

from __future__ import annotations

import json
import logging
import os
import smtplib
from email.message import EmailMessage
from typing import Any
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

WEBHOOK_TIMEOUT_SECONDS = 10
DISCORD_EMBED_COLOR = 0x6366F1


def receipt_notification_text(details: dict[str, Any]) -> str:
    """Build the human-readable message body announcing a ready receipt."""
    transaction_id = details.get("transaction_id") or "unknown"
    amount = details.get("amount") or "0.00"
    currency = details.get("sender_currency") or details.get("asset") or ""
    return (
        f"Your StellarFlow payment receipt for transaction {transaction_id} "
        f"({amount} {currency}) is ready for download."
    )


def _post_json(url: str, payload: dict[str, Any]) -> bool:
    """POST *payload* as JSON to *url*, returning ``True`` on HTTP 2xx."""
    data = json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "stellarflow-backend"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=WEBHOOK_TIMEOUT_SECONDS) as response:
            return 200 <= response.status < 300
    except OSError as exc:
        logger.warning("Webhook delivery to %s failed: %s", url, exc)
        return False


def _discord_payload(details: dict[str, Any]) -> dict[str, Any]:
    url = details.get("download_url", "")
    return {
        "username": "StellarFlow",
        "embeds": [
            {
                "title": "Payment receipt ready 📄",
                "description": receipt_notification_text(details),
                "color": DISCORD_EMBED_COLOR,
                "fields": [
                    {"name": "Transaction ID", "value": str(details.get("transaction_id") or "—"), "inline": True},
                    {"name": "Status", "value": str(details.get("status") or "COMPLETED"), "inline": True},
                    {"name": "Download", "value": url or "—"},
                ],
            }
        ],
    }


def _slack_payload(details: dict[str, Any]) -> dict[str, Any]:
    text = receipt_notification_text(details)
    return {
        "username": "StellarFlow",
        "attachments": [
            {
                "color": "#6366f1",
                "title": "Payment receipt ready 📄",
                "title_link": details.get("download_url", ""),
                "text": text,
                "fields": [
                    {"title": "Transaction ID", "value": str(details.get("transaction_id") or "—"), "short": True},
                    {"title": "Status", "value": str(details.get("status") or "COMPLETED"), "short": True},
                ],
            }
        ],
    }


def notify_via_webhook(details: dict[str, Any]) -> list[dict[str, Any]]:
    """Deliver the download link to configured Discord and/or Slack webhooks."""
    results: list[dict[str, Any]] = []
    discord_url = os.getenv("DISCORD_WEBHOOK_URL")
    if discord_url:
        ok = _post_json(discord_url, _discord_payload(details))
        results.append({"channel": "webhook", "platform": "discord", "ok": ok})
    slack_url = os.getenv("SLACK_WEBHOOK_URL")
    if slack_url:
        ok = _post_json(slack_url, _slack_payload(details))
        results.append({"channel": "webhook", "platform": "slack", "ok": ok})
    if not (discord_url or slack_url):
        results.append(
            {
                "channel": "webhook",
                "platform": "none",
                "ok": False,
                "reason": "no DISCORD_WEBHOOK_URL or SLACK_WEBHOOK_URL configured",
            }
        )
    return results


def _smtp_config() -> tuple[str, int, str, str, str] | None:
    host = os.getenv("SMTP_HOST", "").strip()
    if not host:
        return None
    try:
        port = int(os.getenv("SMTP_PORT", "587"))
    except ValueError:
        port = 587
    username = os.getenv("SMTP_USERNAME", "")
    password = os.getenv("SMTP_PASSWORD", "")
    mail_from = os.getenv("SMTP_FROM") or os.getenv("RECEIPT_EMAIL_FROM", "")
    if not mail_from:
        mail_from = f"StellarFlow Receipts <{username or 'receipts@stellarflow.example'}>"
    return host, port, username, password, mail_from


def notify_via_email(details: dict[str, Any]) -> dict[str, Any]:
    """Send an SMTP email containing the signed receipt download link."""
    to_address = details.get("recipient_email") or details.get("user_email")
    smtp = _smtp_config()
    if smtp is None:
        return {
            "channel": "email",
            "ok": False,
            "reason": "SMTP_HOST not configured; email delivery skipped",
        }
    if not to_address:
        return {"channel": "email", "ok": False, "reason": "no recipient email provided"}

    host, port, username, password, mail_from = smtp
    message = EmailMessage()
    message["Subject"] = "Your StellarFlow payment receipt is ready"
    message["From"] = mail_from
    message["To"] = to_address
    body = (
        f"{receipt_notification_text(details)}\n\n"
        f"Download your receipt (valid for "
        f"{details.get('expires_in_seconds', '')} seconds):\n"
        f"{details.get('download_url', '')}\n\n"
        f"Transaction ID: {details.get('transaction_id', '—')}\n"
        f"Reference: {details.get('reference', '—')}\n\n"
        "Thank you for using StellarFlow."
    )
    message.set_content(body)

    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=WEBHOOK_TIMEOUT_SECONDS) as client:
                if username:
                    client.login(username, password)
                client.send_message(message)
        else:
            with smtplib.SMTP(host, port, timeout=WEBHOOK_TIMEOUT_SECONDS) as client:
                client.ehlo()
                if client.has_extn("starttls"):
                    client.starttls()
                    client.ehlo()
                if username:
                    client.login(username, password)
                client.send_message(message)
        return {"channel": "email", "ok": True, "to": to_address}
    except (smtplib.SMTPException, OSError) as exc:
        logger.warning("Email receipt delivery to %s failed: %s", to_address, exc)
        return {"channel": "email", "ok": False, "to": to_address, "error": str(exc)}


def notify_receipt_ready(details: dict[str, Any]) -> list[dict[str, Any]]:
    """Dispatch the signed receipt download link via the configured channels."""
    channels = [
        channel.strip().lower()
        for channel in os.getenv(
            "RECEIPT_NOTIFICATION_CHANNELS", "webhook,email"
        ).split(",")
        if channel.strip()
    ]
    results: list[dict[str, Any]] = []
    if "webhook" in channels:
        results.extend(notify_via_webhook(details))
    if "email" in channels:
        results.append(notify_via_email(details))
    return results