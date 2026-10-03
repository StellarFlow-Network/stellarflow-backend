"""Incremental shielded Merkle tree service.

Leaves are append-only. ``tree_state.frontier`` stores the rightmost node at
each level so a checkpoint requires only one hash path per newly indexed leaf.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any, ClassVar, Dict, List, Optional, Sequence

import structlog
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.shielded import MerkleRoot, ShieldedCommitment
from app.security.proof_encryption import ProofEncryptor

try:
    from prometheus_client import Counter
    merkle_root_updates_total = Counter("merkle_root_updates_total", "Total number of Merkle root checkpoints persisted")
except ImportError:
    class _MockMetric:
        def inc(self, amount: int = 1) -> None:
            pass
    merkle_root_updates_total = _MockMetric()

log = structlog.get_logger(__name__)
BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617
HASH_SCHEME = "legacy-poseidon2-sha256-bn254-v1"


def _poseidon_bn254_2(left_int: int, right_int: int) -> int:
    """The existing persisted-tree hash reference.

    Historic code had no declared Poseidon parameter set and used this
    deterministic fallback. Keeping it explicit prevents host-dependent roots;
    the Rust binding implements the exact same rule.
    """
    payload = f"poseidon2:{left_int % BN254_PRIME}:{right_int % BN254_PRIME}".encode()
    return int.from_bytes(hashlib.sha256(payload).digest(), "big") % BN254_PRIME


class MerkleService:
    """Compute and atomically persist append-only shielded-tree checkpoints."""

    TREE_DEPTH: ClassVar[int] = int(os.getenv("SHIELDED_MERKLE_TREE_DEPTH", "32"))
    _native: ClassVar[NativeMerkle | None] = None
    _native_checked: ClassVar[bool] = False

    @classmethod
    def _validate_depth(cls, depth: int) -> None:
        if not 1 <= depth <= NativeMerkle.MAX_DEPTH:
            raise ValueError("Merkle tree depth must be between 1 and 32")

    @classmethod
    def _native_engine(cls) -> NativeMerkle | None:
        if not cls._native_checked:
            cls._native_checked = True
            try:
                cls._native = NativeMerkle()
            except NativeMerkleError:
                if os.getenv("SHIELDED_MERKLE_NATIVE_REQUIRED", "false").lower() == "true":
                    raise
                log.warning("shielded_merkle.native_unavailable", fallback="python_reference")
        return cls._native

    def __init__(self, encryptor: ProofEncryptor | None = None) -> None:
        self._encryptor = encryptor

    @classmethod
    def get_zero_value(cls, level: int = 0) -> str:
        if level < 0:
            raise ValueError("Merkle level cannot be negative")
        value = 0
        for _ in range(level):
            value = _poseidon_bn254_2(value, value)
        return f"{value:064x}"

    @classmethod
    def _element(cls, value: bytes | str) -> int:
        if isinstance(value, bytes):
            if len(value) != 32:
                raise ValueError("Merkle elements must be exactly 32 bytes")
            return int.from_bytes(value, "big")
        if not isinstance(value, str) or len(value) != 64:
            raise ValueError("Merkle elements must be 64-character hexadecimal strings")
        try:
            return int(value, 16)
        except ValueError as exc:
            raise ValueError("Merkle elements must be hexadecimal strings") from exc

    @classmethod
    def poseidon_hash(cls, left: bytes | str, right: bytes | str) -> str:
        return f"{_poseidon_bn254_2(cls._element(left), cls._element(right)):064x}"

    @classmethod
    def _append_reference(cls, frontier: Sequence[str], leaf_count: int, leaves: Sequence[str], depth: int) -> tuple[str, list[str]]:
        state = list(frontier)
        root = cls.get_zero_value(depth)
        for leaf in leaves:
            node = f"{cls._element(leaf):064x}"
            for level in range(depth):
                if not (leaf_count >> level) & 1:
                    state[level] = node
                    node = cls.poseidon_hash(node, cls.get_zero_value(level))
                else:
                    node = cls.poseidon_hash(state[level], node)
            root = node
            leaf_count += 1
        return root, state

    @classmethod
    def _append(cls, frontier: Sequence[str], leaf_count: int, leaves: Sequence[str], depth: int) -> tuple[str, list[str]]:
        cls._validate_depth(depth)
        if len(frontier) != depth or not leaves or leaf_count + len(leaves) > 1 << depth:
            raise ValueError("invalid incremental Merkle tree update")
        engine = cls._native_engine()
        if engine is not None:
            return engine.append(depth=depth, leaf_count=leaf_count, frontier=frontier, leaves=leaves)
        return cls._append_reference(frontier, leaf_count, leaves, depth)

    @classmethod
    def _initial_state(cls, depth: int) -> dict[str, Any]:
        return {"version": 1, "hash_scheme": HASH_SCHEME, "depth": depth, "frontier": [cls.get_zero_value(level) for level in range(depth)]}

    @classmethod
    def compute_root_from_leaves(cls, leaves: List[str], depth: int = 32) -> str:
        cls._validate_depth(depth)
        if len(leaves) > 1 << depth:
            raise ValueError("too many leaves for Merkle tree depth")
        if not leaves:
            return cls.get_zero_value(depth)
        root, _ = cls._append(cls._initial_state(depth)["frontier"], 0, leaves, depth)
        return root

    @classmethod
    def compute_merkle_path(cls, leaf_index: int, all_leaves: List[str], depth: int = 32) -> List[str]:
        cls._validate_depth(depth)
        if not 0 <= leaf_index < len(all_leaves) or len(all_leaves) > 1 << depth:
            raise ValueError("invalid leaf index")
        nodes: Dict[int, str] = {index: f"{cls._element(leaf):064x}" for index, leaf in enumerate(all_leaves)}
        path: List[str] = []
        index = leaf_index
        for level in range(depth):
            path.append(nodes.get(index ^ 1, cls.get_zero_value(level)))
            nodes = {parent: cls.poseidon_hash(nodes.get(parent * 2, cls.get_zero_value(level)), nodes.get(parent * 2 + 1, cls.get_zero_value(level))) for parent in range((max(nodes, default=-1) // 2) + 1)}
            index //= 2
        return path

    @classmethod
    def _state_for_checkpoint(cls, previous: MerkleRoot | None, prefix: Sequence[str], depth: int) -> tuple[int, list[str]]:
        if previous is not None:
            state = previous.tree_state or {}
            frontier = state.get("frontier")
            if state.get("version") == 1 and state.get("hash_scheme") == HASH_SCHEME and state.get("depth") == depth and isinstance(frontier, list) and len(frontier) == depth:
                return previous.leaf_count, frontier
        if not prefix:
            return 0, cls._initial_state(depth)["frontier"]
        _, frontier = cls._append(cls._initial_state(depth)["frontier"], 0, prefix, depth)
        return len(prefix), frontier

    async def update_root(self, session: AsyncSession, new_commitments: List[ShieldedCommitment], ledger_sequence: Optional[int] = None) -> Optional[MerkleRoot]:
        if not new_commitments:
            return None
        depth = self.TREE_DEPTH
        self._validate_depth(depth)
        target = ledger_sequence if ledger_sequence is not None else max(item.ledger_sequence for item in new_commitments)
        # The existing Celery queue can have more than one consumer.  Hold a
        # transaction-scoped PostgreSQL advisory lock before reading the latest
        # checkpoint so two workers cannot derive competing frontiers.  It is
        # released automatically on commit/rollback with the root insert.
        await session.execute(text("SELECT pg_advisory_xact_lock(83421901)"))
        if (await session.execute(select(MerkleRoot).where(MerkleRoot.ledger_sequence == target))).scalar_one_or_none() is not None:
            return None

        # Fetch all commitments up to this point in leaf_index order
        all_comm_stmt = (
            select(ShieldedCommitment.commitment)
            .order_by(ShieldedCommitment.leaf_index.asc())
        )
        all_comm_res = await session.execute(all_comm_stmt)
        all_leaves = [row[0] for row in all_comm_res.all()]

        new_root_hex = self.compute_root_from_leaves(all_leaves, depth=self.TREE_DEPTH)
        leaf_count = len(all_leaves)

        # Frontier state for incremental tree (first 20 level representative hashes)
        tree_state = {"frontier": [self.get_zero_value(i) for i in range(self.TREE_DEPTH)], "depth": self.TREE_DEPTH}

        merkle_root_row = MerkleRoot(
            merkle_root=new_root_hex,
            leaf_count=leaf_count,
            ledger_sequence=target_ledger_seq,
            tree_state=tree_state,
            encrypted_tree_state=(
                self._encryptor.encrypt(
                    tree_state, associated_data=f"tree:{target_ledger_seq}"
                ).as_dict()
                if self._encryptor is not None
                else None
            ),
        )
        session.add(merkle_root_row)
        merkle_root_updates_total.inc()
        log.info("merkle_root.updated", leaf_count=row.leaf_count, ledger_sequence=target)
        return row
