"""horizon_xdr.py — lightweight Stellar XDR decoder for the Horizon ingestion worker.

High-throughput ledger ingestion needs to turn the base64 XDR strings that
Horizon / Stellar RPC hand back (``envelope_xdr`` / ``envelopeXdr``,
``result_xdr``, ``result_meta_xdr``) into structured JSON without paying for a
full XDR codegen dependency.  This module implements just the subset of the
Stellar XDR wire format needed to decode a transaction envelope:

* ``XdrReader`` — big-endian XDR primitive reader (uint/int/hyper/opaque/
  string/array/optional/union).
* ``parse_transaction_envelope`` / ``parse_transaction_envelope_bytes`` —
  decode a base64 or raw ``TransactionEnvelope`` into a plain dict covering
  the envelope type, source account, fee, sequence, memo, time bounds and a
  best-effort per-operation description.

The decoder is *lossy by design*: exotic operation bodies (path payments,
claimable balances, host-function calls, …) are not fully decoded.  In those
cases the operation list is truncated, ``decode_complete`` is ``False`` and
``truncated_at`` reports the zero-based operation index where decoding
stopped.  Callers that only need the common ``CREATE_ACCOUNT``, ``PAYMENT``,
``MANAGE_*``, ``SET_OPTIONS``, ``CHANGE_TRUST``, ``MANAGE_DATA``,
``BUMP_SEQUENCE``, ``CLAWBACK`` and TTL operations get full fidelity.

Examples
--------
>>> import base64
>>> from ingestion.horizon_xdr import parse_transaction_envelope
>>> parsed = parse_transaction_envelope(open("env.xdr", "rb").read())
>>> parsed["source_account"]
'GC6R3T4IJH6DQBE4XQYS7W5ZBHQ6ZB7WG7W2X7Q3ZSQGV6XX5YFZ6GJ6'
"""

from __future__ import annotations

import base64
import binascii
import struct
from typing import Any, Callable, Dict, List, Optional, Tuple

__all__ = [
    "XdrDecodeError",
    "XdrReader",
    "parse_transaction_envelope",
    "parse_transaction_envelope_bytes",
    "decode_muxed_account",
    "decode_asset",
    "ed25519_account_id",
]


class XdrDecodeError(ValueError):
    """Raised when a payload cannot be interpreted as well-formed Stellar XDR."""


# ---------------------------------------------------------------------------
# Primitive XDR reader
# ---------------------------------------------------------------------------


class XdrReader:
    """Sequential big-endian reader over Stellar XDR bytes.

    Parameters
    ----------
    data:
        Raw XDR bytes (base64-decoded).
    offset:
        Optional start offset.
    """

    __slots__ = ("data", "pos")

    def __init__(self, data: bytes, offset: int = 0) -> None:
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError(f"expected bytes, got {type(data).__name__}")
        if not isinstance(offset, int) or offset < 0:
            raise ValueError("offset must be a non-negative integer")
        self.data = bytes(data)
        self.pos = offset

    def _take(self, n: int) -> bytes:
        if n < 0:
            raise XdrDecodeError(f"negative field length requested: {n}")
        end = self.pos + n
        if end > len(self.data):
            raise XdrDecodeError(
                f"truncated XDR: needed {n} bytes at offset {self.pos}, "
                f"only {len(self.data) - self.pos} remaining"
            )
        chunk = self.data[self.pos : end]
        self.pos = end
        return chunk

    def read_uint(self) -> int:
        return struct.unpack(">I", self._take(4))[0]

    def read_int(self) -> int:
        return struct.unpack(">i", self._take(4))[0]

    def read_hyper(self) -> int:
        return struct.unpack(">q", self._take(8))[0]

    def read_ulong(self) -> int:
        return struct.unpack(">Q", self._take(8))[0]

    def read_bool(self) -> bool:
        value = self.read_uint()
        if value not in (0, 1):
            raise XdrDecodeError(f"invalid XDR bool value: {value}")
        return bool(value)

    def read_opaque(self, n: int) -> bytes:
        return self._take(n)

    def read_var_opaque(self, max_len: Optional[int] = None) -> bytes:
        n = self.read_uint()
        if n > 2_147_483_647:
            raise XdrDecodeError(f"opaque length out of range: {n}")
        if max_len is not None and n > max_len:
            raise XdrDecodeError(
                f"opaque length {n} exceeds declared maximum {max_len}"
            )
        data = self._take(n)
        # XDR pads variable-length data to a 4-byte boundary.
        self.pos += (-n) % 4
        return data

    def read_string(self, max_len: Optional[int] = None) -> str:
        raw = self.read_var_opaque(max_len)
        return raw.decode("utf-8", errors="replace")

    def read_array(self, item_reader: Callable[["XdrReader"], Any], max_len: Optional[int] = None) -> List[Any]:
        n = self.read_uint()
        if n > 2_147_483_647:
            raise XdrDecodeError(f"array length out of range: {n}")
        if max_len is not None and n > max_len:
            raise XdrDecodeError(f"array length {n} exceeds declared maximum {max_len}")
        return [item_reader(self) for _ in range(n)]

    def read_optional(self, reader: Callable[["XdrReader"], Any]) -> Any:
        if self.read_bool():
            return reader(self)
        return None

    def remaining(self) -> int:
        return len(self.data) - self.pos


