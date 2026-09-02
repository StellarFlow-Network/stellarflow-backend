"""horizon_parser.py — extraction of structured ledger events from Horizon RPC.

The Horizon ledger-event ingestion worker (``horizon_worker.py``) needs a
uniform, downstream-friendly event shape regardless of which Horizon / Stellar
RPC record type arrives (ledger summaries, transaction records with raw XDR,
or Soroban contract-event notifications).  This module normalises those
payloads and extracts:

* the ledger sequence / ``sequence_number`` (idempotency key for the
  ``stream_consumer`` consumer group),
* the set of transaction hashes,
* operation logs (from Horizon JSON ``operations`` arrays or by decoding the
  transaction ``envelope_xdr`` via :mod:`ingestion.horizon_xdr`),
* Soroban contract events (topics + data),

and emits a single structured JSON event ready to be pushed into a Redis
Stream for the downstream consumer group (``src/services/stream_consumer.py``).
"""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union

from ingestion.horizon_xdr import XdrDecodeError, parse_transaction_envelope_bytes

__all__ = [
    "event_id",
    "extract_ledger_sequence",
    "extract_closed_at",
    "extract_transaction_hashes",
    "extract_operation_logs",
    "extract_contract_events",
    "extract_ledger_event",
    "normalize_ledger_message",
    "classify_record",
]

_JSON_STRING = Union[str, bytes, bytearray, memoryview]

_HASH_SEED = "L"

# JSON-RPC subscriptions answered with an ``id`` + ``result`` acknowledgement
# contain no ledger data; these keys signal an actual streamed notification.
_NOTIFICATION_HINTS = ("ledger", "sequence", "txHash", "transactionHash", "hash", "closedAt", "type")


def event_id(ledger_sequence: int, tx_hash: Optional[str], event_index: int) -> str:
    """Deterministic dedup key mirroring `soroban_listener.generate_event_hash`."""
    raw = f"{_HASH_SEED}:{ledger_sequence}:{tx_hash or '0x0'}:{event_index}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _decode_json(raw: _JSON_STRING) -> Any:
    if isinstance(raw, str):
        return json.loads(raw)
    return json.loads(bytes(raw).decode("utf-8"))


