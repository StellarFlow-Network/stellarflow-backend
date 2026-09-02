import hashlib
import hmac
import json
import logging
import os
from typing import Any, Callable, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import text

# Import the WebSocket connection manager to broadcast updates
try:
    from src.websockets.manager import manager
except ImportError:
    # Fallback/mock if running outside the main app context
    manager = None

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook/anchor", tags=["Anchor Webhooks"])

# Read the secret from environment variables
ANCHOR_WEBHOOK_SECRET = os.environ.get("ANCHOR_WEBHOOK_SECRET", "default_secret").encode("utf-8")


class WebhookResponse(BaseModel):
    success: bool
    message: str


def verify_hmac_signature(payload: bytes, signature: str, secret: bytes) -> bool:
    """Verifies the HMAC-SHA256 signature of the webhook payload."""
    if not signature:
        return False

    normalized_signature = signature.strip()
    if "=" in normalized_signature:
        normalized_signature = normalized_signature.split("=", 1)[1]

    expected_hmac = hmac.new(secret, payload, hashlib.sha256).hexdigest()
    # Use hmac.compare_digest to prevent timing attacks while accepting the
    # common "sha256=<hex>" header form used by external partners.
    return hmac.compare_digest(expected_hmac.lower(), normalized_signature.lower())


SessionFactory = Callable[[], Any]


async def transition_remittance_status(
    transaction_id: str,
    new_status: str,
    session_factory: Optional[SessionFactory] = None,
) -> None:
    """
    Transition a remittance transaction status when the Python service has DB access.

    Anchor payloads may identify either the internal remittance id or an external
    anchor reference, so both columns are matched.
    """
    valid_statuses = ["PROCESSING", "DISPATCHED", "DELIVERED"]
    if new_status not in valid_statuses:
        logger.warning(f"Unexpected status '{new_status}' for transaction {transaction_id}")
    
    logger.info(f"Transitioning remittance transaction {transaction_id} to status: {new_status}")

    if session_factory is None:
        try:
            from app.db.session import async_session_factory

            session_factory = async_session_factory
        except RuntimeError as exc:
            logger.warning(
                "Database unavailable for anchor webhook status update: %s",
                exc,
            )
            return

    try:
        async with session_factory() as session:
            result = await session.execute(
                text(
                    """
                    UPDATE "RemittanceTransaction"
                    SET status = :status,
                        "updatedAt" = NOW()
                    WHERE id = :transaction_id
                       OR reference = :transaction_id
                    """
                ),
                {"status": new_status, "transaction_id": transaction_id},
            )
            await session.commit()

            rowcount = getattr(result, "rowcount", 0)
            if rowcount == 0:
                logger.warning(
                    "No remittance transaction found for anchor id %s",
                    transaction_id,
                )
    except Exception as exc:
        logger.warning("Anchor webhook remittance status update skipped: %s", exc)


@router.post("", response_model=WebhookResponse)
async def receive_anchor_webhook(
    request: Request,
    x_anchor_signature: str = Header(None, alias="X-Anchor-Signature")
):
    """
    Handle incoming webhook status updates from financial anchor partners
    regarding fiat payout completion status.
    """
    # 1. Read raw body for HMAC verification
    raw_body = await request.body()
    
    # 2. Validate HMAC-SHA256 signature
    if not verify_hmac_signature(raw_body, x_anchor_signature, ANCHOR_WEBHOOK_SECRET):
        logger.warning("Invalid or missing X-Anchor-Signature on incoming webhook.")
        raise HTTPException(status_code=401, detail="Invalid HMAC signature")
        
    try:
        # Parse JSON payload
        payload = json.loads(raw_body.decode("utf-8"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    # The payload structure is expected to follow SEP-24 / SEP-31 formats.
    # Typically, it contains a 'transaction' object with an 'id' and a 'status'.
    transaction = payload.get("transaction", {})
    transaction_id = transaction.get("id")
    status = transaction.get("status")
    
    if not transaction_id or not status:
        logger.error(f"Malformed payload received: {payload}")
        raise HTTPException(status_code=400, detail="Missing transaction id or status in payload")

    status = status.upper()

    # 3. Transition remittance transaction status in the database
    await transition_remittance_status(transaction_id, status)

    # 4. Broadcast real-time status update to frontend clients over WebSocket
    if manager:
        channel_name = f"remittance_{transaction_id}"
        message = {
            "transaction_id": transaction_id,
            "status": status,
            "event": "STATUS_UPDATE"
        }
        await manager.broadcast_to_channel(channel_name, message)
        logger.info(f"Broadcasted status update to channel {channel_name}")
    else:
        logger.warning("WebSocket manager not available. Broadcast skipped.")

    return WebhookResponse(success=True, message="Webhook processed successfully")