# ---------------------------------------------------------------------------
# StrKey (G… addresses) helpers — pure-python, no external crypto dependency
# ---------------------------------------------------------------------------

_ACCOUNT_VERSION_BYTE: int = 6 << 3  # KEY_TYPE_ED25519 = 6, shifted per Stellar strkey


def _crc16_xmodem(data: bytes) -> int:
    """CRC-16/XMODEM (poly 0x1021, init 0x0000) checksum over *data*."""
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def _encode_check(version_byte: int, payload: bytes) -> str:
    """Encode *payload* using the Stellar versioned base32 checksum format.

    The CRC-16/XMODEM checksum is appended **little-endian** (as produced by
    ``UInt16LE`` in the reference ``js-stellar-base`` implementation).
    """
    buf = bytes([version_byte]) + payload
    checksum = _crc16_xmodem(buf)
    buf += struct.pack("<H", checksum)
    return base64.b32encode(buf).decode("ascii").rstrip("=")


def ed25519_account_id(public_key: bytes) -> str:
    """Return the ``G…`` StrKey string for a raw 32-byte Ed25519 public key."""
    if len(public_key) != 32:
        raise ValueError(f"Ed25519 public key must be 32 bytes, got {len(public_key)}")
    return _encode_check(_ACCOUNT_VERSION_BYTE, public_key)


# ---------------------------------------------------------------------------
# Shared constants
# ---------------------------------------------------------------------------

KEY_TYPE_ED25519 = 0
KEY_TYPE_MUXED_ED25519 = 256

ASSET_TYPE_NATIVE = 0
ASSET_TYPE_CREDIT_ALPHANUM4 = 1
ASSET_TYPE_CREDIT_ALPHANUM12 = 2
ASSET_TYPE_POOL_SHARE = 3

ENVELOPE_TYPE_TX_V0 = 0
ENVELOPE_TYPE_TX = 2
ENVELOPE_TYPE_TX_FEE_BUMP = 5

ENVELOPE_TYPE_NAMES: Dict[int, str] = {
    ENVELOPE_TYPE_TX_V0: "ENVELOPE_TYPE_TX_V0",
    ENVELOPE_TYPE_TX: "ENVELOPE_TYPE_TX",
    ENVELOPE_TYPE_TX_FEE_BUMP: "ENVELOPE_TYPE_TX_FEE_BUMP",
}