def _first(mapping: Dict[str, Any], keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return default


# ---------------------------------------------------------------------------
# JSON-RPC envelope unwrapping
# ---------------------------------------------------------------------------


def normalize_ledger_message(raw: _JSON_STRING) -> Optional[Dict[str, Any]]:
    """Parse *raw* and unwrap JSON-RPC notification layers.

    Horizon / Stellar RPC deliver subscription updates either as bare
    records or wrapped in a ``jsonrpc`` notification whose payload lives
    under ``params.result``.  This helper returns the innermost record dict
    or ``None`` for acknowledgements / non-record frames.
    """
    if isinstance(raw, dict):
        message = raw
    else:
        try:
            message = _decode_json(raw)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            return None
        if not isinstance(message, dict):
            return None

    candidate: Any = message

    # Notification: {"jsonrpc": ..., "method": "subscribe", "params": {"result": {...}, "subscription": N}}
    params = message.get("params")
    if isinstance(params, dict) and isinstance(params.get("result"), dict):
        candidate = params["result"]
    else:
        result = message.get("result")
        # Response frames with an id (subscription acknowledgements) carry a
        # result like {"subscription": N} — not a ledger record.
        if isinstance(result, dict):
            candidate = result

    if not isinstance(candidate, dict):
        return None

    if not any(hint in candidate for hint in _NOTIFICATION_HINTS):
        return None
    return candidate


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------


def classify_record(record: Dict[str, Any]) -> str:
    """Return ``"ledger"``, ``"transaction"``, ``"event"`` or ``"unknown"``."""
    record_type = _first(record, ("type", "record_type"))
    if record_type is not None:
        return str(record_type).lower()
    if "transactions" in record or "envelope_xdr" in record or "envelopeXdr" in record:
        return "transaction"
    if "contract_events" in record or ("events" in record and isinstance(record.get("events"), list)):
        return "event"
    if any(k in record for k in ("ledger", "sequence", "hash", "closedAt", "closed_at")):
        return "ledger"
    return "unknown"


def extract_ledger_sequence(record: Dict[str, Any]) -> Optional[int]:
    """Return the ledger sequence embedded in *record*, if any."""
    for key, fallback in (("ledger_sequence", "ledger"), ("ledger", "sequence")):
        value = record.get(key)
        if value is None:
            value = record.get(fallback)
        if value is None:
            continue
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed
    return None


def extract_closed_at(record: Dict[str, Any]) -> Optional[str]:
    """Return the ledger close timestamp as an ISO-8601 UTC string."""
    value = _first(record, ("ledgerClosedAt", "ledger_close_time", "closed_at", "closedAt", "created_at"))
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        except (OSError, ValueError, OverflowError):
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
        except ValueError:
            return value
    return None


def extract_transaction_hashes(record: Dict[str, Any]) -> List[str]:
    """Collect every transaction hash referenced by *record*.

    Recognised sources: ``hash``, ``txHash``, ``transactionHash`` on the
    record itself, a nested ``transactions`` list, or decoded-envelope XDR.
    """
    hashes: List[str] = []
    seen = set()

    def _add(value: Any) -> None:
        if isinstance(value, str) and value and value not in seen:
            seen.add(value)
            hashes.append(value)

    for key in ("transactionHash", "tx_hash", "txHash", "hash"):
        _add(record.get(key))

    transactions = record.get("transactions")
    if isinstance(transactions, list):
        for tx in transactions:
            if isinstance(tx, dict):
                for key in ("hash", "transactionHash", "txHash"):
                    _add(tx.get(key))
            elif isinstance(tx, str):
                _add(tx)

    return hashes


def _decode_envelope(envelope_xdr: str) -> Optional[Dict[str, Any]]:
    try:
        raw = base64.b64decode(envelope_xdr, validate=True)
        return parse_transaction_envelope_bytes(raw)
    except (XdrDecodeError, ValueError):  # covers binascii.Error (subclass of ValueError)
        return None


def extract_operation_logs(
    record: Dict[str, Any],
    *,
    decode_xdr: bool = True,
) -> List[Dict[str, Any]]:
    """Extract operation logs from a transaction record.

    When the record carries a Horizon JSON ``operations`` array those logs
    are used as-is (normalised to a uniform key set).  Otherwise — or when
    the array is absent — the transaction ``envelope_xdr`` is decoded with
    :func:`ingestion.horizon_xdr.parse_transaction_envelope_bytes` and a log
    entry is produced per decoded operation.

    Parameters
    ----------
    record:
        Normalised Horizon / Stellar RPC record.
    decode_xdr:
        When ``False`` the XDR fallback path is skipped.  Defaults to
        ``True``.

    Returns
    -------
    list of dict
        Each log entry carries at least ``index`` and ``type_name``.
    """
    operations = record.get("operations")
    if isinstance(operations, list) and operations:
        logs: List[Dict[str, Any]] = []
        for index, op in enumerate(operations):
            if not isinstance(op, dict):
                continue
            log: Dict[str, Any] = {
                "index": index,
                "type_name": str(op.get("type") or op.get("type_name") or "").upper() or "UNKNOWN",
                "operation_type": op.get("type") or op.get("type_name"),
            }
            source_account = op.get("source_account") or op.get("from")
            if isinstance(source_account, dict):
                source_account = source_account.get("address")
            if source_account is not None:
                log["source_account"] = source_account
            for key in ("amount", "asset", "destination", "name", "value", "starting_balance", "bump_to"):
                if key in op:
                    log[key] = op[key]
            logs.append(log)
        return logs

    envelope = _first(record, ("envelope_xdr", "envelopeXdr"))
    if not envelope or not decode_xdr:
        return []

    parsed = _decode_envelope(envelope)
    if parsed is None:
        return []

    # Fee-bump envelopes wrap the actual operations inside the inner
    # transaction envelope.
    if parsed.get("envelope_type") == "ENVELOPE_TYPE_TX_FEE_BUMP":
        parsed = parsed.get("inner_transaction") or parsed

    logs = []
    tx_sequence = parsed.get("sequence")
    for index, op in enumerate(parsed.get("operations", [])):
        log: Dict[str, Any] = {
            "index": index,
            "type_name": op.get("type_name", "UNKNOWN"),
            "operation_type": op.get("type"),
        }
        source_account = op.get("source_account")
        if isinstance(source_account, dict):
            source_account = source_account.get("address")
        if source_account is not None:
            log["source_account"] = source_account
        for key in ("amount", "asset", "destination", "name", "value", "starting_balance", "bump_to"):
            if key in op:
                log[key] = op[key]
        if tx_sequence is not None:
            log["tx_sequence"] = tx_sequence
        logs.append(log)
    return logs


def extract_contract_events(record: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract Soroban contract events from an RPC ``events`` notification.

    Returns
    -------
    list of dict
        Uniform ``{type, contract_id, topic, data, tx_hash, event_index}``
        entries.  Empty when the record carries no contract events.
    """
    events = record.get("contract_events") or record.get("events")
    if not isinstance(events, list):
        return []

    ledger_sequence = extract_ledger_sequence(record)
    tx_hash = _first(record, ("transactionHash", "tx_hash", "txHash"))
    extracted: List[Dict[str, Any]] = []

    for index, event in enumerate(events):
        if not isinstance(event, dict):
            continue

        contract_id = _first(event, ("contract_id", "contractId", "contract"))
        topics = event.get("topic") or event.get("topics") or []
        data = event.get("value") if "value" in event else (event.get("data") or {})

        ev_tx_hash = _first(event, ("tx_hash", "txHash", "transactionHash")) or tx_hash
        nifty: Dict[str, Any] = {
            "type": str(event.get("type") or "contract").lower(),
            "contract_id": str(contract_id) if contract_id else None,
            "topic": topics if isinstance(topics, list) else [topics],
            "data": data,
            "tx_hash": str(ev_tx_hash) if ev_tx_hash else None,
            "event_index": index,
            "ledger_sequence": ledger_sequence,
        }
        if ev_tx_hash:
            nifty["id"] = event_id(ledger_sequence or 0, str(ev_tx_hash), index)
        extracted.append(nifty)
    return extracted


# ---------------------------------------------------------------------------
# Primary entry point
# ---------------------------------------------------------------------------


def extract_ledger_event(raw: Union[_JSON_STRING, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Normalise *raw* into a single structured ledger event.

    Parameters
    ----------
    raw:
        Raw JSON text (WebSocket frame payload) or an already-decoded dict.

    Returns
    -------
    dict or None
        A JSON-serialisable event with a stable ``id``, a numeric
        ``sequence_number`` used by the downstream consumer group, the full
        extraction (transaction hashes, operation logs, contract events) and
        the original ``payload``.  ``None`` for acknowledgements and frames
        that contain no ledger data.
    """
    record = normalize_ledger_message(raw)
    if record is None:
        return None

    ledger_sequence = extract_ledger_sequence(record)
    if ledger_sequence is None:
        return None

    tx_hashes = extract_transaction_hashes(record)
    operation_logs = extract_operation_logs(record)
    contract_events = extract_contract_events(record)
    record_type = classify_record(record)

    tx_hash = contract_events[0]["tx_hash"] if contract_events and contract_events[0].get("tx_hash") else (tx_hashes[0] if tx_hashes else None)

    return {
        "id": event_id(ledger_sequence, tx_hash, len(operation_logs) + len(contract_events)),
        "sequence_number": ledger_sequence,
        "ledger_sequence": ledger_sequence,
        "closed_at": extract_closed_at(record),
        "event_type": record_type,
        "transaction_hashes": tx_hashes,
        "operation_logs": operation_logs,
        "contract_events": contract_events,
        "source": "horizon",
        "received_at": datetime.now(timezone.utc).isoformat(),
        "payload": record,
    }