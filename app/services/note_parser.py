"""app/services/note_parser.py — Parse NoteDeposited and NullifierSpent contract events.

Decodes and validates NoteDeposited and NullifierSpent events emitted by
Soroban contracts, writing validated records to `shielded_commitments` and
`spent_nullifiers` in PostgreSQL.
"""

from __future__ import annotations

import re
from typing import Any, List, Optional, Tuple

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.events import LedgerEvent
from app.models.shielded import ShieldedCommitment, SpentNullifier

# Prometheus metrics setup (with fallback mock if prometheus_client not available)
try:
    from prometheus_client import Counter

    note_parse_error_total = Counter(
        "note_parse_error_total",
        "Total number of NoteDeposited event parsing errors",
        ["reason"],
    )
    nullifier_parse_error_total = Counter(
        "nullifier_parse_error_total",
        "Total number of NullifierSpent event parsing errors",
        ["reason"],
    )
    nullifier_duplicate_total = Counter(
        "nullifier_duplicate_total",
        "Total number of duplicate nullifiers encountered",
    )
    commitments_indexed_total = Counter(
        "commitments_indexed_total",
        "Total number of commitments indexed",
    )
    nullifiers_indexed_total = Counter(
        "nullifiers_indexed_total",
        "Total number of spent nullifiers indexed",
    )
except ImportError:
    class _MockMetric:
        def inc(self, amount: int = 1) -> None:
            pass
        def labels(self, *args: Any, **kwargs: Any) -> _MockMetric:
            return self

    note_parse_error_total = _MockMetric()
    nullifier_parse_error_total = _MockMetric()
    nullifier_duplicate_total = _MockMetric()
    commitments_indexed_total = _MockMetric()
    nullifiers_indexed_total = _MockMetric()

log = structlog.get_logger(__name__)

HEX64_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class NoteParser:
    """Service to parse and index NoteDeposited and NullifierSpent ledger events."""

    @staticmethod
    def _validate_hex64(value: Optional[str]) -> bool:
        """Return True iff value is a non-empty string of exactly 64 lowercase hex characters."""
        if not isinstance(value, str):
            return False
        return bool(HEX64_PATTERN.fullmatch(value))

    async def _next_leaf_index(self, session: AsyncSession) -> int:
        """Return MAX(leaf_index) + 1 from shielded_commitments, or 0 if empty."""
        stmt = select(func.max(ShieldedCommitment.leaf_index))
        result = await session.execute(stmt)
        max_idx = result.scalar_one_or_none()
        return (max_idx + 1) if max_idx is not None else 0

    async def parse_batch(
        self,
        session: AsyncSession,
        events: List[LedgerEvent],
    ) -> Tuple[int, int]:
        """Parse a batch of LedgerEvent records and persist new commitments/nullifiers.

        Parameters
        ----------
        session : AsyncSession
            Active async database session.
        events : list[LedgerEvent]
            Collection of LedgerEvent objects to process.

        Returns
        -------
        tuple[int, int]
            (commitments_indexed_count, nullifiers_indexed_count)
        """
        if not events:
            return 0, 0

        # Sort incoming events deterministically by (ledger_sequence, payload.index)
        def _sort_key(ev: LedgerEvent) -> Tuple[int, int]:
            idx = 0
            if isinstance(ev.payload, dict):
                idx = int(ev.payload.get("index", 0) or 0)
            return (ev.ledger_sequence, idx)

        sorted_events = sorted(events, key=_sort_key)

        commitments_indexed = 0
        nullifiers_indexed = 0

        current_leaf_index = await self._next_leaf_index(session)

        for event in sorted_events:
            event_type = event.event_type
            payload = event.payload

            if payload is None or not isinstance(payload, dict):
                if event_type == "note_deposited":
                    note_parse_error_total.labels(reason="missing_or_null_payload").inc()
                    log.warning(
                        "note_deposited.invalid_payload",
                        event_hash=event.event_hash,
                        ledger_sequence=event.ledger_sequence,
                        reason="missing_or_null_payload",
                    )
                elif event_type == "nullifier_spent":
                    nullifier_parse_error_total.labels(reason="missing_or_null_payload").inc()
                    log.warning(
                        "nullifier_spent.invalid_payload",
                        event_hash=event.event_hash,
                        ledger_sequence=event.ledger_sequence,
                        reason="missing_or_null_payload",
                    )
                continue

            if event_type == "note_deposited":
                commitment_val = payload.get("commitment")
                if not self._validate_hex64(commitment_val):
                    note_parse_error_total.labels(reason="invalid_hex64").inc()
                    log.error(
                        "note_deposited.invalid_commitment",
                        event_hash=event.event_hash,
                        ledger_sequence=event.ledger_sequence,
                        commitment=commitment_val,
                    )
                    continue

                # Deduplication check by event_hash
                existing_stmt = select(ShieldedCommitment).where(
                    ShieldedCommitment.event_hash == event.event_hash
                )
                existing_res = await session.execute(existing_stmt)
                if existing_res.scalar_one_or_none() is not None:
                    log.debug(
                        "note_deposited.duplicate_event_hash_skipped",
                        event_hash=event.event_hash,
                        ledger_sequence=event.ledger_sequence,
                    )
                    continue

                # Also check if commitment hex already exists
                existing_comm_stmt = select(ShieldedCommitment).where(
                    ShieldedCommitment.commitment == commitment_val
                )
                existing_comm_res = await session.execute(existing_comm_stmt)
                if existing_comm_res.scalar_one_or_none() is not None:
                    log.debug(
                        "note_deposited.duplicate_commitment_skipped",
                        commitment=commitment_val,
                        ledger_sequence=event.ledger_sequence,
                    )
                    continue

                commitment_record = ShieldedCommitment(
                    commitment=commitment_val,
                    leaf_index=current_leaf_index,
                    ledger_sequence=event.ledger_sequence,
                    tx_hash=event.tx_hash,
                    event_hash=event.event_hash,
                )
                session.add(commitment_record)
                current_leaf_index += 1
                commitments_indexed += 1
                commitments_indexed_total.inc()

            elif event_type == "nullifier_spent":
                nullifier_val = payload.get("nullifier")
                if not self._validate_hex64(nullifier_val):
                    nullifier_parse_error_total.labels(reason="invalid_hex64").inc()
                    log.error(
                        "nullifier_spent.invalid_nullifier",
                        event_hash=event.event_hash,
                        ledger_sequence=event.ledger_sequence,
                        nullifier=nullifier_val,
                    )
                    continue

                # Deduplication / double spend check on nullifier
                existing_nullifier_stmt = select(SpentNullifier).where(
                    SpentNullifier.nullifier == nullifier_val
                )
                existing_nullifier_res = await session.execute(existing_nullifier_stmt)
                if existing_nullifier_res.scalar_one_or_none() is not None:
                    nullifier_duplicate_total.inc()
                    log.warning(
                        "nullifier_spent.duplicate_nullifier_skipped",
                        nullifier=nullifier_val,
                        ledger_sequence=event.ledger_sequence,
                    )
                    continue

                spent_record = SpentNullifier(
                    nullifier=nullifier_val,
                    ledger_sequence=event.ledger_sequence,
                    tx_hash=event.tx_hash,
                    event_hash=event.event_hash,
                )
                session.add(spent_record)
                nullifiers_indexed += 1
                nullifiers_indexed_total.inc()

        return commitments_indexed, nullifiers_indexed