OPERATION_TYPE_NAMES: Dict[int, str] = {
    0: "CREATE_ACCOUNT",
    1: "PAYMENT",
    2: "PATH_PAYMENT_STRICT_RECEIVE",
    3: "MANAGE_SELL_OFFER",
    4: "CREATE_PASSIVE_SELL_OFFER",
    5: "SET_OPTIONS",
    6: "CHANGE_TRUST",
    7: "ALLOW_TRUST",
    8: "ACCOUNT_MERGE",
    9: "INFLATION",
    10: "MANAGE_DATA",
    11: "BUMP_SEQUENCE",
    12: "MANAGE_BUY_OFFER",
    13: "PATH_PAYMENT_STRICT_SEND",
    14: "CREATE_CLAIMABLE_BALANCE",
    15: "CLAIM_CLAIMABLE_BALANCE",
    16: "BEGIN_SPONSORING_FUTURE_RESERVES",
    17: "END_SPONSORING_FUTURE_RESERVES",
    18: "REVOKE_SPONSORSHIP",
    19: "CLAWBACK",
    20: "CLAWBACK_CLAIMABLE_BALANCE",
    21: "SET_TRUST_LINE_FLAGS",
    22: "LIQUIDITY_POOL_DEPOSIT",
    23: "LIQUIDITY_POOL_WITHDRAW",
    24: "INVOKE_HOST_FUNCTION",
    25: "EXTEND_FOOTPRINT_TTL",
    26: "RESTORE_FOOTPRINT",
}

#: Operation types whose union body this decoder understands in full.
_SUPPORTED_OPERATION_BODIES = frozenset(
    (0, 1, 3, 4, 5, 6, 8, 9, 10, 11, 12, 16, 17, 19, 22, 23, 25, 26)
)


# ---------------------------------------------------------------------------
# Composite field decoders
# ---------------------------------------------------------------------------


def decode_muxed_account(reader: XdrReader) -> Dict[str, Any]:
    """Decode a ``MuxedAccount`` union into a plain dict.

    Returns
    -------
    dict
        ``{"key_type": ...}`` plus ``address`` (G…), and ``muxed_id`` /
        ``ed25519`` when the muxed variant is used.
    """
    key_type = reader.read_int()
    if key_type == KEY_TYPE_ED25519:
        raw = reader.read_opaque(32)
        return {
            "key_type": "KEY_TYPE_ED25519",
            "address": ed25519_account_id(raw),
            "ed25519": raw.hex(),
        }
    if key_type == KEY_TYPE_MUXED_ED25519:
        muxed_id = reader.read_ulong()
        raw = reader.read_opaque(32)
        return {
            "key_type": "KEY_TYPE_MUXED_ED25519",
            "address": ed25519_account_id(raw),
            "muxed_id": muxed_id,
            "med25519": f"M{ed25519_account_id(raw)}",
            "ed25519": raw.hex(),
        }
    raise XdrDecodeError(f"unsupported MuxedAccount key type: {key_type}")


def decode_asset(reader: XdrReader) -> Dict[str, Any]:
    """Decode an ``Asset`` union into ``{"type", "code", "issuer"}``."""
    asset_type = reader.read_int()
    if asset_type == ASSET_TYPE_NATIVE:
        return {"type": "native", "code": "XLM", "issuer": None}
    if asset_type == ASSET_TYPE_CREDIT_ALPHANUM4:
        code = reader.read_opaque(4).rstrip(b"\x00").decode("ascii", errors="replace")
        issuer = ed25519_account_id(reader.read_opaque(32))
        return {"type": "credit_alphanum4", "code": code, "issuer": issuer}
    if asset_type == ASSET_TYPE_CREDIT_ALPHANUM12:
        code = reader.read_opaque(12).rstrip(b"\x00").decode("ascii", errors="replace")
        issuer = ed25519_account_id(reader.read_opaque(32))
        return {"type": "credit_alphanum12", "code": code, "issuer": issuer}
    if asset_type == ASSET_TYPE_POOL_SHARE:
        return {"type": "pool_share", "liquidity_pool_id": reader.read_opaque(32).hex()}
    raise XdrDecodeError(f"unsupported Asset type: {asset_type}")


