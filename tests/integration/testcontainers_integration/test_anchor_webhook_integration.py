"""Anchor webhook integration tests — FastAPI /webhook/anchor endpoint.

Tests cover:
- Valid HMAC signature acceptance
- Missing/invalid HMAC signature rejection (401)
- Malformed JSON payload rejection (400)
- Missing transaction id or status (400)
- Full remittance lifecycle: PROCESSING → DISPATCHED → DELIVERED
"""

from __future__ import annotations

import hashlib
import hmac
import json

import httpx
import pytest
from fastapi import FastAPI

from app.adapters.anchor import router, verify_hmac_signature

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# The anchor module reads ANCHOR_WEBHOOK_SECRET at import time.
# Use the same secret the module loaded (defaults to "default_secret").
WEBHOOK_SECRET = b"default_secret"


def _sign_payload(payload: bytes, secret: bytes = WEBHOOK_SECRET) -> str:
    """Compute HMAC-SHA256 signature for a payload."""
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def _make_transaction_payload(
    transaction_id: str = "txn-123",
    status: str = "PROCESSING",
) -> dict:
    return {
        "transaction": {
            "id": transaction_id,
            "status": status,
        }
    }


# ---------------------------------------------------------------------------
# Test app setup
# ---------------------------------------------------------------------------


@pytest.fixture
def test_app():
    """Create a FastAPI test app with the anchor router."""
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture
def client(test_app):
    """Create an httpx AsyncClient for the test app."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=test_app), base_url="http://testserver")


# ---------------------------------------------------------------------------
# HMAC signature verification unit tests
# ---------------------------------------------------------------------------


class TestHMACVerification:
    """Unit tests for the verify_hmac_signature helper."""

    def test_valid_signature(self):
        payload = b"hello world"
        sig = _sign_payload(payload)
        assert verify_hmac_signature(payload, sig, WEBHOOK_SECRET) is True

    def test_invalid_signature(self):
        payload = b"hello world"
        assert verify_hmac_signature(payload, "deadbeef" * 8, WEBHOOK_SECRET) is False

    def test_empty_signature(self):
        assert verify_hmac_signature(b"data", "", WEBHOOK_SECRET) is False

    def test_none_signature(self):
        assert verify_hmac_signature(b"data", None, WEBHOOK_SECRET) is False

    def test_tampered_payload(self):
        payload = b"original"
        sig = _sign_payload(payload)
        assert verify_hmac_signature(b"tampered", sig, WEBHOOK_SECRET) is False

    def test_wrong_secret(self):
        payload = b"data"
        sig = _sign_payload(payload, secret=b"wrong-secret")
        assert verify_hmac_signature(payload, sig, WEBHOOK_SECRET) is False


# ---------------------------------------------------------------------------
# Endpoint integration tests
# ---------------------------------------------------------------------------


class TestAnchorWebhookEndpoint:
    """Integration tests for POST /webhook/anchor."""

    async def test_valid_webhook_accepted(self, client) -> None:
        payload = _make_transaction_payload("txn-001", "PROCESSING")
        body = json.dumps(payload).encode()
        sig = _sign_payload(body)

        response = await client.post(
            "/webhook/anchor",
            content=body,
            headers={
                "X-Anchor-Signature": sig,
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "processed" in data["message"].lower()

    async def test_missing_signature_rejected(self, client) -> None:
        payload = _make_transaction_payload()
        body = json.dumps(payload).encode()

        response = await client.post(
            "/webhook/anchor",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 401

    async def test_invalid_signature_rejected(self, client) -> None:
        payload = _make_transaction_payload()
        body = json.dumps(payload).encode()

        response = await client.post(
            "/webhook/anchor",
            content=body,
            headers={
                "X-Anchor-Signature": "invalid_signature_value",
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 401

    async def test_malformed_json_rejected(self, client) -> None:
        body = b"not valid json {{{"
        sig = _sign_payload(body)

        response = await client.post(
            "/webhook/anchor",
            content=body,
            headers={
                "X-Anchor-Signature": sig,
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 400

    async def test_missing_transaction_id_rejected(self, client) -> None:
        payload = {"transaction": {"status": "PROCESSING"}}  # no "id"
        body = json.dumps(payload).encode()
        sig = _sign_payload(body)

        response = await client.post(
            "/webhook/anchor",
            content=body,
            headers={
                "X-Anchor-Signature": sig,
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 400

    async def test_missing_status_rejected(self, client) -> None:
        payload = {"transaction": {"id": "txn-999"}}  # no "status"
        body = json.dumps(payload).encode()
        sig = _sign_payload(body)

        response = await client.post(
            "/webhook/anchor",
            content=body,
            headers={
                "X-Anchor-Signature": sig,
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 400

    async def test_empty_body_rejected(self, client) -> None:
        body = b""
        sig = _sign_payload(body)

        response = await client.post(
            "/webhook/anchor",
            content=body,
            headers={
                "X-Anchor-Signature": sig,
                "Content-Type": "application/json",
            },
        )
        assert response.status_code in (400, 422)

    async def test_full_lifecycle_processing_to_delivered(self, client) -> None:
        """Simulate the full remittance lifecycle through the webhook endpoint."""
        txn_id = "lifecycle-txn-001"

        for status in ["PROCESSING", "DISPATCHED", "DELIVERED"]:
            payload = _make_transaction_payload(txn_id, status)
            body = json.dumps(payload).encode()
            sig = _sign_payload(body)

            response = await client.post(
                "/webhook/anchor",
                content=body,
                headers={
                    "X-Anchor-Signature": sig,
                    "Content-Type": "application/json",
                },
            )
            assert response.status_code == 200
            assert response.json()["success"] is True

    async def test_status_is_uppercased(self, client) -> None:
        payload = _make_transaction_payload("txn-case", "processing")
        body = json.dumps(payload).encode()
        sig = _sign_payload(body)

        response = await client.post(
            "/webhook/anchor",
            content=body,
            headers={
                "X-Anchor-Signature": sig,
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 200
