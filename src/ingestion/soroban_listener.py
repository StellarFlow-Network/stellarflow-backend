import asyncio
import json
import logging
import hashlib
import base64
import os
from collections import defaultdict, deque
from typing import Optional, Set
import websockets
import httpx
from app.tasks.ingestion_tasks import dispatch_backfill_job
from app.db.session import async_session_factory
from app.models.events import LedgerEvent

logger = logging.getLogger(__name__)

def _compute_xdr_symbol_hash(symbol: str) -> str:
    """Computes the SHA-256 hash of the XDR representation of a symbol."""
    encoded = symbol.encode("utf-8")
    length = len(encoded)
    pad_len = (4 - (length % 4)) % 4
    xdr_bytes = b'\x00\x00\x00\x0e' + length.to_bytes(4, "big") + encoded + b'\x00' * pad_len
    return hashlib.sha256(xdr_bytes).hexdigest()

class SorobanListener:
    """Live WebSocket stream listener with sequence gap detection and duplicate prevention."""

    ALLOWED_TOPIC_HASHES: Set[str] = {
        _compute_xdr_symbol_hash("Swap"),
        _compute_xdr_symbol_hash("swap"),
        _compute_xdr_symbol_hash("Deposit"),
        _compute_xdr_symbol_hash("deposit"),
        _compute_xdr_symbol_hash("Liquidation"),
        _compute_xdr_symbol_hash("liquidation"),
        _compute_xdr_symbol_hash("GovernanceVoted"),
        hashlib.sha256(b"Swap").hexdigest(),
        hashlib.sha256(b"swap").hexdigest(),
        hashlib.sha256(b"Deposit").hexdigest(),
        hashlib.sha256(b"deposit").hexdigest(),
        hashlib.sha256(b"Liquidation").hexdigest(),
        hashlib.sha256(b"liquidation").hexdigest(),
        hashlib.sha256(b"GovernanceVoted").hexdigest(),
    }

    FLASH_LOAN_TOPIC_HASHES: Set[str] = {
        _compute_xdr_symbol_hash("FlashLoan"),
        _compute_xdr_symbol_hash("flash_loan"),
        _compute_xdr_symbol_hash("flashloan"),
        hashlib.sha256(b"FlashLoan").hexdigest(),
        hashlib.sha256(b"flash_loan").hexdigest(),
        hashlib.sha256(b"flashloan").hexdigest(),
    }

    SUSPICIOUS_FLASH_LOAN_THRESHOLD: int = 3

    def __init__(self, ws_url: str, rpc_url: str):
        self.ws_url = ws_url
        self.rpc_url = rpc_url
        self.last_ingested_sequence: Optional[int] = None
        self.is_running: bool = False
        # Per-ledger tracking of suspicious flash loan activity for circuit breaker
        self._flash_loan_ledger: Optional[int] = None
        self._flash_loan_events: deque = deque()
        self._paused_ledgers: Set[int] = set()
        self._pause_contract_id: Optional[str] = os.getenv("EMERGENCY_PAUSE_CONTRACT_ID")
        self._pause_admin_secret: Optional[str] = os.getenv("EMERGENCY_PAUSE_ADMIN_SECRET")
        self._telegram_bot_token: Optional[str] = os.getenv("SECURITY_TELEGRAM_BOT_TOKEN")
        self._telegram_chat_id: Optional[str] = os.getenv("SECURITY_TELEGRAM_CHAT_ID")

    @staticmethod
    def generate_event_hash(ledger_seq: int, tx_hash: str, event_index: int) -> str:
        """Generates a deterministic unique hash constraint to prevent duplicate ingestion."""
        raw_key = f"{ledger_seq}:{tx_hash}:{event_index}"
        return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()

    async def start(self):
        """Main listening loop with auto-reconnect and gap detection."""
        self.is_running = True
        while self.is_running:
            try:
                async with websockets.connect(self.ws_url) as ws:
                    logger.info("Connected to Soroban RPC WebSocket stream.")
                    await self._subscribe(ws)

                    async for message in ws:
                        await self.handle_message(message)

            except (websockets.ConnectionClosed, Exception) as e:
                logger.warning(f"Soroban WebSocket connection lost: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5)

    async def _subscribe(self, ws):
        """Sends subscription request to Soroban WebSocket RPC."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "subscribe",
            "params": {"type": "events"},
        }
        await ws.send(json.dumps(payload))

    async def handle_message(self, raw_message: str):
        """Parses incoming event, checks for sequence gaps, and ingests data."""
        try:
            data = json.loads(raw_message)
            event_data = data.get("result")
            if not event_data or "ledger" not in event_data:
                return

            topics = event_data.get("topic") or event_data.get("topics") or []
            if not isinstance(topics, list):
                topics = [topics]

            # Detect flash loan pattern BEFORE topic allow-list filter so we never miss anomalies
            await self._detect_flash_loan_anomaly(event_data)

            # Pre-filter using binary topic hash matching
            if topics:
                topic_matched = False
                for t in topics:
                    if not isinstance(t, str):
                        continue
                    try:
                        if t.startswith("A") or len(t) > 32:
                            raw_bytes = base64.b64decode(t)
                        else:
                            raw_bytes = t.encode("utf-8")
                        
                        t_hash = hashlib.sha256(raw_bytes).hexdigest()
                        if t_hash in self.ALLOWED_TOPIC_HASHES:
                            topic_matched = True
                            break
                    except Exception:
                        pass
                
                if not topic_matched:
                    return

            current_sequence = int(event_data["ledger"])

            # 1. Detect Sequence Gap
            if self.last_ingested_sequence is not None:
                gap = current_sequence - self.last_ingested_sequence
                if gap > 1:
                    missing_start = self.last_ingested_sequence + 1
                    missing_end = current_sequence - 1
                    logger.warning(
                        f"🚀 Sequence gap detected! Missing ledgers [{missing_start} - {missing_end}]. Triggering Celery backfill..."
                    )
                    # Dispatch async backfill task via Celery
                    dispatch_backfill_job.delay(missing_start, missing_end, self.rpc_url)

            # 2. Process & Ingest Current Event
            await self._save_event(event_data, current_sequence)
            self.last_ingested_sequence = current_sequence

        except Exception as e:
            logger.error(f"Error processing WebSocket message: {e}")

    @staticmethod
    def _topic_matches(topic: str, allowed: Set[str]) -> bool:
        """Checks whether a raw topic string matches any hash in the allowed set."""
        if not isinstance(topic, str):
            return False
        try:
            if topic.startswith("A") or len(topic) > 32:
                raw_bytes = base64.b64decode(topic)
            else:
                raw_bytes = topic.encode("utf-8")
            return hashlib.sha256(raw_bytes).hexdigest() in allowed
        except Exception:
            return False

    async def _detect_flash_loan_anomaly(self, event_data: dict):
        """Tracks flash loan events per ledger and triggers circuit breaker on threshold breach."""
        try:
            sequence = int(event_data["ledger"])
        except (KeyError, TypeError, ValueError):
            return

        topics = event_data.get("topic") or event_data.get("topics") or []
        if not isinstance(topics, list):
            topics = [topics]

        is_flash_loan = any(
            self._topic_matches(t, self.FLASH_LOAN_TOPIC_HASHES) for t in topics
        )
        if not is_flash_loan:
            return

        # Reset window when ledger advances
        if self._flash_loan_ledger != sequence:
            self._flash_loan_ledger = sequence
            self._flash_loan_events = deque()

        tx_hash = event_data.get("txHash", "0x0")
        pool_target = self._extract_pool_target(event_data)
        self._flash_loan_events.append(
            {"tx_hash": tx_hash, "pool": pool_target, "ledger": sequence}
        )

        if (
            len(self._flash_loan_events) > self.SUSPICIOUS_FLASH_LOAN_THRESHOLD
            and sequence not in self._paused_ledgers
        ):
            self._paused_ledgers.add(sequence)
            logger.critical(
                f"🚠 Flash loan anomaly detected on ledger {sequence}: "
                f"{len(self._flash_loan_events)} suspicious loans. Triggering emergency pause."
            )
            # Fire pause + alert concurrently so pause submits within same ledger window
            await asyncio.gather(
                self._trigger_emergency_pause(sequence),
                self._dispatch_security_alert(sequence, list(self._flash_loan_events)),
                return_exceptions=True,
            )

    @staticmethod
    def _extract_pool_target(event_data: dict) -> str:
        """Best-effort extraction of the pool/contract target from an event payload."""
        for key in ("contractId", "contract_id", "pool", "poolAddress", "address"):
            value = event_data.get(key)
            if isinstance(value, str) and value:
                return value
        value = event_data.get("value")
        if isinstance(value, dict):
            for key in ("contractId", "contract_id", "pool", "poolAddress", "address"):
                v = value.get(key)
                if isinstance(v, str) and v:
                    return v
        return "unknown"

    async def _trigger_emergency_pause(self, sequence: int):
        """Invokes the emergency pause entrypoint on the target contract via Soroban RPC."""
        if not self._pause_contract_id or not self._pause_admin_secret:
            logger.error(
                "Emergency pause skipped: EMERGENCY_PAUSE_CONTRACT_ID / "
                "EMERGENCY_PAUSE_ADMIN_SECRET not configured."
            )
            return
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "invokeContract",
            "params": {
                "contractId": self._pause_contract_id,
                "function": "emergency_pause",
                "args": [{"ledger": sequence}],
                "auth": self._pause_admin_secret,
            },
        }
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.post(self.rpc_url, json=payload)
                resp.raise_for_status()
                logger.critical(
                    f"🛄 Emergency pause submitted for ledger {sequence}: {resp.text}"
                )
        except Exception as e:
            logger.error(f"Emergency pause invocation failed for ledger {sequence}: {e}")

    async def _dispatch_security_alert(self, sequence: int, events: list):
        """Sends a structured alert to the security team Telegram channel."""
        if not self._telegram_bot_token or not self._telegram_chat_id:
            logger.error(
                "Security alert skipped: SECURITY_TELEGRAM_BOT_TOKEN / "
                "SECURITY_TELEGRAM_CHAT_ID not configured."
            )
            return
        tx_hashes = [e["tx_hash"] for e in events]
        pool_targets = sorted({e["pool"] for e in events})
        message = (
            f"🚠 FLASH LOAN ANOMALY — ledger {sequence}\n"
            f"Suspicious loans: {len(events)}\n"
            f"Tx hashes: {', '.join(tx_hashes)}\n"
            f"Pool targets: {', '.join(pool_targets)}\n"
            f"Action: emergency pause invoked."
        )
        url = f"https://api.telegram.org/bot{self._telegram_bot_token}/sendMessage"
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.post(
                    url,
                    json={"chat_id": self._telegram_chat_id, "text": message},
                )
                resp.raise_for_status()
                logger.info(f"Security alert dispatched for ledger {sequence}.")
        except Exception as e:
            logger.error(f"Security alert dispatch failed for ledger {sequence}: {e}")

    async def _save_event(self, event_data: dict, sequence: int):
        """Persists a ledger event with a deterministic duplicate prevention hash."""
        tx_hash = event_data.get("txHash", "0x0")
        event_index = int(event_data.get("eventIndex", 0))
        event_hash = self.generate_event_hash(sequence, tx_hash, event_index)
        async with async_session_factory() as session:
            event = LedgerEvent(
                event_hash=event_hash,
                ledger_sequence=sequence,
                tx_hash=tx_hash,
                payload=event_data,
            )
            session.merge(event)
            await session.commit()