def _decode_price(reader: XdrReader) -> Dict[str, int]:
    return {"n": reader.read_int(), "d": reader.read_int()}


def _decode_time_bounds(reader: XdrReader) -> Dict[str, int]:
    return {"min_time": reader.read_hyper(), "max_time": reader.read_hyper()}


def _decode_ledger_bounds(reader: XdrReader) -> Dict[str, int]:
    return {"min_ledger": reader.read_uint(), "max_ledger": reader.read_uint()}


def _decode_preconditions(reader: XdrReader) -> Dict[str, Any]:
    """Decode the modern ``Preconditions`` union (protocol >= 19).

    ``TransactionV0`` still carries a legacy optional ``TimeBounds*``, but
    ``TransactionV1`` (and fee-bump inner transactions) use this union.
    """
    precond_type = reader.read_int()
    if precond_type == 0:  # PRECOND_NONE
        return {"type": "PRECOND_NONE"}
    if precond_type == 1:  # PRECOND_TIME
        return {"type": "PRECOND_TIME", "time_bounds": _decode_time_bounds(reader)}
    if precond_type == 2:  # PRECOND_V2
        return {
            "type": "PRECOND_V2",
            "time_bounds": reader.read_optional(_decode_time_bounds),
            "ledger_bounds": reader.read_optional(_decode_ledger_bounds),
            "min_seq_num": reader.read_int(),
            "min_seq_age": reader.read_hyper(),
            "min_seq_ledger_gap": reader.read_uint(),
            "extension_point": reader.read_int(),
        }
    raise XdrDecodeError(f"unsupported PreconditionType: {precond_type}")


_MEMO_TYPES = {
    0: "MEMO_NONE",
    1: "MEMO_TEXT",
    2: "MEMO_ID",
    3: "MEMO_HASH",
    4: "MEMO_RETURN",
}


def _decode_memo(reader: XdrReader) -> Dict[str, Any]:
    memo_type = reader.read_int()
    name = _MEMO_TYPES.get(memo_type, f"UNKNOWN_{memo_type}")
    if memo_type == 0:
        return {"type": name}
    if memo_type == 1:
        return {"type": name, "value": reader.read_string()}
    if memo_type == 2:
        return {"type": name, "value": str(reader.read_ulong())}
    if memo_type in (3, 4):
        return {"type": name, "value": reader.read_opaque(32).hex()}
    raise XdrDecodeError(f"unsupported memo type: {memo_type}")


def _decode_signer(reader: XdrReader) -> Dict[str, Any]:
    key_type = reader.read_int()
    payload: Dict[str, Any]
    if key_type == KEY_TYPE_ED25519:
        payload = {"key_type": "KEY_TYPE_ED25519", "key": ed25519_account_id(reader.read_opaque(32))}
    elif key_type in (1, 2):  # PRE_AUTH_TX / HASH_X
        name = "KEY_TYPE_PRE_AUTH_TX" if key_type == 1 else "KEY_TYPE_HASH_X"
        payload = {"key_type": name, "key": reader.read_opaque(32).hex()}
    else:
        raise XdrDecodeError(f"unsupported SignerKey type: {key_type}")
    payload["weight"] = reader.read_uint()
    return payload


# ---------------------------------------------------------------------------
# Operation body decoders
# ---------------------------------------------------------------------------


def _op_manage_sell_offer(reader: XdrReader) -> Dict[str, Any]:
    return {
        "selling": decode_asset(reader),
        "buying": decode_asset(reader),
        "amount": reader.read_hyper(),
        "price": _decode_price(reader),
        "offer_id": reader.read_hyper(),
    }


def _op_set_options(reader: XdrReader) -> Dict[str, Any]:
    return {
        "inflation_dest": reader.read_optional(decode_muxed_account),
        "clear_flags": reader.read_optional(lambda r: r.read_uint()),
        "set_flags": reader.read_optional(lambda r: r.read_uint()),
        "master_weight": reader.read_optional(lambda r: r.read_uint()),
        "low_threshold": reader.read_optional(lambda r: r.read_uint()),
        "med_threshold": reader.read_optional(lambda r: r.read_uint()),
        "high_threshold": reader.read_optional(lambda r: r.read_uint()),
        "home_domain": reader.read_optional(lambda r: r.read_string()),
        "signer": reader.read_optional(_decode_signer),
    }


