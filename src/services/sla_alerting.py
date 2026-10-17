"""
Flash Loan High-Frequency Emergency Circuit Breaker Bot.

Monitors pending mempool transactions for repetitive flash loan borrowing
patterns, triggers an emergency contract pause when more than 3 suspicious
flash loans occur in a single ledger, and dispatches a security alert to
the configured Telegram channel.

The module is deliberately split into pure detection logic (testable, no
I/O) and thin I/O-bound adapters (RPC, contract call, Telegram) so the
acceptance criteria can be verified in isolation.

### Acceptance criteria addressed
- Emergency pause call submits within the same ledger window of aomaly
  detection.
- Security alert payload includes transaction hashes and pool target
  addresses.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, Optional, Sequence

from typing import AsyncIterator

try:
    import httpx  # type: ignore
except ImportError:
    httpx = None  # type: ignore

logger = logging.getLogger(__name__)

DEFAULT_SUSPICIOUS_THRESHOLD = 3
DEFAULT_POLL_INTERVAL_SECONDS = 1.0
DEFAULT_TELEGRAM_TIMEOUT = 10.0


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MempoolFlashLoanTx:
    """A single pending flash loan transaction observed in the mempool."""

    tx_hash: str
    pool_address: str
    borrower: str
    amount: int
    ledger: int
    timestamp: float
    pattern: str = "flash_loan"


@dataclass(frozen=True)
class AnomalyReport:
    """Result of evaluating a ledger window for suspicious flash loans."""

    ledger: int
    tx_hashes: tuple[str, ...]
    pool_addresses: tuple[str, ...]
    count: int
    threshold: int
    triggered: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "ledger": self.ledger,
            "tx_hashes": list(self.tx_hashes),
            "pool_addresses": list(self.pool_addresses),
            "count": self.count,
            "threshold": self.threshold,
            "triggered": self.triggered,
        }


# ---------------------------------------------------------------------------
# Pure detection logic (no I/O)
# ---------------------------------------------------------------------------


def detect_suspicious_flash_loans(
    txs: Iterable[MempoolFlashLoanTx],
    ledger: int,
    threshold: int = DEFAULT_SUSPICIOUS_THRESHOLD,
) -> AnomalyReport:
    """Evaluates the flash loans for a single ledger.

    The anomaly fires when the number of suspicious flash loans strictly
    exceeds `threshold` (> 3 by default). The report always carries the
    transaction hashes and pool target addresses so the alert payload is
    complete regardless of whether the threshold was crossed.
    """
    relevant = [tx for tx in txs if tx.ledger == ledger]
    # Deduplicate by tx hash while preserving observation order.
    seen: set[str] = set()
    tx_hashes: list[str] = []
    pool_addresses: list[str] = []
    pools_seen: set[str] = set()
    for tx in relevant:
        if tx.tx_hash in seen:
            continue
        seen.add(tx.tx_hash)
        tx_hashes.append(tx.tx_hash)
        if tx.pool_address not in pools_seen:
            pools_seen.add(tx.pool_address)
            pool_addresses.append(tx.pool_address)

    count = len(tx_hashes)
    return AnomalyReport(
        ledger=ledger,
        tx_hashes=tuple(tx_hashes),
        pool_addresses=tuple(pool_addresses),
        count=count,
        threshold=threshold,
        triggered=count > threshold,
    )


def build_telegram_payload(
    report: AnomalyReport,
    pause_tx_hash: Optional[str] = None,
    pause_submitted_at: Optional[float] = None,
) -> dict[str, Any]:
    """Builds the JSON payload sent to the security Telegram channel.

    The payload always includes the transaction hashes and pool target
    addresses required by the acceptance criteria.
    """
    return {
        "event": "flash_loan_circuit_breaker",
        "ledger": report.ledger,
        "suspicious_count": report.count,
        "threshold": report.threshold,
        "transaction_hashes": list(report.tx_hashes),
        "pool_target_addresses": list(report.pool_addresses),
        "pause_tx_hash": pause_tx_hash,
        "pause_submitted_at": pause_submitted_at,
        "timestamp": time.time(),
    }


def render_telegram_message(payload: dict[str, Any]) -> str:
    """Human-readable Telegram message body for the alert."""
    tx_hashes = payload.get("transaction_hashes", [])
    pools = payload.get("pool_target_addresses", [])
    lines = [
        "🚪 *FLASH LOAN CIRCUIT BREAKER TRIGGERED*",
        f"Ledger: {payload.get('ledger')}",
        f"Suspicious flash loans: {payload.get('suspicious_count')} (threshold > {payload.get('threshold')})",
        f"Pause tx: {payload.get('pause_tx_hash') or 'pending'}",
        "Transaction hashes:",
        *(f"  • {h}" for h in tx_hashes),
        "Pool target addresses:",
        *(f"  • {p}" for p in pools),
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# I/O-bound adapters
# ---------------------------------------------------------------------------


class MempoolSource:
    """Abstract mempool feed that yields pending flash loan transactions."""

    async def stream(self) -> AsyncIterator[MempoolFlashLoanTx]:
        raise NotImplementedError


class HttpMempoolSource(MempoolSource):
    """Polls an RPC JSON-RPC endpoint for pending flash loan transactions.

    The endpoint is expected to return a JSON array of objects with the
    following shape::

        {"tx_hash": "...", "pool_address": "...", "borrower": "...",
         "amount": 123, "ledger": 456, "timestamp": 1.23}

    This keeps the bot decoupled from any particular chain client while
    still performing real network I/O.
    """

    def __init__(self, endpoint: str, poll_interval_seconds: float = 1.0) -> None:
        if not endpoint:
            raise ValueError("mempool endpoint must be set")
        self.endpoint = endpoint
        self.poll_interval_seconds = poll_interval_seconds

    async def _fetch(self) -> Sequence[dict[str, Any]]:
        if httpx is None:
            raise RuntimeError("httpx is required for HttpMempoolSource")
        async with httpx.AsyncClient(timeout=DEFAULT_TELEGRAM_TIMEOUT) as client:
            resp = await client.post(
                self.endpoint,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "getPendingFlashLoans",
                    "params": [],
                },
            )
            resp.raise_for_status()
            body = resp.json()
        result = body.get("result", body) if isinstance(body, dict) else body
        if not isinstance(result, list):
            raise ValueError(f"unexpected mempool response: {body!r}")
        return result

    async def stream(self) -> AsyncIterator[MempoolFlashLoanTx]:
        seen: set[str] = set()
        while True:
            try:
                raw = await self._fetch()
            except Exception as exc:  # noqa: BLE001
                logger.warning("mempool poll failed: %s", exc)
                await asyncio.sleep(self.poll_interval_seconds)
                continue
            for item in raw:
                try:
                    tx = MempoolFlashLoanTx(
                        tx_hash=str(item["tx_hash"]),
                        pool_address=str(item["pool_address"]),
                        borrower=str(item.get("borrower", "")),
                        amount=int(item.get("amount", 0)),
                        ledger=int(item["ledger"]),
                        timestamp=float(item.get("timestamp", time.time())),
                        pattern=str(item.get("pattern", "flash_loan")),
                    )
                except (KeyError, TypeError, ValueError) as exc:
                    logger.warning("skipping malformed mempool tx: %s", exc)
                    continue
                if tx.tx_hash in seen:
                    continue
                seen.add(tx.tx_hash)
                yield tx
            await asyncio.sleep(self.poll_interval_seconds)


class PauseExecutor:
    """Submits the emergency pause call to the target contract."""

    async def pause(self, report: AnomalyReport) -> str:
        raise NotImplementedError


class HttpPauseExecutor(PauseExecutor):
    """Submits the pause transaction via an RPC JSON-RPC endpoint.

    The endpoint is expected to accept a `pauseContract` call and
    return a transaction hash. This is the real submission path used in
    production.
    """

    def __init__(
        self,
        rpc_endpoint: str,
        contract_address: str,
        auth_token: Optional[str] = None,
        timeout: float = DEFAULT_TELEGRAM_TIMEOUT,
    ) -> None:
        if not rpc_endpoint:
            raise ValueError("rpc_endpoint must be set")
        if not contract_address:
            raise ValueError("contract_address must be set")
        self.rpc_endpoint = rpc_endpoint
        self.contract_address = contract_address
        self.auth_token = auth_token
        self.timeout = timeout

    async def pause(
        report: AnomalyReport,
    ) -> str:
        if httpx is None:
            raise RuntimeError("httpx is required for HttpPauseExecutor")
        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pauseContract",
            "params": [
                {
                    "contract": self.contract_address,
                    "reason": "flash_loan_anomaly",
                    "ledger": report.ledger,
                    "tx_hashes": list(report.tx_hashes),
                    "pool_addresses": list(report.pool_addresses),
                },
            ],
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(self.rpc_endpoint, json=payload, headers=headers)
            resp.raise_for_status()
            body = resp.json()
        if isinstance(body, dict) and body.get("error"):
            raise RuntimeError(f"pause tx rejected: {body['error']!r}")
        result = body.get("result") if isinstance(body, dict) else body
        tx_hash = result.get("tx_hash") if isinstance(result, dict) else None
        if not tx_hash:
            raise RuntimeError(f"pause tx response missing tx_hash: {body!r}")
        return str(tx_hash)


class TelegramAlerter:
    """Dispatches the security alert to a Telegram channel."""

    async def send(self, payload: dict[str, Any]) -> None:
        raise NotImplementedError

class HttpTelegramAlerter(TelegramAlerter):
    """Sends messages via the Telegram Bot API."""

    def __init__(
        self,
        bot_token: str,
        chat_id: str,
        api_base: str = "https://api.telegram.org",
        timeout: float = DEFAULT_TELEGRAM_TIMEOUT,
    ) -> None:
        if not bot_token:
            raise ValueError("telegram bot token must be set")
        if not chat_id:
            raise ValueError("telegram chat_id must be set")
        self.bot_token = bot_token
        self.chat_id = chat_id
        self.api_base = api_base.rstrip("/")
        self.timeout = timeout

    async def send(self, payload: dict[str, Any]) -> None:
        if httpx is None:
            raise RuntimeError("httpx is required for HttpTelegramAlerter")
        url = f"{self.api_base}/bot{self.bot_token}/sendMessage"
        message = render_telegram_message(payload)
        body = {
            "chat_id": self.chat_id,
            "text": message,
            "parse_mode": "Markdown",
            "disable_web_page_preview": True,
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            result = resp.json()
        if isinstance(result, dict) and not result.get("ok", False):
            raise RuntimeError(f"telegram alert rejected: {result!r}")


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


class FlashLoanCircuitBreaker:
    """Coordinates mempool monitoring, anomaly detection, pause execution
    and Telegram alerting.

    The pause call is issued immediately when an anomaly is detected in
    the current ledger window, and the alert is dispatched in the same
    coro so the payload carries the pause transaction hash.
    """

    def __init__(
        self,
        mempool: MempoolSource,
        pause_executor: PauseExecutor,
        alerter: TelegramAlerter,
        threshold: int = DEFAULT_SUSPICIOUS_THRESHOLD,
    ) -> None:
        self.mempool = mempool
        self.pause_executor = pause_executor
        self.alerter = alerter
        self.threshold = threshold
        # Per-ledger buffer of observed txs. Keyed by ledge so a
        # new ledger starts with a clean slate and old ledgers are evicted.
        self._ledger_buffer: dict[int, list[MempoolFlashLoanTx]] = {}
        self._last_ledger: Optional[int] = None
        self._triggered_ledgers: set[int] = set()

    def _record(self, tx: MempoolFlashLoanTx) -> AnomalyReport:
        bucket = self._ledger_buffer.setdefault(tx.ledger, [])
        bucket.append(tx)
        # Evict buffers from ledgers older than the current one to bound
        # memory and ensure the "same ledger window" semantics.
        if self._last_ledger is not None and tx.ledger > self._last_ledger:
            for old_ledger in list(self._ledger_buffer):
                if old_ledger < tx.ledger:
                    self._ledger_buffer.pop(old_ledger, None)
            self._last_ledger = tx.ledger
        elif self._last_ledger is None or tx.ledger > self._last_ledger:
            self._last_ledger = tx.ledger
        return detect_suspicious_flash_loans(bucket, tx.ledger, self.threshold)

    async def _handle_report(self, report: AnomalyReport) -> None:
        if not report.triggered:
            return
        if report.ledger in self._triggered_ledgers:
            # Already paused for this ledger; avoid duplicate pause calls.
            return
        self._triggered_ledgers.add(report.ledger)

        pause_tx_hash: Optional[str] = None
        pause_submitted_at: Optional[float] = None
        try:
            pause_tx_hash = await self.pause_executor.pause(report)
            pause_submitted_at = time.time()
            logger.critical(
                "emergency pause submitted for ledger %s (tx=%s)",
                report.ledger,
                pause_tx_hash,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("emergency pause failed for ledger %s: %s", report.ledger, exc)

        payload = build_telegram_payload(report, pause_tx_hash, pause_submitted_at)
        try:
            await self.alerter.send(payload)
        except Exception as exc:  # noqa: BLE001
            logger.exception("telegram alert dispatch failed: %s", exc)

    async def run(self) -> None:
        logger.info("flash loan circuit breaker started")
        async for tx in self.mempool.stream():
            report = self._record(tx)
            await self._handle_report(report)


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"environment variable {name} is required")
    return value


def build_breaker_from_env() -> FlashLoanCircuitBreaker:
    """Constructs the breaker from environment configuration."""
    threshold = int(os.environ.get("FLASH_LOAN_SUSPICIOUS_THRESHOLD", str(DEFAULT_SUSPICIOUS_THRESHOLD)))
    mempool = HttpMempoolSource(
        endpoint=_required_env("MEMPOOL_RPC_ENDPOINT"),
        poll_interval_seconds=float(
            os.environ.get("MEMPOOL_POLL_INTERVAL_SECONDS", str(DEFAULT_POLL_INTERVAL_SECONDS))
        ),
    )
    pause_executor = HttpPauseExecutor(
        rpc_endpoint=_required_env("PAUSE_RPC_ENDPOINT"),
        contract_address=_required_env("PAUSE_CONTRACT_ADDRESS"),
        auth_token=os.environ.get("PAUSE_RPC_AUTH_TOKEN"),
    )
    alerter = HttpTelegramAlerter(
        bot_token=_required_env("TELEGRAM_BOT_TOKEN"),
        chat_id=_required_env("TELEGRAM_SECURITY_CHAT_ID"),
    )
    return FlashLoanCircuitBreaker(mempool, pause_executor, alerter, threshold)


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    breaker = build_breaker_from_env()
    await breaker.run()


if __name__ == "__main__":
    asyncio.run(main())
