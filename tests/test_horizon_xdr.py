"""Tests for src/ingestion/horizon_xdr.py.

Synthetic transaction envelopes are crafted with the test-only writer in
``tests/_horizon_xdr_encoder.py`` and decoded back via the public API.
"""

from __future__ import annotations

import base64
import struct
import unittest

from _horizon_xdr_encoder import (
    build_fee_bump_envelope,
    build_v0_envelope,
    build_v1_envelope,
)
from ingestion.horizon_xdr import (
    XdrDecodeError,
    ed25519_account_id,
    parse_transaction_envelope,
    parse_transaction_envelope_bytes,
)

_PAYMENT_OPS = [
    {"type": 1, "src": b"\x12" * 32, "dest": b"\x44" * 32, "code": "NGN", "issuer": b"\x55" * 32, "amount": 25_000_000},
]


class TestStrKey(unittest.TestCase):
    def test_account_id_format(self):
        account = ed25519_account_id(b"\x11" * 32)
        self.assertTrue(account.startswith("G"))
        self.assertEqual(len(account), 56)

    def test_account_id_roundtrip(self):
        raw = b"\x11" * 32
        account = ed25519_account_id(raw)
        decoded = _decode_strkey(account)
        self.assertEqual(decoded, raw)

    def test_account_id_rejects_wrong_length(self):
        with self.assertRaises(ValueError):
            ed25519_account_id(b"\x00" * 31)


class TestXdrReaderErrors(unittest.TestCase):
    def test_empty_bytes_raises(self):
        with self.assertRaises(XdrDecodeError):
            parse_transaction_envelope_bytes(b"")

    def test_truncated_buffer_raises(self):
        payload = build_v1_envelope(_PAYMENT_OPS)
        with self.assertRaises(XdrDecodeError):
            parse_transaction_envelope_bytes(payload[:8])

    def test_trailing_truncation_degrades_gracefully(self):
        # Cutting into the trailing signature-count field must not hard-fail:
        # the decoder marks the envelope as partially decoded instead.
        payload = build_v1_envelope(_PAYMENT_OPS)
        parsed = parse_transaction_envelope_bytes(payload[: len(payload) - 3])
        self.assertIs(parsed["decode_complete"], False)
        self.assertEqual(parsed["operations"][0]["type_name"], "PAYMENT")

    def test_invalid_base64_raises(self):
        with self.assertRaises(XdrDecodeError):
            parse_transaction_envelope("not-valid-base64!!!")

    def test_non_string_raises_value_error(self):
        with self.assertRaises(ValueError):
            parse_transaction_envelope(b"bytes-not-str")

    def test_unsupported_envelope_type_raises(self):
        # discriminant 99 is not a known envelope type
        with self.assertRaises(XdrDecodeError):
            parse_transaction_envelope_bytes(b"x" * 48)