def _op_liquidity_pool_deposit(reader: XdrReader) -> Dict[str, Any]:
    return {
        "liquidity_pool_id": reader.read_opaque(32).hex(),
        "max_amount_a": reader.read_hyper(),
        "max_amount_b": reader.read_hyper(),
        "min_price": _decode_price(reader),
        "max_price": _decode_price(reader),
    }


def _op_liquidity_pool_withdraw(reader: XdrReader) -> Dict[str, Any]:
    return {
        "liquidity_pool_id": reader.read_opaque(32).hex(),
        "amount": reader.read_hyper(),
        "min_amount_a": reader.read_hyper(),
        "min_amount_b": reader.read_hyper(),
    }


def _decode_operation_body(reader: XdrReader, op_type: int) -> Dict[str, Any]:
    """Decode the operation body union for a supported *op_type*."""
    if op_type == 0:  # CREATE_ACCOUNT
        return {
            "destination": reader.read_string(),
            "starting_balance": reader.read_hyper(),
        }
    if op_type == 1:  # PAYMENT
        return {
            "destination": decode_muxed_account(reader),
            "asset": decode_asset(reader),
            "amount": reader.read_hyper(),
        }
    if op_type in (3, 4, 12):  # MANAGE_SELL_OFFER / CREATE_PASSIVE_SELL_OFFER / MANAGE_BUY_OFFER
        return _op_manage_sell_offer(reader)
    if op_type == 5:  # SET_OPTIONS
        return _op_set_options(reader)
    if op_type == 6:  # CHANGE_TRUST
        return {"line": decode_asset(reader), "limit": reader.read_hyper()}
    if op_type == 8:  # ACCOUNT_MERGE
        return {"destination": decode_muxed_account(reader)}
    if op_type == 9:  # INFLATION
        return {}
    if op_type == 10:  # MANAGE_DATA
        return {
            "name": reader.read_string(),
            "value": reader.read_optional(lambda r: r.read_var_opaque().hex()),
        }
    if op_type == 11:  # BUMP_SEQUENCE
        return {"bump_to": reader.read_hyper()}
    if op_type == 16:  # BEGIN_SPONSORING_FUTURE_RESERVES
        return {"sponsored_id": decode_muxed_account(reader)}
    if op_type == 17:  # END_SPONSORING_FUTURE_RESERVES
        return {}
    if op_type == 19:  # CLAWBACK
        return {
            "asset": decode_asset(reader),
            "from": decode_muxed_account(reader),
            "amount": reader.read_hyper(),
        }
    if op_type == 22:  # LIQUIDITY_POOL_DEPOSIT
        return _op_liquidity_pool_deposit(reader)
    if op_type == 23:  # LIQUIDITY_POOL_WITHDRAW
        return _op_liquidity_pool_withdraw(reader)
    if op_type == 25:  # EXTEND_FOOTPRINT_TTL
        return {"extend_to": reader.read_uint()}
    if op_type == 26:  # RESTORE_FOOTPRINT
        return {}
    raise XdrDecodeError(
        f"unsupported operation body type {op_type} "
        f"({OPERATION_TYPE_NAMES.get(op_type, 'UNKNOWN')})"
    )


def decode_operation(reader: XdrReader) -> Dict[str, Any]:
    """Decode a complete ``Operation`` (optional source + body union).

    Raises
    ------
    XdrDecodeError
        If the operation body is not supported or the bytes are malformed.
    """
    source_account = reader.read_optional(decode_muxed_account)
    op_type = reader.read_int()
    body = _decode_operation_body(reader, op_type)
    result: Dict[str, Any] = {
        "type": op_type,
        "type_name": OPERATION_TYPE_NAMES.get(op_type, f"UNKNOWN_{op_type}"),
    }
    if source_account is not None:
        result["source_account"] = source_account
    result.update(body)
    return result


