"""Test-only minimal XDR writer used to craft synthetic Stellar TransactionEnvelope
payloads for horizon_xdr / horizon_parser / horizon_worker tests.

Mirrors the XDR field order implemented in ``src/ingestion/horizon_xdr.py``.
This module is intentionally not collected by pytest (no ``test_`` prefix).
"""

from __future__ import annotations

import struct
from typing import Any, Dict, List, Optional, Tuple


class Xenc:
    """Appending big-endian XDR primitive writer."""

    def __init__(self) -> None:
        self.buf = bytearray()

    def uint(self, value: int) -> "Xenc":
        self.buf += struct.pack(">I", value & 0xFFFFFFFF)
        return self

    def int(self, value: int) -> "Xenc":
        self.buf += struct.pack(">i", value)
        return self

    def hyper(self, value: int) -> "Xenc":
        self.buf += struct.pack(">q", value)
        return self

    def ulong(self, value: int) -> "Xenc":
        self.buf += struct.pack(">Q", value)
        return self

    def opaque(self, data: bytes) -> "Xenc":
        self.buf += data
        return self

    def var_opaque(self, data: bytes) -> "Xenc":
        self.uint(len(data)).opaque(data)
        pad = (-len(data)) % 4
        if pad:
            self.buf += b"\x00" * pad
        return self

    def string(self, text: str) -> "Xenc":
        return self.var_opaque(text.encode("utf-8"))

    def boolean(self, value: bool) -> "Xenc":
        return self.uint(1 if value else 0)

    def bytes(self) -> bytes:
        return bytes(self.buf)


def push_muxed(x: Xenc, raw: bytes) -> None:
    x.int(0)  # KEY_TYPE_ED25519
    x.opaque(raw)


def push_optional_muxed(x: Xenc, raw: Optional[bytes]) -> None:
    if raw is None:
        x.boolean(False)
    else:
        x.boolean(True)
        push_muxed(x, raw)


def push_asset(x: Xenc, *, code: Optional[str] = None, issuer: Optional[bytes] = None) -> None:
    if code is None:
        x.int(0)  # ASSET_TYPE_NATIVE
        return
    encoded = code.encode("ascii")
    if len(encoded) <= 4:
        x.int(1).opaque(encoded.ljust(4, b"\x00")).opaque(issuer or b"\x00" * 32)
    else:
        x.int(2).opaque(encoded.ljust(12, b"\x00")).opaque(issuer or b"\x00" * 32)


def push_price(x: Xenc, n: int, d: int) -> None:
    x.int(n).int(d)


def push_memo(x: Xenc, memo: Tuple[Any, ...]) -> None:
    kind = memo[0]
    x.int(kind)
    if kind == 1:  # MEMO_TEXT
        x.string(str(memo[1]))
    elif kind == 2:  # MEMO_ID
        x.ulong(int(memo[1]))
    elif kind in (3, 4):  # MEMO_HASH / MEMO_RETURN
        x.opaque(memo[1] if isinstance(memo[1], bytes) else b"\x00" * 32)


def push_preconditions(x: Xenc, precondition: Optional[Dict[str, Any]] = None) -> None:
    """Write a modern ``Preconditions`` union (protocol >= 19).

    ``None`` / ``{}`` encodes ``PRECOND_NONE``; ``{"type": "time"}`` encodes
    ``PRECOND_TIME``; ``{"type": "v2", ...}`` encodes ``PRECOND_V2``.
    """
    if not precondition or precondition.get("type") in (None, "none", 0):
        x.int(0)  # PRECOND_NONE
        return
    kind = precondition.get("type")
    if kind == "time":
        x.int(1)  # PRECOND_TIME
        x.hyper(precondition.get("min_time", 0))
        x.hyper(precondition.get("max_time", 0))
        return
    if kind == "v2":
        x.int(2)  # PRECOND_V2
        tb = precondition.get("time_bounds")
        if tb:
            x.boolean(True).hyper(tb[0]).hyper(tb[1])
        else:
            x.boolean(False)
        x.boolean(False)  # ledger bounds absent
        x.int(precondition.get("min_seq_num", 0))
        x.hyper(precondition.get("min_seq_age", 0))
        x.uint(precondition.get("min_seq_ledger_gap", 0))
        x.int(0)  # ExtensionPoint
        return
    raise ValueError(f"unsupported test precondition: {kind}")


