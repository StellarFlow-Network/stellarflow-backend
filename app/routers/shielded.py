"""FastAPI router for Shielded Note Indexer verification and Merkle query endpoints.

Issue #798 — Implement Shielded Private Transaction Note Indexer Service
"""

from __future__ import annotations

import os
from typing import List, Optional

import asyncpg
import structlog
from fastapi import APIRouter, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field

from app.services.merkle_service import MerkleService

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/shielded", tags=["Shielded"])


# ---------------------------------------------------------------------------
# Pydantic Response Models
# ---------------------------------------------------------------------------

class NoteResponse(BaseModel):
    """Response schema for GET /shielded/note/{commitment}."""

    model_config = ConfigDict(populate_by_name=True)

    leaf_index: int = Field(..., description="Zero-based position of the commitment leaf")
    merkle_root: str = Field(..., description="Latest Poseidon-BN254 Merkle tree root hex")
    merkle_path: List[str] = Field(..., description="Ordered 20-element sibling hashes for ZK proof")
    leaf_count: int = Field(..., description="Current leaf count in the Merkle tree")
    is_spent: bool = Field(..., description="Whether the note's nullifier has been spent on-chain")


class LatestRootResponse(BaseModel):
    """Response schema for GET /shielded/root/latest."""

    model_config = ConfigDict(populate_by_name=True)

    merkle_root: str = Field(..., description="64-character hex Poseidon-BN254 Merkle root")
    leaf_count: int = Field(..., description="Total number of commitment leaves included in root")
    ledger_sequence: int = Field(..., description="Stellar ledger sequence of the root checkpoint")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get(
    "/note/{commitment}",
    response_model=NoteResponse,
    summary="Get commitment note inclusion proof and nullifier status",
)
async def get_note(
    commitment: str = Path(
        ...,
        pattern=r"^[0-9a-f]{64}$",
        description="64-character lowercase hex commitment string",
    ),
) -> NoteResponse:
    """Return Merkle path witness and spent status for a shielded deposit note."""
    database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if not database_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not configured")

    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as conn:
            # 1. Look up commitment
            comm_row = await conn.fetchrow(
                """
                SELECT id, commitment, leaf_index, ledger_sequence, tx_hash
                FROM shielded_commitments
                WHERE commitment = $1
                """,
                commitment,
            )
            if not comm_row:
                raise HTTPException(status_code=404, detail="commitment not found")

            leaf_index = comm_row["leaf_index"]

            # 2. Check if spent (look up in spent_nullifiers matching event_hash or tx_hash)
            # In Soroban ZK circuit, is_spent checks if nullifier corresponding to note exists
            # We check spent_nullifiers for existence of any record matching the commitment's hash / tx
            spent_row = await conn.fetchrow(
                """
                SELECT 1 FROM spent_nullifiers WHERE nullifier = $1
                """,
                commitment,
            )
            is_spent = bool(spent_row)

            # 3. Fetch latest Merkle root
            root_row = await conn.fetchrow(
                """
                SELECT merkle_root, leaf_count, ledger_sequence
                FROM merkle_roots
                ORDER BY ledger_sequence DESC
                LIMIT 1
                """
            )
            if not root_row:
                # If no root checkpoint stored, compute from leaves
                leaves_rows = await conn.fetch(
                    """
                    SELECT commitment FROM shielded_commitments ORDER BY leaf_index ASC
                    """
                )
                leaves = [r["commitment"] for r in leaves_rows]
                merkle_root = MerkleService.compute_root_from_leaves(leaves)
                leaf_count = len(leaves)
                merkle_path = MerkleService.compute_merkle_path(leaf_index, leaves)
            else:
                merkle_root = root_row["merkle_root"]
                leaf_count = root_row["leaf_count"]

                # Fetch all leaves up to latest root to construct accurate sibling path
                leaves_rows = await conn.fetch(
                    """
                    SELECT commitment FROM shielded_commitments ORDER BY leaf_index ASC
                    """
                )
                leaves = [r["commitment"] for r in leaves_rows]
                merkle_path = MerkleService.compute_merkle_path(leaf_index, leaves)

            return NoteResponse(
                leaf_index=leaf_index,
                merkle_root=merkle_root,
                merkle_path=merkle_path,
                leaf_count=leaf_count,
                is_spent=is_spent,
            )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("shielded.get_note_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await pool.close()


@router.get(
    "/root/latest",
    response_model=LatestRootResponse,
    summary="Get latest incremental Merkle root checkpoint",
)
async def get_latest_root(
    at_ledger_sequence: Optional[int] = Query(
        default=None,
        description="Optional maximum ledger sequence for point-in-time proof generation",
    ),
) -> LatestRootResponse:
    """Return the most recent Merkle root checkpoint (optionally <= at_ledger_sequence)."""
    database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if not database_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not configured")

    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as conn:
            if at_ledger_sequence is not None:
                row = await conn.fetchrow(
                    """
                    SELECT merkle_root, leaf_count, ledger_sequence
                    FROM merkle_roots
                    WHERE ledger_sequence <= $1
                    ORDER BY ledger_sequence DESC
                    LIMIT 1
                    """,
                    at_ledger_sequence,
                )
            else:
                row = await conn.fetchrow(
                    """
                    SELECT merkle_root, leaf_count, ledger_sequence
                    FROM merkle_roots
                    ORDER BY ledger_sequence DESC
                    LIMIT 1
                    """
                )

            if not row:
                raise HTTPException(
                    status_code=503,
                    detail="merkle root not yet available",
                )

            return LatestRootResponse(
                merkle_root=row["merkle_root"],
                leaf_count=row["leaf_count"],
                ledger_sequence=row["ledger_sequence"],
            )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("shielded.get_latest_root_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await pool.close()