def _decode_operations(reader: XdrReader) -> Tuple[List[Dict[str, Any]], bool, Optional[int]]:
    """Decode the ``operations<100>`` array best-effort.

    Returns a ``(operations, decode_complete, truncated_at)`` tuple.  When an
    operation body cannot be decoded the scan stops at *truncated_at*.
    """
    count = reader.read_uint()
    if count > 100:
        raise XdrDecodeError(f"operation array length out of range: {count}")
    operations: List[Dict[str, Any]] = []
    for index in range(count):
        try:
            operations.append(decode_operation(reader))
        except XdrDecodeError:
            return operations, False, index
    return operations, True, None


def _decode_signatures(reader: XdrReader) -> List[Dict[str, Any]]:
    """Decode the trailing ``DecoratedSignature<20>`` array (best-effort)."""
    count = reader.read_uint()
    signatures: List[Dict[str, Any]] = []
    for _ in range(count):
        hint = reader.read_opaque(4).hex()
        sig_type = reader.read_int()
        if sig_type in (0, 1, 2):
            raw = reader.read_var_opaque(64)
            signatures.append(
                {
                    "hint": hint,
                    "type": "SIGNATURE_KEY_TYPE_ED25519"
                    if sig_type == 0
                    else ("SIGNATURE_KEY_TYPE_PRE_AUTH_TX" if sig_type == 1 else "SIGNATURE_KEY_TYPE_HASH_X"),
                    "signature": base64.b64encode(raw).decode("ascii"),
                }
            )
        elif sig_type == 3:  # ED25519_SIGNED_PAYLOAD
            ed25519 = reader.read_opaque(32).hex()
            payload = reader.read_var_opaque(64).hex()
            signatures.append(
                {
                    "hint": hint,
                    "type": "SIGNATURE_KEY_TYPE_ED25519_SIGNED_PAYLOAD",
                    "ed25519": ed25519,
                    "payload": payload,
                }
            )
        else:
            raise XdrDecodeError(f"unsupported signature type: {sig_type}")
    return signatures


# ---------------------------------------------------------------------------
# Transaction envelope decoders
# ---------------------------------------------------------------------------


def _transaction_v0(reader: XdrReader) -> Dict[str, Any]:
    source = ed25519_account_id(reader.read_opaque(32))
    fee = reader.read_uint()
    sequence = reader.read_hyper()
    time_bounds = reader.read_optional(_decode_time_bounds)
    memo = _decode_memo(reader)
    operations, complete, truncated_at = _decode_operations(reader)
    return {
        "source_account": source,
        "fee": fee,
        "sequence": sequence,
        "time_bounds": time_bounds,
        "memo": memo,
        "operations": operations,
        "operation_count": len(operations),
        "decode_complete": complete,
        "truncated_at": truncated_at,
    }


def _transaction_v1(reader: XdrReader) -> Dict[str, Any]:
    source = decode_muxed_account(reader)
    fee = reader.read_uint()
    sequence = reader.read_hyper()
    preconditions = _decode_preconditions(reader)
    memo = _decode_memo(reader)
    operations, complete, truncated_at = _decode_operations(reader)
    ext = reader.read_int()  # ExtensionPoint — 0 for version 0
    return {
        "source_account": source.get("address"),
        "fee": fee,
        "sequence": sequence,
        "preconditions": preconditions,
        "time_bounds": preconditions.get("time_bounds"),
        "memo": memo,
        "operations": operations,
        "operation_count": len(operations),
        "decode_complete": complete,
        "truncated_at": truncated_at,
        "extension_point": ext,
    }


def _decode_v0_envelope(reader: XdrReader) -> Dict[str, Any]:
    tx = _transaction_v0(reader)
    tx["envelope_type"] = "ENVELOPE_TYPE_TX_V0"
    if tx["decode_complete"]:
        try:
            tx["signatures"] = _decode_signatures(reader)
        except XdrDecodeError:
            tx["decode_complete"] = False
    else:
        tx["signatures"] = None
    return tx


