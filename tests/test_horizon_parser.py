"""Tests for src/ingestion/horizon_parser.py."""

from __future__ import annotations

import base64
import json

import pytest

from _horizon_xdr_encoder import build_v1_envelope
from ingestion.horizon_parser import (
    classify_record,
    event_id,
    extract_closed_at,
    extract_contract_events,
    extract_ledger_event,
    extract_ledger_sequence,
    extract_operation_logs,
    extract_transaction_hashes,
    normalize_ledger_message,
)

_ENVELOPE_B64 = base64.b64encode(
    build_v1_envelope(
        [
            {"type": 1, "src": b"\x12" * 32, "dest": b"\x44" * 32, "code": "NGN", "issuer": b"\x55" * 32, "amount": 25_000_000},
        ],
        source=b"\x22" * 32,
        fee=100,
        seq=55_000_000,
        memo=(1, "SF-TEST"),
    )
).decode()


def _notification(record: dict) -> dict:
    return {
        "jsonrpc": "2.0",
        "method": "subscribe",
        "params": {"subscription": 4, "result": record},
    }


def _transaction_record() -> dict:
    return _notification(
        {
            "type": "transaction",
            "ledger": 12345,
            "transactionHash": "0xdeadbeef",
            "envelopeXdr": _ENVELOPE_B64,
            "closedAt": "2026-08-30T12:00:00Z",
        }
    )


# ---------------------------------------------------------------------------
# normalize_ledger_message
# ---------------------------------------------------------------------------


def test_unwraps_jsonrpc_notification():
    record = _transaction_record()
    assert normalize_ledger_message(record)["transactionHash"] == "0xdeadbeef"


def test_unwraps_json_string():
    raw = json.dumps(_transaction_record())
    assert normalize_ledger_message(raw)["ledger"] == 12345


def test_acknowledgement_frame_returns_none():
    ack = {"jsonrpc": "2.0", "id": 0, "result": {"subscription": 1}}
    assert normalize_ledger_message(ack) is None
    assert normalize_ledger_message(json.dumps(ack)) is None


def test_bare_record_passthrough():
    bare = {"ledger": 1, "hash": "abc"}
    assert normalize_ledger_message(bare) == bare


def test_non_json_returns_none():
    assert normalize_ledger_message(b"\x00\xff not json") is None


def test_empty_dict_returns_none():
    assert normalize_ledger_message({}) is None


def test_message_without_ledger_hints_returns_none():
    assert normalize_ledger_message({"jsonrpc": "2.0", "method": "m", "params": {"result": {"foo": 1}}}) is None


# ---------------------------------------------------------------------------
# Positional extractions
# ---------------------------------------------------------------------------


def test_extract_ledger_sequence_sources():
    assert extract_ledger_sequence({"ledger": 9}) == 9
    assert extract_ledger_sequence({"sequence": "8"}) == 8
    assert extract_ledger_sequence({"ledger_sequence": 123}) == 123
    assert extract_ledger_sequence({}) is None


def test_extract_closed_at_iso_and_epoch():
    assert extract_closed_at({"closedAt": "2026-08-30T12:00:00Z"}).startswith("2026-08-30T12:00:00")
    assert extract_closed_at({"ledger_close_time": 1_700_000_000.0}).startswith("2023-11-14")
    assert extract_closed_at({}) is None


def test_extract_transaction_hashes():
    assert extract_transaction_hashes({"txHash": "a", "transactionHash": "b", "hash": "c"}) == ["b", "a", "c"]
    assert extract_transaction_hashes(
        {"hash": "r", "transactions": [{"hash": "t1"}, {"transactionHash": "t2"}, "plain"]}
    ) == ["r", "t1", "t2", "plain"]
    assert extract_transaction_hashes({}) == []


def test_classify_record():
    assert classify_record({"type": "event"}) == "event"
    assert classify_record({"type": "ledger"}) == "ledger"
    assert classify_record({"envelope_xdr": "x"}) == "transaction"
    assert classify_record({"contract_events": []}) == "event"
    assert classify_record({"ledger": 1}) == "ledger"
    assert classify_record({"foo": 1}) == "unknown"