class TestV1Envelope(unittest.TestCase):
    def test_payment_envelope(self):
        payload = build_v1_envelope(
            _PAYMENT_OPS,
            source=b"\x22" * 32,
            fee=567,
            seq=9_999_999,
            memo=(1, "SF-ALPHA"),
        )
        parsed = parse_transaction_envelope_bytes(payload)

        self.assertEqual(parsed["envelope_type"], "ENVELOPE_TYPE_TX")
        self.assertEqual(parsed["source_account"], ed25519_account_id(b"\x22" * 32))
        self.assertEqual(parsed["fee"], 567)
        self.assertEqual(parsed["sequence"], 9_999_999)
        self.assertEqual(parsed["memo"], {"type": "MEMO_TEXT", "value": "SF-ALPHA"})
        self.assertIsNone(parsed["time_bounds"])
        self.assertTrue(parsed["decode_complete"])

        ops = parsed["operations"]
        self.assertEqual(len(ops), 1)
        op = ops[0]
        self.assertEqual(op["type"], 1)
        self.assertEqual(op["type_name"], "PAYMENT")
        self.assertEqual(op["source_account"]["address"], ed25519_account_id(b"\x12" * 32))
        self.assertEqual(op["destination"]["address"], ed25519_account_id(b"\x44" * 32))
        self.assertEqual(op["asset"], {"type": "credit_alphanum4", "code": "NGN", "issuer": ed25519_account_id(b"\x55" * 32)})
        self.assertEqual(op["amount"], 25_000_000)
        self.assertEqual(parsed["signatures"], [])

    def test_manage_data_envelope(self):
        payload = build_v1_envelope(
            [
                {"type": 10, "name": "NGN_PRICE", "value": "0.108"},
                {"type": 10, "name": "empty", "value": None},
            ]
        )
        parsed = parse_transaction_envelope(base64.b64encode(payload).decode())
        ops = parsed["operations"]
        self.assertEqual(ops[0]["type_name"], "MANAGE_DATA")
        self.assertEqual(ops[0]["name"], "NGN_PRICE")
        self.assertEqual(ops[0]["value"], bytes("0.108", "ascii").hex())
        self.assertEqual(ops[1]["name"], "empty")
        self.assertIsNone(ops[1]["value"])

    def test_base64_entry_point_matches_bytes(self):
        payload = build_v1_envelope(_PAYMENT_OPS)
        b64 = base64.b64encode(payload).decode()
        self.assertEqual(
            parse_transaction_envelope(b64),
            parse_transaction_envelope_bytes(payload),
        )

    def test_signatures_decoded(self):
        payload = build_v1_envelope(_PAYMENT_OPS, num_signatures=2)
        parsed = parse_transaction_envelope_bytes(payload)
        self.assertTrue(parsed["decode_complete"])
        self.assertEqual(len(parsed["signatures"]), 2)
        self.assertEqual(parsed["signatures"][0]["type"], "SIGNATURE_KEY_TYPE_ED25519")


class TestV0Envelope(unittest.TestCase):
    def test_create_account_envelope(self):
        payload = build_v0_envelope(
            [
                {
                    "type": 0,
                    "destination": ed25519_account_id(b"\x66" * 32),
                    "starting_balance": 5_000_000,
                }
            ],
            source=b"\x11" * 32,
            seq=777,
        )
        parsed = parse_transaction_envelope_bytes(payload)
        self.assertEqual(parsed["envelope_type"], "ENVELOPE_TYPE_TX_V0")
        self.assertEqual(parsed["source_account"], ed25519_account_id(b"\x11" * 32))
        op = parsed["operations"][0]
        self.assertEqual(op["type_name"], "CREATE_ACCOUNT")
        self.assertEqual(op["destination"], ed25519_account_id(b"\x66" * 32))
        self.assertEqual(op["starting_balance"], 5_000_000)

    def test_manage_data_with_string_value(self):
        payload = build_v0_envelope([{"type": 10, "name": "flag", "value": "on"}])
        parsed = parse_transaction_envelope_bytes(payload)
        self.assertEqual(parsed["operations"][0]["value"], bytes("on", "ascii").hex())


class TestPreconditions(unittest.TestCase):
    def test_default_is_precond_none(self):
        parsed = parse_transaction_envelope_bytes(build_v1_envelope(_PAYMENT_OPS))
        self.assertEqual(parsed["preconditions"]["type"], "PRECOND_NONE")
        self.assertIsNone(parsed["time_bounds"])

    def test_precond_time(self):
        payload = build_v1_envelope(
            _PAYMENT_OPS,
            precondition={"type": "time", "min_time": 1_000, "max_time": 2_000},
        )
        parsed = parse_transaction_envelope_bytes(payload)
        self.assertEqual(parsed["preconditions"]["type"], "PRECOND_TIME")
        self.assertEqual(parsed["preconditions"]["time_bounds"], {"min_time": 1000, "max_time": 2000})
        self.assertEqual(parsed["time_bounds"], {"min_time": 1000, "max_time": 2000})
        self.assertTrue(parsed["decode_complete"])

    def test_precond_v2(self):
        payload = build_v1_envelope(
            _PAYMENT_OPS,
            precondition={
                "type": "v2",
                "time_bounds": (1_000, 2_000),
                "min_seq_num": 7,
                "min_seq_age": 123,
                "min_seq_ledger_gap": 3,
            },
        )
        parsed = parse_transaction_envelope_bytes(payload)
        pre = parsed["preconditions"]
        self.assertEqual(pre["type"], "PRECOND_V2")
        self.assertEqual(pre["time_bounds"], {"min_time": 1000, "max_time": 2000})
        self.assertEqual(pre["min_seq_num"], 7)
        self.assertEqual(pre["min_seq_age"], 123)
        self.assertEqual(pre["min_seq_ledger_gap"], 3)
        self.assertIsNone(pre["ledger_bounds"])


