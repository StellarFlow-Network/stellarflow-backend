from app.services.indexer_reconciliation import (
    _classify_event_payloads,
    _is_indexed_event,
    _payload_hash,
    _rpc_event_hash,
)


def test_rpc_event_hash_matches_listener_hash_format():
    event = {"txHash": "abc", "id": "1200-4-3"}

    assert _rpc_event_hash(1200, event, 0) == _rpc_event_hash(1200, event, 99)


def test_audit_uses_the_listener_topic_allowlist():
    assert _is_indexed_event({"topic": ["Swap"]})
    assert not _is_indexed_event({"topic": ["UntrackedEvent"]})


def test_payload_hash_ignores_rpc_cursor_metadata_but_tracks_event_values():
    indexed = {"ledger": 100, "txHash": "abc", "topic": ["Swap"], "data": "value"}
    rpc = {
        "ledger": 100,
        "txHash": "abc",
        "topic": ["Swap"],
        "value": "value",
        "id": "100-1-2",
    }
    corrupted = {**rpc, "value": "different"}

    assert _payload_hash(indexed) == _payload_hash(rpc)
    assert _payload_hash(indexed) != _payload_hash(corrupted)


def test_event_comparison_identifies_missing_extra_and_corrupted_rows():
    status, missing, unexpected, corrupted = _classify_event_payloads(
        {"indexed": "bad", "extra": "hash"},
        {"indexed": "good", "missing": "hash"},
    )

    assert status == "MISMATCH"
    assert missing == ["missing"]
    assert unexpected == ["extra"]
    assert corrupted == ["indexed"]