# ---------------------------------------------------------------------------
# Operation logs
# ---------------------------------------------------------------------------


def test_operation_logs_from_json_operations():
    record = {"operations": [{"type": "payment", "source_account": "GAA", "amount": 5}]}
    logs = extract_operation_logs(record)
    assert logs == [{
        "index": 0,
        "type_name": "PAYMENT",
        "operation_type": "payment",
        "source_account": "GAA",
        "amount": 5,
    }]


def test_operation_logs_from_envelope_xdr():
    record = {"type": "transaction", "ledger": 12345, "envelopeXdr": _ENVELOPE_B64}
    logs = extract_operation_logs(record)
    assert len(logs) == 1
    assert logs[0]["type_name"] == "PAYMENT"
    assert logs[0]["amount"] == 25_000_000
    assert logs[0]["tx_sequence"] == 55_000_000


def test_operation_logs_skips_when_no_xdr_and_no_operations():
    assert extract_operation_logs({"ledger": 1}) == []


def test_operation_logs_skips_invalid_xdr():
    assert extract_operation_logs({"ledger": 1, "envelopeXdr": "@@@@"}) == []


# ---------------------------------------------------------------------------
# Contract events
# ---------------------------------------------------------------------------


def test_extract_contract_events_from_rpc_events():
    record = {
        "type": "event",
        "ledger": 700,
        "txHash": "0xabc",
        "events": [
            {
                "contractId": "C123",
                "type": "contract",
                "topic": ["Swap", "scalar"],
                "value": {"amount": 10},
            }
        ],
    }
    events = extract_contract_events(record)
    assert len(events) == 1
    ev = events[0]
    assert ev["contract_id"] == "C123"
    assert ev["topic"] == ["Swap", "scalar"]
    assert ev["data"] == {"amount": 10}
    assert ev["tx_hash"] == "0xabc"
    assert ev["ledger_sequence"] == 700
    assert ev["id"]


def test_extract_contract_events_absent_returns_empty():
    assert extract_contract_events({"ledger": 1}) == []


# ---------------------------------------------------------------------------
# End-to-end extract_ledger_event
# ---------------------------------------------------------------------------


def test_extract_ledger_event_from_transaction():
    event = extract_ledger_event(_transaction_record())
    assert event is not None
    assert event["sequence_number"] == 12345
    assert event["ledger_sequence"] == 12345
    assert event["event_type"] == "transaction"
    assert event["transaction_hashes"] == ["0xdeadbeef"]
    assert event["operation_logs"][0]["type_name"] == "PAYMENT"
    assert event["contract_events"] == []
    assert event["source"] == "horizon"
    assert event["id"]
    assert event["closed_at"].startswith("2026-08-30")
    assert event["payload"]["ledger"] == 12345


def test_extract_ledger_event_from_ack_returns_none():
    assert extract_ledger_event({"jsonrpc": "2.0", "id": 1, "result": {"subscription": 4}}) is None


def test_extract_ledger_event_ignores_records_without_sequence():
    assert extract_ledger_event({"type": "ledger", "hash": "abc"}) is None


def test_extract_ledger_event_is_json_serialisable():
    event = extract_ledger_event(_transaction_record())
    json.dumps(event)  # must not raise


def test_event_id_is_deterministic_and_seeded():
    a = event_id(1, "0x1", 0)
    b = event_id(1, "0x1", 0)
    c = event_id(1, "0x2", 0)
    assert a == b
    assert a != c
    assert len(a) == 64


def test_extract_ledger_event_from_ledger_record():
    event = extract_ledger_event(
        _notification({"type": "ledger", "ledger": 4242, "hash": "dead", "closedAt": "2026-08-30T00:00:00Z"})
    )
    assert event is not None
    assert event["sequence_number"] == 4242
    assert event["event_type"] == "ledger"


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__]))