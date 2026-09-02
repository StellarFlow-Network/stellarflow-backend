from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)


class ChainType(str, Enum):
    EVM = "evm"
    SOLANA = "solana"


class VerificationStatus(str, Enum):
    PENDING = "PENDING"
    VERIFIED = "VERIFIED"
    FAILED = "FAILED"
    WAITING_CONFIRMATIONS = "WAITING_CONFIRMATIONS"


@dataclass(frozen=True)
class LockProof:
    job_id: str
    chain_type: ChainType
    tx_hash: str
    expected_amount: int
    expected_recipient: str
    rpc_url: str
    required_confirmations: int = 12


class BridgeLockVerificationWorker:
    """Worker verifying cross-chain lock proofs against EVM and Solana RPCs."""

    def __init__(self, timeout_sec: float = 10.0, session: Optional[requests.Session] = None) -> None:
        self.timeout_sec = timeout_sec
        self.session = session or requests.Session()

    @staticmethod
    def _normalize_hash(value: str) -> bytes:
        if value is None:
            raise ValueError("hash value is required")
        text = str(value).strip()
        if text.startswith("0x") or text.startswith("0X"):
            text = text[2:]
        if len(text) % 2 != 0:
            text = f"0{text}"
        try:
            return bytes.fromhex(text)
        except ValueError:
            return text.encode("utf-8")

    @staticmethod
    def _hash_pair(left: bytes, right: bytes) -> bytes:
        return hashlib.sha256(left + right).digest()

    def _merkle_root_from_branch(self, leaf_hash: str, proof_hashes: List[str], index: int) -> str:
        """Compute a Merkle root from a leaf hash and a sibling proof path."""
        if proof_hashes is None:
            proof_hashes = []
        current = self._normalize_hash(leaf_hash)
        idx = int(index)
        for sibling in proof_hashes:
            sibling_bytes = self._normalize_hash(sibling)
            if idx % 2 == 0:
                current = self._hash_pair(current, sibling_bytes)
            else:
                current = self._hash_pair(sibling_bytes, current)
            idx //= 2
        return "0x" + current.hex()

    @staticmethod
    def extract_block_root(block_header: Optional[Dict[str, Any]]) -> Optional[str]:
        if not isinstance(block_header, dict):
            return None
        for key in ("stateRoot", "state_root", "merkleRoot", "merkle_root", "root"):
            value = block_header.get(key)
            if value is not None:
                return str(value)
        return None

    def verify_merkle_inclusion_proof(
        self,
        *,
        leaf_hash: str,
        proof_hashes: List[str],
        index: int,
        expected_root: Optional[str] = None,
        block_header: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Validate a Merkle branch against a block header root or an explicit expected root."""
        root_from_header = self.extract_block_root(block_header)
        root = expected_root or root_from_header
        if not root:
            return {"valid": False, "status": VerificationStatus.FAILED, "reason": "No Merkle root available"}

        computed_root = self._merkle_root_from_branch(leaf_hash, proof_hashes or [], index)
        root_is_valid = computed_root.lower() == root.lower()

        if not root_is_valid:
            return {
                "valid": False,
                "status": VerificationStatus.FAILED,
                "reason": "Merkle proof did not match expected root",
                "computed_root": computed_root,
                "expected_root": root,
            }

        return {
            "valid": True,
            "status": VerificationStatus.VERIFIED,
            "root_hash": computed_root,
            "expected_root": root,
        }

    def verify_evm_tx(self, proof: LockProof) -> Dict[str, Any]:
        """Queries EVM JSON-RPC for receipt execution status, confirmation depth, and logs."""
        receipt_payload = {
            "jsonrpc": "2.0",
            "method": "eth_getTransactionReceipt",
            "params": [proof.tx_hash],
            "id": 1,
        }
        try:
            resp = self.session.post(proof.rpc_url, json=receipt_payload, timeout=self.timeout_sec)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            logger.error("EVM RPC receipt query error for %s: %s", proof.tx_hash, exc)
            return {"valid": False, "status": VerificationStatus.FAILED, "error": str(exc)}

        if data.get("error") is not None:
            return {
                "valid": False,
                "status": VerificationStatus.FAILED,
                "reason": f"EVM JSON-RPC error: {data.get('error')}",
            }

        receipt = data.get("result")
        if receipt is None:
            return {
                "valid": False,
                "status": VerificationStatus.PENDING,
                "reason": "Receipt not found (pending or unmined transaction)",
            }

        if receipt.get("status") != "0x1":
            return {"valid": False, "status": VerificationStatus.FAILED, "reason": "Transaction reverted on-chain"}

        tx_block_hex = receipt.get("blockNumber")
        if not tx_block_hex:
            return {"valid": False, "status": VerificationStatus.FAILED, "reason": "No block number in receipt"}

        tx_block = int(tx_block_hex, 16)

        block_payload = {
            "jsonrpc": "2.0",
            "method": "eth_blockNumber",
            "params": [],
            "id": 2,
        }
        try:
            resp = self.session.post(proof.rpc_url, json=block_payload, timeout=self.timeout_sec)
            resp.raise_for_status()
            block_data = resp.json()
        except Exception as exc:
            logger.error("EVM RPC block query error: %s", exc)
            return {"valid": False, "status": VerificationStatus.FAILED, "error": str(exc)}

        if block_data.get("error") is not None:
            return {
                "valid": False,
                "status": VerificationStatus.FAILED,
                "reason": f"EVM JSON-RPC error: {block_data.get('error')}",
            }

        current_block = int(block_data.get("result", "0x0"), 16)
        confirmations = max(0, current_block - tx_block)

        if confirmations < proof.required_confirmations:
            return {
                "valid": False,
                "status": VerificationStatus.WAITING_CONFIRMATIONS,
                "confirmations": confirmations,
                "required": proof.required_confirmations,
                "tx_block": tx_block,
                "current_block": current_block,
            }

        logs = receipt.get("logs", [])
        return {
            "valid": True,
            "status": VerificationStatus.VERIFIED,
            "confirmations": confirmations,
            "block_number": tx_block,
            "expected_amount": proof.expected_amount,
            "expected_recipient": proof.expected_recipient,
            "logs": logs,
        }

    def verify_solana_tx(self, proof: LockProof) -> Dict[str, Any]:
        """Queries Solana RPC getSignatureStatuses with finalized commitment."""
        payload = {
            "jsonrpc": "2.0",
            "method": "getSignatureStatuses",
            "params": [[proof.tx_hash], {"searchTransactionHistory": True, "commitment": "finalized"}],
            "id": 1,
        }
        try:
            resp = self.session.post(proof.rpc_url, json=payload, timeout=self.timeout_sec)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            logger.error("Solana RPC query error for %s: %s", proof.tx_hash, exc)
            return {"valid": False, "status": VerificationStatus.FAILED, "error": str(exc)}

        if data.get("error") is not None:
            return {
                "valid": False,
                "status": VerificationStatus.FAILED,
                "reason": f"Solana JSON-RPC error: {data.get('error')}",
            }

        statuses = data.get("result", {}).get("value", [])
        if not statuses or statuses[0] is None:
            return {
                "valid": False,
                "status": VerificationStatus.PENDING,
                "reason": "Signature not found (transaction pending or unfinalized)",
            }

        status_info = statuses[0]
        if status_info.get("err") is not None:
            return {
                "valid": False,
                "status": VerificationStatus.FAILED,
                "reason": f"Solana tx execution error: {status_info['err']}",
            }

        confirmation_status = status_info.get("confirmationStatus")
        if confirmation_status != "finalized":
            return {
                "valid": False,
                "status": VerificationStatus.WAITING_CONFIRMATIONS,
                "confirmation_status": confirmation_status,
                "slot": status_info.get("slot"),
            }

        return {
            "valid": True,
            "status": VerificationStatus.VERIFIED,
            "slot": status_info.get("slot"),
            "confirmations": status_info.get("confirmations"),
            "expected_amount": proof.expected_amount,
            "expected_recipient": proof.expected_recipient,
        }

    def verify_proof(self, proof: LockProof) -> Dict[str, Any]:
        """Verifies lock proof according to chain type."""
        if proof.chain_type == ChainType.EVM:
            return self.verify_evm_tx(proof)
        elif proof.chain_type == ChainType.SOLANA:
            return self.verify_solana_tx(proof)
        else:
            raise ValueError(f"Unsupported chain: {proof.chain_type}")

    def record_verified_proof(
        self,
        db_connection: sqlite3.Connection,
        *,
        job_id: str,
        chain_type: ChainType,
        tx_hash: str,
        proof_root: str,
        payload: Dict[str, Any],
        queue_sender: Optional[Callable[[Dict[str, Any]], Any]] = None,
        commit: bool = True,
    ) -> bool:
        """Persist a verified proof and emit the relayer payload exactly once."""
        db_connection.execute(
            """
            CREATE TABLE IF NOT EXISTS bridge_proof_verifications (
                job_id TEXT PRIMARY KEY,
                chain_type TEXT NOT NULL,
                tx_hash TEXT NOT NULL,
                proof_root TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """
        )

        existing = db_connection.execute(
            "SELECT 1 FROM bridge_proof_verifications WHERE job_id = ? OR (chain_type = ? AND tx_hash = ? AND proof_root = ?) LIMIT 1",
            (job_id, chain_type.value, tx_hash, proof_root),
        ).fetchone()
        if existing is not None:
            return False

        payload_blob = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        epoch_ms = int(time.time() * 1000)
        db_connection.execute(
            """
            INSERT INTO bridge_proof_verifications (job_id, chain_type, tx_hash, proof_root, payload, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (job_id, chain_type.value, tx_hash, proof_root, payload_blob, VerificationStatus.VERIFIED.value, epoch_ms),
        )

        relayer_payload = {
            "job_id": job_id,
            "chain_type": chain_type.value,
            "tx_hash": tx_hash,
            "proof_root": proof_root,
            "status": VerificationStatus.VERIFIED.value,
            "payload": payload,
        }
        if queue_sender is not None:
            queue_sender(relayer_payload)

        if commit:
            db_connection.commit()

        return True

    def log_verified_job(
        self,
        db_connection: sqlite3.Connection,
        job_id: str,
        status: VerificationStatus,
        details: Optional[str] = None,
        *,
        commit: bool = True,
    ) -> None:
        """Logs/persists verified bridge jobs prior to relayer dispatch."""
        epoch_ms = int(time.time() * 1000)
        db_connection.execute(
            """
            CREATE TABLE IF NOT EXISTS bridge_lock_verifications (
                job_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                details TEXT,
                updated_at INTEGER NOT NULL
            )
            """
        )
        db_connection.execute(
            """
            INSERT INTO bridge_lock_verifications (job_id, status, details, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                status = excluded.status,
                details = excluded.details,
                updated_at = excluded.updated_at
            """,
            (job_id, status.value, details, epoch_ms),
        )
        if commit:
            db_connection.commit()