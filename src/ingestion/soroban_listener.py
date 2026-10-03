import asyncio
import json
import logging
import hashlib
import base64
from typing import Optional, Set
import websockets
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

    def __init__(self, ws_url: str, rpc_url: str):
        self.ws_url = ws_url
        self.rpc_url = rpc_url
        self.last_ingested_sequence: Optional[int] = None
        self.is_running: bool = False

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
                        f"🚨 Sequence gap detected! Missing ledgers [{missing_start} - {missing_end}]. Triggering Celery backfill..."
                    )
                    # Dispatch async backfill task via Celery
                    dispatch_backfill_job.delay(missing_start, missing_end, self.rpc_url)

            # 2. Process & Ingest Current Event
            await self._save_event(event_data, current_sequence)
            self.last_ingested_sequence = current_sequence

        except Exception as e:
            logger.error(f"Error processing WebSocket message: {e}")

    async def _save_event(self, event_data: dict, sequence: int):
        """Saves event record using unique event_hash constraint to prevent duplicate insertion."""
        tx_hash = event_data.get("txHash", "0x0")
        event_idx = event_data.get("index", 0)
        event_hash = self.generate_event_hash(sequence, tx_hash, event_idx)

        async with async_session_factory() as session:
            # PostgreSQL ON CONFLICT DO NOTHING using event_hash
            event_record = LedgerEvent(
                event_hash=event_hash,
                ledger_sequence=sequence,
                tx_hash=tx_hash,
                event_type=event_data.get("topic", "unknown"),
                payload=event_data,
            )
            session.add(event_record)
            try:
                await session.commit()
            except Exception:
                await session.rollback()  # Ignore duplicate constraint collisions cleanly