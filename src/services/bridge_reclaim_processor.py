"""Idempotent bridge reclaim processing orchestration.

The verifier owns chain-specific proof checks. This module coordinates the
reclaim workflow and deliberately receives transaction construction and
broadcast functions so signing keys remain outside the event worker.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from src.network.bridge_lock_verifier import (
    BridgeLockVerificationWorker,
    ChainType,
    LockProof,
    VerificationStatus,
)


@dataclass(frozen=True)
class BridgeReclaimRequest:
    request_id: str
    chain_type: str
    lock_tx_hash: str
    amount: int
    sender: str
    rpc_url: str
    required_confirmations: int = 12


class BridgeReclaimProcessor:
    """Process ``BridgeReclaimRequested`` events exactly once."""

    def __init__(
        self,
        verifier: BridgeLockVerificationWorker,
        build_unlock_transaction: Callable[[BridgeReclaimRequest], Any],
        broadcast_unlock_transaction: Callable[[Any], str],
    ) -> None:
        self.verifier = verifier
        self.build_unlock_transaction = build_unlock_transaction
        self.broadcast_unlock_transaction = broadcast_unlock_transaction
        self._processed: Dict[str, str] = {}

    def process(self, request: BridgeReclaimRequest) -> Dict[str, Any]:
        """Verify a failed destination lock and broadcast one unlock transaction."""
        previous = self._processed.get(request.request_id)
        if previous:
            return {"request_id": request.request_id, "status": "already_processed", "tx_hash": previous}

        try:
            chain_type = ChainType(request.chain_type.lower())
            proof = LockProof(
                job_id=request.request_id,
                chain_type=chain_type,  # verifier accepts the enum-compatible value
                tx_hash=request.lock_tx_hash,
                expected_amount=request.amount,
                expected_recipient=request.sender,
                rpc_url=request.rpc_url,
                required_confirmations=request.required_confirmations,
            )
            result = self.verifier.verify_proof(proof)
        except Exception as exc:
            return {"request_id": request.request_id, "status": "failed", "reason": str(exc)}

        status = result.get("status")
        if status != VerificationStatus.VERIFIED:
            return {
                "request_id": request.request_id,
                "status": str(status.value if hasattr(status, "value") else status),
                "verification": result,
            }

        transaction = self.build_unlock_transaction(request)
        tx_hash = self.broadcast_unlock_transaction(transaction)
        self._processed[request.request_id] = tx_hash
        return {"request_id": request.request_id, "status": "broadcast", "tx_hash": tx_hash}