def push_operations(x: Xenc, ops: List[Dict[str, Any]]) -> None:
    """Append the ``operations<100>`` array.  Each op dict carries ``type``,
    optional ``src`` and type-specific fields."""
    x.uint(len(ops))
    for op in ops:
        push_optional_muxed(x, op.get("src"))
        op_type = op["type"]
        x.int(op_type)
        if op_type == 0:  # CREATE_ACCOUNT
            x.string(op.get("destination", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"))
            x.hyper(op.get("starting_balance", 10_000_000))
        elif op_type == 1:  # PAYMENT
            push_muxed(x, op.get("dest") or (b"\x44" * 32))
            push_asset(x, code=op.get("code"), issuer=op.get("issuer"))
            x.hyper(op.get("amount", 1_000_000))
        elif op_type in (3, 4, 12):  # MANAGE_*_OFFER
            push_asset(x, code=op.get("selling"), issuer=op.get("selling_issuer"))
            push_asset(x, code=op.get("buying"), issuer=op.get("buying_issuer"))
            x.hyper(op.get("amount", 100))
            push_price(x, op.get("price_n", 1), op.get("price_d", 1))
            x.hyper(op.get("offer_id", 0))
        elif op_type == 5:  # SET_OPTIONS
            push_optional_muxed(x, op.get("inflation_dest"))
            for i in range(6):
                x.boolean(False)  # clear/set flags + 4 thresholds
            x.boolean(False)  # home_domain
            x.boolean(False)  # signer
        elif op_type == 6:  # CHANGE_TRUST
            push_asset(x, code=op.get("code"), issuer=op.get("issuer"))
            x.hyper(op.get("limit", 9_223_372_036_854_775_000))
        elif op_type == 8:  # ACCOUNT_MERGE
            push_muxed(x, op.get("dest") or (b"\x55" * 32))
        elif op_type == 9:  # INFLATION
            pass
        elif op_type == 10:  # MANAGE_DATA
            x.string(op.get("name", "key"))
            value = op.get("value")
            if value is None:
                x.boolean(False)
            else:
                x.boolean(True).var_opaque(value.encode("ascii"))
        elif op_type == 11:  # BUMP_SEQUENCE
            x.hyper(op.get("bump_to", 12345))
        elif op_type == 16:  # BEGIN_SPONSORING_FUTURE_RESERVES
            push_muxed(x, op.get("sponsored") or (b"\x66" * 32))
        elif op_type == 17:  # END_SPONSORING_FUTURE_RESERVES
            pass
        elif op_type == 19:  # CLAWBACK
            push_asset(x, code=op.get("code"), issuer=op.get("issuer"))
            push_muxed(x, op.get("from") or (b"\x77" * 32))
            x.hyper(op.get("amount", 5))
        elif op_type == 22:  # LIQUIDITY_POOL_DEPOSIT
            x.opaque(op.get("pool_id") or (b"\x88" * 32))
            x.hyper(op.get("max_amount_a", 100))
            x.hyper(op.get("max_amount_b", 200))
            push_price(x, op.get("min_price_n", 1), op.get("min_price_d", 2))
            push_price(x, op.get("max_price_n", 2), op.get("max_price_d", 1))
        elif op_type == 23:  # LIQUIDITY_POOL_WITHDRAW
            x.opaque(op.get("pool_id") or (b"\x88" * 32))
            x.hyper(op.get("amount", 100))
            x.hyper(op.get("min_amount_a", 1))
            x.hyper(op.get("min_amount_b", 2))
        elif op_type == 24:  # INVOKE_HOST_FUNCTION — intentionally unsupported
            pass  # decoder stops here
        elif op_type == 25:  # EXTEND_FOOTPRINT_TTL
            x.uint(op.get("extend_to", 1000))
        elif op_type == 26:  # RESTORE_FOOTPRINT
            pass
        else:
            raise ValueError(f"unsupported test op type: {op_type}")


def _memo_none(x: Xenc) -> None:
    push_memo(x, (0,))


def build_v0_envelope(
    ops: List[Dict[str, Any]],
    *,
    source: bytes = b"\x11" * 32,
    fee: int = 100,
    seq: int = 1234,
    memo: Tuple[Any, ...] = (0,),
    num_signatures: int = 0,
) -> bytes:
    """Encode an ENVELOPE_TYPE_TX_V0 (legacy) envelope."""
    x = Xenc()
    x.int(0)
    x.opaque(source)
    x.uint(fee)
    x.hyper(seq)
    x.boolean(False)  # timeBounds absent
    push_memo(x, memo)
    push_operations(x, ops)
    x.uint(num_signatures)
    for _ in range(num_signatures):
        x.opaque(b"\x01\x02\x03\x04").int(0).var_opaque(b"\xAA" * 64)
    return x.bytes()


def build_v1_envelope(
    ops: List[Dict[str, Any]],
    *,
    source: bytes = b"\x22" * 32,
    fee: int = 100,
    seq: int = 4321,
    memo: Tuple[Any, ...] = (0,),
    precondition: Optional[Dict[str, Any]] = None,
    num_signatures: int = 0,
) -> bytes:
    """Encode an ENVELOPE_TYPE_TX (v1, the modern) envelope."""
    x = Xenc()
    x.int(2)
    push_muxed(x, source)
    x.uint(fee)
    x.hyper(seq)
    push_preconditions(x, precondition)
    push_memo(x, memo)
    push_operations(x, ops)
    x.int(0)  # TransactionExtension = 0
    x.uint(num_signatures)
    for _ in range(num_signatures):
        x.opaque(b"\x01\x02\x03\x04").int(0).var_opaque(b"\xBB" * 64)
    return x.bytes()


def build_fee_bump_envelope(
    ops: List[Dict[str, Any]],
    *,
    inner_source: bytes = b"\x22" * 32,
    fee: int = 500,
    inner_seq: int = 4321,
    num_inner_signatures: int = 0,
    num_outer_signatures: int = 0,
) -> bytes:
    """Encode an ENVELOPE_TYPE_TX_FEE_BUMP wrapping a v1 envelope."""
    x = Xenc()
    x.int(5)
    push_muxed(x, b"\x33" * 32)  # feeSource
    x.hyper(fee)
    x.int(2)  # FeeBumpInnerTx discriminates ENVELOPE_TYPE_TX
    # inner TransactionV1Envelope: Transaction fields + signatures + ext
    push_muxed(x, inner_source)
    x.uint(100)
    x.hyper(inner_seq)
    push_preconditions(x)
    push_memo(x, (0,))
    push_operations(x, ops)
    x.int(0)  # TransactionExt
    x.uint(num_inner_signatures)
    for _ in range(num_inner_signatures):
        x.opaque(b"\x01\x02\x03\x04").int(0).var_opaque(b"\xBB" * 64)
    x.int(0)  # TransactionV1EnvelopeExt
    x.int(0)  # FeeBumpTransactionExt
    x.uint(num_outer_signatures)
    for _ in range(num_outer_signatures):
        x.opaque(b"\x01\x02\x03\x04").int(0).var_opaque(b"\xBB" * 64)
    return x.bytes()