class TestFeeBumpEnvelope(unittest.TestCase):
    def test_fee_bump_wraps_inner_v1(self):
        payload = build_fee_bump_envelope(_PAYMENT_OPS)
        parsed = parse_transaction_envelope_bytes(payload)
        self.assertEqual(parsed["envelope_type"], "ENVELOPE_TYPE_TX_FEE_BUMP")
        self.assertEqual(parsed["fee_source_account"], ed25519_account_id(b"\x33" * 32))
        self.assertEqual(parsed["fee"], 500)
        inner = parsed["inner_transaction"]
        self.assertEqual(inner["envelope_type"], "ENVELOPE_TYPE_TX")
        self.assertEqual(inner["operations"][0]["type_name"], "PAYMENT")


class TestPartialDecode(unittest.TestCase):
    def test_unsupported_operation_truncates(self):
        # First op decodes fully; the INVOKE_HOST_FUNCTION body is not parsed.
        payload = build_v1_envelope(
            [{"type": 1, "dest": b"\x44" * 32, "amount": 1}, {"type": 24}]
        )
        parsed = parse_transaction_envelope_bytes(payload)
        self.assertFalse(parsed["decode_complete"])
        self.assertEqual(parsed["truncated_at"], 1)
        self.assertEqual(len(parsed["operations"]), 1)
        self.assertEqual(parsed["operations"][0]["type_name"], "PAYMENT")
        self.assertIsNone(parsed["signatures"])


class TestOperationSubset(unittest.TestCase):
    def test_liquidity_pool_operations(self):
        payload = build_v1_envelope(
            [
                {"type": 22, "pool_id": b"\x88" * 32, "max_amount_a": 100, "max_amount_b": 200},
                {"type": 23, "pool_id": b"\x88" * 32, "amount": 30, "min_amount_a": 1, "min_amount_b": 2},
            ]
        )
        parsed = parse_transaction_envelope_bytes(payload)
        self.assertTrue(parsed["decode_complete"])
        self.assertEqual(len(parsed["operations"]), 2)
        deposit, withdraw = parsed["operations"]
        self.assertEqual(deposit["type_name"], "LIQUIDITY_POOL_DEPOSIT")
        self.assertEqual(deposit["liquidity_pool_id"], (b"\x88" * 32).hex())
        self.assertEqual(withdraw["type_name"], "LIQUIDITY_POOL_WITHDRAW")
        self.assertEqual(withdraw["amount"], 30)

    def test_ttl_extend_operation(self):
        payload = build_v1_envelope([{"type": 25, "extend_to": 4242}])
        parsed = parse_transaction_envelope_bytes(payload)
        self.assertTrue(parsed["decode_complete"])
        self.assertEqual(parsed["operations"][0]["extend_to"], 4242)
        self.assertEqual(parsed["operations"][0]["type_name"], "EXTEND_FOOTPRINT_TTL")

    def test_bump_sequence_operation(self):
        payload = build_v1_envelope([{"type": 11, "bump_to": 99_000}])
        parsed = parse_transaction_envelope_bytes(payload)
        self.assertEqual(parsed["operations"][0]["type_name"], "BUMP_SEQUENCE")
        self.assertEqual(parsed["operations"][0]["bump_to"], 99_000)


def _decode_strkey(value: str) -> bytes:
    """Reverse of ed25519_account_id for round-trip verification."""
    assert value.startswith("G")
    pad = "=" * ((8 - (len(value) % 8)) % 8)
    raw = base64.b32decode(value + pad)
    payload, checksum = raw[:-2], struct.unpack("<H", raw[-2:])[0]
    crc = 0
    for byte in payload:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    assert checksum == crc
    assert payload[0] == (6 << 3)
    return payload[1:]


if __name__ == "__main__":
    unittest.main()