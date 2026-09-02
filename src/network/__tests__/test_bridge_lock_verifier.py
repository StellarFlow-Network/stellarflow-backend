import sqlite3
import pytest
from unittest.mock import MagicMock
from src.network.bridge_lock_verifier import (
    BridgeLockVerificationWorker,
    LockProof,
    ChainType,
    VerificationStatus,
)


@pytest.fixture
def mock_session():
    return MagicMock()


@pytest.fixture
def in_memory_db():
    conn = sqlite3.connect(":memory:")
    yield conn
    conn.close()


def test_evm_verification_success(mock_session):
    worker = BridgeLockVerificationWorker(session=mock_session)
    proof = LockProof(
        job_id="job-101",
        chain_type=ChainType.EVM,
        tx_hash="0xabc123",
        expected_amount=1000,
        expected_recipient="GABC...",
        rpc_url="http://localhost:8545",
        required_confirmations=12,
    )

    receipt_mock = MagicMock()
    receipt_mock.json.return_value = {
        "result": {"status": "0x1", "blockNumber": "0x64", "logs": []}
    }
    receipt_mock.raise_for_status = MagicMock()

    block_mock = MagicMock()
    block_mock.json.return_value = {"result": "0x78"}
    block_mock.raise_for_status = MagicMock()

    mock_session.post.side_effect = [receipt_mock, block_mock]

    result = worker.verify_proof(proof)
    assert result["valid"] is True
    assert result["status"] == VerificationStatus.VERIFIED
    assert result["confirmations"] == 20
    assert result["expected_amount"] == 1000


def test_evm_verification_pending(mock_session):
    worker = BridgeLockVerificationWorker(session=mock_session)
    proof = LockProof(
        job_id="job-pending",
        chain_type=ChainType.EVM,
        tx_hash="0xabc123",
        expected_amount=1000,
        expected_recipient="GABC...",
        rpc_url="http://localhost:8545",
    )

    receipt_mock = MagicMock()
    receipt_mock.json.return_value = {"result": None}
    receipt_mock.raise_for_status = MagicMock()
    mock_session.post.return_value = receipt_mock

    result = worker.verify_proof(proof)
    assert result["valid"] is False
    assert result["status"] == VerificationStatus.PENDING


def test_solana_verification_finalized(mock_session):
    worker = BridgeLockVerificationWorker(session=mock_session)
    proof = LockProof(
        job_id="job-103",
        chain_type=ChainType.SOLANA,
        tx_hash="solana_signature_xyz",
        expected_amount=500,
        expected_recipient="GABC...",
        rpc_url="http://localhost:8899",
    )

    solana_mock = MagicMock()
    solana_mock.json.return_value = {
        "result": {
            "value": [
                {
                    "slot": 987654,
                    "confirmations": None,
                    "err": None,
                    "confirmationStatus": "finalized",
                }
            ]
        }
    }
    solana_mock.raise_for_status = MagicMock()
    mock_session.post.return_value = solana_mock

    result = worker.verify_proof(proof)
    assert result["valid"] is True
    assert result["status"] == VerificationStatus.VERIFIED
    assert result["slot"] == 987654


def test_solana_verification_pending(mock_session):
    worker = BridgeLockVerificationWorker(session=mock_session)
    proof = LockProof(
        job_id="job-sol-pending",
        chain_type=ChainType.SOLANA,
        tx_hash="solana_signature_xyz",
        expected_amount=500,
        expected_recipient="GABC...",
        rpc_url="http://localhost:8899",
    )

    solana_mock = MagicMock()
    solana_mock.json.return_value = {"result": {"value": [None]}}
    solana_mock.raise_for_status = MagicMock()
    mock_session.post.return_value = solana_mock

    result = worker.verify_proof(proof)
    assert result["valid"] is False
    assert result["status"] == VerificationStatus.PENDING


def test_merkle_inclusion_proof_verifies_against_block_header():
    worker = BridgeLockVerificationWorker()
    leaf_hash = "0xabc123"
    sibling_hash = "0xdef456"
    root_hash = worker._merkle_root_from_branch(leaf_hash, [sibling_hash], 0)

    result = worker.verify_merkle_inclusion_proof(
        leaf_hash=leaf_hash,
        proof_hashes=[sibling_hash],
        index=0,
        expected_root=root_hash,
        block_header={"stateRoot": root_hash},
    )

    assert result["valid"] is True
    assert result["status"] == VerificationStatus.VERIFIED
    assert result["root_hash"] == root_hash


def test_record_verified_proof_prevents_replay_and_emits_queue_payload(in_memory_db, mock_session):
    worker = BridgeLockVerificationWorker(session=mock_session)
    job_id = "job-proofs-replay"
    queue = []

    first = worker.record_verified_proof(
        in_memory_db,
        job_id=job_id,
        chain_type=ChainType.EVM,
        tx_hash="0xdeadbeef",
        proof_root="0xroot123",
        payload={"recipient": "GABC...", "amount": 42},
        queue_sender=lambda payload: queue.append(payload),
    )

    assert first is True
    assert queue and queue[0]["job_id"] == job_id
    assert queue[0]["status"] == "VERIFIED"

    second = worker.record_verified_proof(
        in_memory_db,
        job_id=job_id,
        chain_type=ChainType.EVM,
        tx_hash="0xdeadbeef",
        proof_root="0xroot123",
        payload={"recipient": "GABC...", "amount": 42},
        queue_sender=lambda payload: queue.append(payload),
    )

    assert second is False


def test_log_verified_job_in_database(in_memory_db, mock_session):
    worker = BridgeLockVerificationWorker(session=mock_session)
    job_id = "job-sqlite-test"
    worker.log_verified_job(in_memory_db, job_id, VerificationStatus.VERIFIED, "Verified at block 120", commit=True)

    cursor = in_memory_db.cursor()
    cursor.execute("SELECT status, details FROM bridge_lock_verifications WHERE job_id = ?", (job_id,))
    row = cursor.fetchone()

    assert row is not None
    assert row[0] == "VERIFIED"