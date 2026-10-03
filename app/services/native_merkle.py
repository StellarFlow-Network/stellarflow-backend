"""ctypes binding for the Rust shielded-tree update library.

The boundary uses packed 32-byte field elements, never JSON, and exposes only
append operations required by the persistence service.  The library is loaded
from ``SHIELDED_MERKLE_NATIVE_LIB`` (or its standard build output location).
"""

from __future__ import annotations

import ctypes
import os
from pathlib import Path
from typing import Sequence


class NativeMerkleError(ValueError):
    """A validated native Merkle update could not be completed."""


class NativeMerkle:
    MAX_DEPTH = 32

    def __init__(self) -> None:
        self._lib = self._load()
        self._append = self._lib.stellarflow_merkle_append
        self._append.argtypes = [
            ctypes.c_uint32, ctypes.c_uint64,
            ctypes.POINTER(ctypes.c_ubyte), ctypes.POINTER(ctypes.c_ubyte), ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_ubyte), ctypes.POINTER(ctypes.c_ubyte),
        ]
        self._append.restype = ctypes.c_int

    @staticmethod
    def _load() -> ctypes.CDLL:
        configured = os.getenv("SHIELDED_MERKLE_NATIVE_LIB")
        names = [configured] if configured else []
        root = Path(__file__).resolve().parents[2]
        names.extend(str(root / "native" / "shielded_merkle" / "target" / profile / filename)
                     for profile in ("release", "debug")
                     for filename in ("libstellarflow_shielded_merkle.so", "libstellarflow_shielded_merkle.dylib", "stellarflow_shielded_merkle.dll"))
        for name in names:
            if name and Path(name).is_file():
                return ctypes.CDLL(name)
        raise NativeMerkleError("Rust shielded Merkle library is not available")

    @staticmethod
    def _elements(values: Sequence[str], *, depth: int | None = None) -> bytes:
        expected = depth if depth is not None else len(values)
        if len(values) != expected:
            raise NativeMerkleError("invalid frontier length")
        try:
            packed = b"".join(bytes.fromhex(value) for value in values)
        except (TypeError, ValueError) as exc:
            raise NativeMerkleError("Merkle elements must be 64-character hexadecimal strings") from exc
        if len(packed) != expected * 32:
            raise NativeMerkleError("Merkle elements must be exactly 32 bytes")
        return packed

    def append(self, *, depth: int, leaf_count: int, frontier: Sequence[str], leaves: Sequence[str]) -> tuple[str, list[str]]:
        if not 1 <= depth <= self.MAX_DEPTH or not 0 <= leaf_count < 1 << depth:
            raise NativeMerkleError("invalid tree depth or leaf count")
        if not leaves:
            raise NativeMerkleError("at least one leaf is required")
        state = self._elements(frontier, depth=depth)
        packed_leaves = self._elements(leaves)
        frontier_in = (ctypes.c_ubyte * len(state)).from_buffer_copy(state)
        leaves_in = (ctypes.c_ubyte * len(packed_leaves)).from_buffer_copy(packed_leaves)
        root_out = (ctypes.c_ubyte * 32)()
        frontier_out = (ctypes.c_ubyte * len(state))()
        code = self._append(depth, leaf_count, frontier_in, leaves_in, len(packed_leaves), root_out, frontier_out)
        if code:
            raise NativeMerkleError(f"native Merkle update rejected input (code {code})")
        raw_state = bytes(frontier_out)
        return bytes(root_out).hex(), [raw_state[offset:offset + 32].hex() for offset in range(0, len(raw_state), 32)]