def _decode_v1_envelope(reader: XdrReader) -> Dict[str, Any]:
    tx = _transaction_v1(reader)
    tx["envelope_type"] = "ENVELOPE_TYPE_TX"
    if tx["decode_complete"]:
        try:
            tx["signatures"] = _decode_signatures(reader)
        except XdrDecodeError:
            tx["decode_complete"] = False
    else:
        tx["signatures"] = None
    return tx


def _decode_fee_bump_envelope(reader: XdrReader) -> Dict[str, Any]:
    fee_source = decode_muxed_account(reader)
    fee = reader.read_hyper()
    inner_type = reader.read_int()
    if inner_type != ENVELOPE_TYPE_TX:
        raise XdrDecodeError(f"FeeBumpInnerTx must wrap ENVELOPE_TYPE_TX, got {inner_type}")
    inner = _transaction_v1(reader)
    inner["envelope_type"] = "ENVELOPE_TYPE_TX"
    if inner["decode_complete"]:
        try:
            inner["signatures"] = _decode_signatures(reader)
            inner["envelope_extension_point"] = reader.read_int()
        except XdrDecodeError:
            inner["decode_complete"] = False
    else:
        inner["signatures"] = None

    # FeeBumpTransactionExt + outer signatures (best-effort).
    extension_point = None
    signatures = None
    try:
        extension_point = reader.read_int()
        signatures = _decode_signatures(reader)
    except XdrDecodeError:  # trailing fields are optional fidelity
        pass

    return {
        "envelope_type": "ENVELOPE_TYPE_TX_FEE_BUMP",
        "fee_source_account": fee_source.get("address"),
        "fee": fee,
        "inner_transaction": inner,
        "extension_point": extension_point,
        "signatures": signatures,
    }


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def parse_transaction_envelope_bytes(data: bytes) -> Dict[str, Any]:
    """Decode a raw (non-base64) ``TransactionEnvelope`` bytes buffer.

    Parameters
    ----------
    data:
        Raw XDR bytes beginning with the envelope-type discriminant.

    Returns
    -------
    dict
        Normalised envelope description (see module docstring).

    Raises
    ------
    XdrDecodeError
        If the buffer is truncated, malformed, or uses an unsupported
        envelope type.
    """
    if not data:
        raise XdrDecodeError("transaction envelope is empty")
    reader = XdrReader(data)
    env_type = reader.read_int()
    if env_type == ENVELOPE_TYPE_TX_V0:
        return _decode_v0_envelope(reader)
    if env_type == ENVELOPE_TYPE_TX:
        return _decode_v1_envelope(reader)
    if env_type == ENVELOPE_TYPE_TX_FEE_BUMP:
        return _decode_fee_bump_envelope(reader)
    raise XdrDecodeError(
        f"unsupported envelope type {env_type} "
        f"({ENVELOPE_TYPE_NAMES.get(env_type, 'UNKNOWN')})"
    )


def parse_transaction_envelope(xdr_b64: str) -> Dict[str, Any]:
    """Decode a base64-encoded Stellar ``TransactionEnvelope``.

    Parameters
    ----------
    xdr_b64:
        Base64 payload of a transaction envelope (``envelope_xdr`` /
        ``envelopeXdr`` as returned by Horizon / Stellar RPC).

    Returns
    -------
    dict
        Normalised envelope description.

    Raises
    ------
    XdrDecodeError
        If the base64 payload is invalid or the envelope cannot be decoded.
    ValueError
        If *xdr_b64* is not a string.
    """
    if not isinstance(xdr_b64, str):
        raise ValueError(f"xdr_b64 must be a str, got {type(xdr_b64).__name__}")
    try:
        raw = base64.b64decode(xdr_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise XdrDecodeError(f"invalid base64 transaction envelope: {exc}") from exc
    return parse_transaction_envelope_bytes(raw)