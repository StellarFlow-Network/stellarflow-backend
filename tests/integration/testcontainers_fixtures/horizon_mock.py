"""Lightweight mock of the Stellar Horizon API server for integration tests.

Uses the ``http.server`` stdlib module for maximum reliability in test
environments (no external dependencies, no thread-safety issues with ASGI).

Endpoints mocked
----------------
* ``GET  /accounts/{address}``  — returns account with configurable sequence
* ``POST /transactions``        — accepts tx envelope, returns success or ``tx_bad_seq``
* ``GET  /fee_stats``           — returns deterministic fee statistics

Usage
-----
The :func:`start_horizon_mock` function boots the mock on a random port in a
background daemon thread and returns the base URL.  The
:class:`HorizonMockServer` class exposes knobs for injecting faults.
"""

from __future__ import annotations

import hashlib
import json
import logging
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Mutable state
# ---------------------------------------------------------------------------

_mock: "HorizonMockServer" = None  # type: ignore[assignment]


class HorizonMockServer:
    """Controllable mock of the Stellar Horizon API.

    Attributes
    ----------
    default_sequence:
        Sequence number returned by ``GET /accounts/{address}`` unless
        overridden per-address via ``account_sequences``.
    fail_transactions:
        When ``True``, ``POST /transactions`` returns ``tx_bad_seq``.
    account_sequences:
        Per-address override mapping ``{address: sequence}``.
    """

    def __init__(self) -> None:
        self.default_sequence: int = 100_000_000
        self.fail_transactions: bool = False
        self.account_sequences: Dict[str, int] = {}
        self.tx_submitted: List[bytes] = []
        self.host: str = "127.0.0.1"
        self.port: int = 0

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def reset(self) -> None:
        self.default_sequence = 100_000_000
        self.fail_transactions = False
        self.account_sequences.clear()
        self.tx_submitted.clear()


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------


class _HorizonHandler(BaseHTTPRequestHandler):
    """Handle incoming HTTP requests and route to mock endpoints."""

    def log_message(self, format, *args):
        """Suppress default stderr logging."""
        pass

    def _send_json(self, data: dict, status: int = 200) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/health":
            self._send_json({"status": "ok"})
            return

        if path.startswith("/accounts/"):
            address = path.split("/accounts/", 1)[1]
            seq = _mock.account_sequences.get(address, _mock.default_sequence) if _mock else 100_000_000
            self._send_json({
                "_links": {},
                "id": address,
                "account_id": address,
                "sequence": str(seq),
                "subentry_count": 1,
                "home_domain": "stellarflow.test",
                "thresholds": {"low": 1, "medium": 1, "high": 1},
                "flags": {"auth_required": False, "auth_revocable": False},
                "balances": [
                    {"asset_type": "native", "balance": "10000.0000000"},
                ],
            })
            return

        if path == "/fee_stats":
            self._send_json({
                "last_ledger": "9007199254740992",
                "last_ledger_base_fee": "100",
                "ledger_capacity_usage": "0.05",
                "min_accepted_fee": "100",
                "mode_accepted_fee": "200",
                "p10_accepted_fee": "100",
                "p50_accepted_fee": "200",
                "p90_accepted_fee": "400",
                "p99_accepted_fee": "1000",
            })
            return

        self._send_json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/transactions":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else b""

            if _mock:
                _mock.tx_submitted.append(body)

            if _mock and _mock.fail_transactions:
                self._send_json({
                    "result_xdr": "",
                    "envelope_xdr": body.decode("utf-8", errors="replace"),
                    "hash": hashlib.sha256(body).hexdigest(),
                    "ledger": 0,
                    "created_at": "1970-01-01T00:00:00Z",
                    "result": {
                        "result": {
                            "code": "tx_bad_seq",
                            "results": [],
                        },
                        "fee_charged": 100,
                    },
                })
                return

            tx_hash = hashlib.sha256(body).hexdigest()
            self._send_json({
                "result_xdr": "AAAAAG/l+PU9rJn...AAAAAwAAAAAAAAAAAAAAAAEAAA==",
                "envelope_xdr": body.decode("utf-8", errors="replace"),
                "hash": tx_hash,
                "ledger": 900_719_925_474_0993,
                "created_at": "2026-08-28T12:00:00Z",
                "result": {
                    "result": {
                        "code": "tx_success",
                        "results": [],
                    },
                    "fee_charged": 100,
                },
            })
            return

        self._send_json({"error": "not found"}, 404)


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------


def _find_free_port() -> int:
    """Find an available TCP port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_horizon_mock(
    host: str = "127.0.0.1",
    port: Optional[int] = None,
    timeout: float = 10.0,
) -> HorizonMockServer:
    """Start the Horizon mock server in a daemon thread.

    Parameters
    ----------
    host:
        Bind address (default ``127.0.0.1``).
    port:
        Bind port (default: random free port).
    timeout:
        Seconds to wait for the server to become ready.

    Returns
    -------
    HorizonMockServer
        The mutable server state object.  Tests use this to inject faults.
    """
    global _mock

    server = HorizonMockServer()
    server.host = host
    if port is None:
        port = _find_free_port()
    server.port = port
    _mock = server

    httpd = HTTPServer((host, port), _HorizonHandler)

    thread = threading.Thread(
        target=httpd.serve_forever,
        daemon=True,
        name="horizon-mock-server",
    )
    thread.start()

    # Wait for the server to become ready by polling the health endpoint.
    import urllib.request
    import urllib.error

    deadline = time.monotonic() + timeout
    last_error: Optional[Exception] = None
    while time.monotonic() < deadline:
        try:
            req = urllib.request.Request(f"http://{host}:{port}/health")
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    logger.info("Horizon mock ready at http://%s:%d", host, port)
                    return server
        except Exception as exc:
            last_error = exc
        time.sleep(0.1)

    raise RuntimeError(
        f"Horizon mock server did not start within {timeout}s"
    ) from last_error


def stop_horizon_mock() -> None:
    """Stop the Horizon mock server (best-effort, daemon thread auto-exits)."""
    global _mock
    _mock = None
