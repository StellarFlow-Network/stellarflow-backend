"""Compare indexed ledger events with Soroban RPC and repair missing rows."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import random
from datetime import datetime, timezone
from typing import Any
from urllib.request import Request, urlopen

import asyncpg


_EVENT_TYPES = ["contract", "system", "diagnostic"]
_LEDGERS_PER_HOUR = 720
_SAMPLE_SIZE = 100
_ALLOWED_SYMBOLS = (
    "Swap",
    "swap",
    "Deposit",
    "deposit",
    "Liquidation",
    "liquidation",
    "GovernanceVoted",
)


def _xdr_symbol_hash(symbol: str) -> str:
    encoded = symbol.encode("utf-8")
    padding = (4 - len(encoded) % 4) % 4
    xdr = (
        b"\x00\x00\x00\x0e"
        + len(encoded).to_bytes(4, "big")
        + encoded
        + b"\x00" * padding
    )
    return hashlib.sha256(xdr).hexdigest()


_ALLOWED_TOPIC_HASHES = {
    hashlib.sha256(symbol.encode("utf-8")).hexdigest()
    for symbol in _ALLOWED_SYMBOLS
} | {_xdr_symbol_hash(symbol) for symbol in _ALLOWED_SYMBOLS}


def _is_indexed_event(event: dict[str, Any]) -> bool:
    topics = event.get("topic") or event.get("topics") or []
    if not topics:
        return True
    if not isinstance(topics, list):
        topics = [topics]
    for topic in topics:
        if not isinstance(topic, str):
            continue
        try:
            raw_topic = (
                base64.b64decode(topic)
                if topic.startswith("A") or len(topic) > 32
                else topic.encode("utf-8")
            )
        except Exception:
            continue
        if hashlib.sha256(raw_topic).hexdigest() in _ALLOWED_TOPIC_HASHES:
            return True
    return False


def _rpc_event_hash(ledger_sequence: int, event: dict[str, Any], ordinal: int) -> str:
    tx_hash = event.get("txHash") or "0x0"
    event_index_value = event.get("index")
    if event_index_value is None:
        event_id = str(event.get("id") or "")
        event_index_value = event_id.rsplit("-", 1)[-1]
    try:
        event_index = int(event_index_value)
    except (TypeError, ValueError):
        event_index = ordinal
    raw_key = f"{ledger_sequence}:{tx_hash}:{event_index}"
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def _payload_hash(payload: Any) -> str:
    if isinstance(payload, dict):
        value = payload["value"] if "value" in payload else payload.get("data")
        normalized = {
            "ledger": payload.get("ledger"),
            "txHash": payload.get("txHash") or payload.get("transactionHash"),
            "contractId": payload.get("contractId"),
            "topic": payload["topic"] if "topic" in payload else payload.get("topics"),
            "value": value,
        }
        payload = normalized
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), default=str
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _classify_event_sets(indexed: set[str], rpc: set[str]) -> tuple[str, list[str], list[str]]:
    missing = sorted(rpc - indexed)
    unexpected = sorted(indexed - rpc)
    if missing and unexpected:
        status = "MISMATCH"
    elif missing:
        status = "MISSING"
    elif unexpected:
        status = "EXTRA"
    else:
        status = "MATCH"
    return status, missing, unexpected


def _classify_event_payloads(
    indexed: dict[str, str], rpc: dict[str, str]
) -> tuple[str, list[str], list[str], list[str]]:
    status, missing, unexpected = _classify_event_sets(set(indexed), set(rpc))
    corrupted = sorted(
        event_hash
        for event_hash in indexed.keys() & rpc.keys()
        if indexed[event_hash] != rpc[event_hash]
    )
    if corrupted and status == "MATCH":
        status = "CORRUPTED"
    return status, missing, unexpected, corrupted


def _post_rpc(url: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = Request(url, data=body, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=10) as response:
        payload = json.loads(response.read())
    if payload.get("error"):
        raise RuntimeError(f"Soroban RPC {method} failed: {payload['error']}")
    return payload.get("result") or {}


async def _rpc_call(url: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_post_rpc, url, method, params)


async def _fetch_ledger_events(url: str, ledger_sequence: int) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    cursor: str | None = None
    while len(events) < 10000:
        params: dict[str, Any] = {
            "startLedger": ledger_sequence,
            "endLedger": ledger_sequence,
            "filters": [{"type": event_type} for event_type in _EVENT_TYPES],
            "limit": 1000,
        }
        if cursor:
            params["cursor"] = cursor
        result = await _rpc_call(url, "getEvents", params)
        page = result.get("events") or []
        if not page:
            break
        events.extend(page)
        next_cursor = result.get("cursor") or page[-1].get("id")
        if not next_cursor or next_cursor == cursor or len(page) < 1000:
            break
        cursor = str(next_cursor)
    return [event for event in events if _is_indexed_event(event)]


def _event_timestamp(event: dict[str, Any]) -> datetime:
    timestamp = event.get("ledgerClosedAt")
    if not timestamp:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


async def reindex_ledger_events(
    database_url: str,
    rpc_url: str,
    ledger_sequence: int,
) -> int:
    """Insert Soroban RPC events for one ledger, updating exact duplicates."""
    events = await _fetch_ledger_events(rpc_url, ledger_sequence)
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2)
    try:
        async with pool.acquire() as connection:
            async with connection.transaction():
                for ordinal, event in enumerate(events):
                    tx_hash = event.get("txHash") or "0x0"
                    event_hash = _rpc_event_hash(ledger_sequence, event, ordinal)
                    event_type = str(event.get("type") or "contract")
                    payload = json.dumps(event)
                    updated = await connection.execute(
                        """
                        UPDATE ledger_events
                        SET tx_hash = $1, event_type = $2, payload = $3::jsonb
                        WHERE ledger_sequence = $4 AND event_hash = $5
                        """,
                        tx_hash,
                        event_type,
                        payload,
                        ledger_sequence,
                        event_hash,
                    )
                    if updated == "UPDATE 0":
                        await connection.execute(
                            """
                            INSERT INTO ledger_events
                                (event_hash, ledger_sequence, tx_hash, event_type, payload, created_at)
                            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                            ON CONFLICT DO NOTHING
                            """,
                            event_hash,
                            ledger_sequence,
                            tx_hash,
                            event_type,
                            payload,
                            _event_timestamp(event),
                        )
        return len(events)
    finally:
        await pool.close()


async def audit_recent_ledgers(database_url: str | None = None) -> dict[str, Any]:
    """Sample 100 recent ledgers, compare event hashes, log, and enqueue repair."""
    db_url = database_url or os.getenv("DATABASE_URL") or os.getenv("DB_URL")
    rpc_url = os.getenv("SOROBAN_RPC_URL") or os.getenv("STELLAR_SOROBAN_RPC_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL or DB_URL must be configured")
    if not rpc_url:
        raise RuntimeError("SOROBAN_RPC_URL must be configured")

    latest_result = await _rpc_call(rpc_url, "getLatestLedger", {})
    latest_ledger = int(latest_result["sequence"])
    first_ledger = max(1, latest_ledger - _LEDGERS_PER_HOUR + 1)
    available = list(range(first_ledger, latest_ledger + 1))
    sampled_ledgers = sorted(random.sample(available, min(_SAMPLE_SIZE, len(available))))

    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4)
    try:
        async with pool.acquire() as connection:
            indexed_rows = await connection.fetch(
                """
                SELECT ledger_sequence, event_hash, payload
                FROM ledger_events
                WHERE ledger_sequence = ANY($1::int[])
                """,
                sampled_ledgers,
            )
            indexed_by_ledger: dict[int, dict[str, str]] = {
                seq: {} for seq in sampled_ledgers
            }
            for row in indexed_rows:
                raw_payload = row["payload"]
                payload = (
                    json.loads(raw_payload)
                    if isinstance(raw_payload, str)
                    else raw_payload
                )
                indexed_by_ledger[row["ledger_sequence"]][row["event_hash"]] = (
                    _payload_hash(payload)
                )

            semaphore = asyncio.Semaphore(10)

            async def fetch_one(sequence: int) -> tuple[int, list[dict[str, Any]]]:
                async with semaphore:
                    return sequence, await _fetch_ledger_events(rpc_url, sequence)

            rpc_results = await asyncio.gather(*(fetch_one(seq) for seq in sampled_ledgers))
            discrepancies: list[int] = []
            counts = {
                "matched": 0,
                "missing": 0,
                "extra": 0,
                "mismatch": 0,
                "corrupted": 0,
            }
            for sequence, events in rpc_results:
                expected = {
                    _rpc_event_hash(sequence, event, ordinal): _payload_hash(event)
                    for ordinal, event in enumerate(events)
                }
                indexed = indexed_by_ledger[sequence]
                status, missing, unexpected, corrupted = _classify_event_payloads(
                    indexed, expected
                )
                counts[status.lower()] += 1
                if corrupted:
                    counts["corrupted"] += 1
                details = {
                    "missing_event_hashes": missing[:500],
                    "unexpected_event_hashes": unexpected[:500],
                    "corrupted_event_hashes": corrupted[:500],
                }
                await connection.execute(
                    """
                    INSERT INTO indexer_audit_logs
                        (ledger_sequence, indexed_event_count, rpc_event_count, status, details)
                    VALUES ($1, $2, $3, $4, $5::jsonb)
                    """,
                    sequence,
                    len(indexed),
                    len(expected),
                    status,
                    json.dumps(details),
                )
                if missing or corrupted:
                    discrepancies.append(sequence)
    finally:
        await pool.close()

    if discrepancies:
        from app.tasks import reindex_ledger_events_task

        for sequence in discrepancies:
            reindex_ledger_events_task.delay(sequence)

    return {
        "sampled": len(sampled_ledgers),
        "latest_ledger": latest_ledger,
        "counts": counts,
        "reindex_jobs_queued": len(discrepancies),
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }