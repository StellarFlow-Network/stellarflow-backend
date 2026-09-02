"""app/models/audit.py — Immutable audit log model for administrative operations.

Stores cryptographically signed audit records for high-risk administrative
operations including key rotations, contract upgrades, and pause/unpause calls.
All records are immutable with SHA-256 hashes and Ed25519 signatures to ensure
tamper-proof audit trails.
"""

from __future__ import annotations

import hashlib
import base64
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from enum import Enum as PyEnum

from sqlalchemy import (
    DateTime,
    Integer,
    String,
    Text,
    Enum,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.events import _PartitionBase


class AdministrativeOperationType(str, PyEnum):
    """Enumeration of high-risk administrative operations that require audit logging."""
    KEY_ROTATION = "key_rotation"
    CONTRACT_UPGRADE = "contract_upgrade"
    PAUSE_CALL = "pause_call"
    UNPAUSE_CALL = "unpause_call"
    GOVERNANCE_PROPOSAL = "governance_proposal"
    GOVERNANCE_EXECUTION = "governance_execution"
    ACCESS_GRANT = "access_grant"
    ACCESS_REVOKE = "access_revoke"
    CONFIGURATION_CHANGE = "configuration_change"


class AuditLog(_PartitionBase):
    """Immutable audit log record stored in the ``audit_logs`` table.

    All audit records are append-only and cryptographically signed. The record hash
    is computed over the immutable fields, and the signature proves the authenticity
    of the record. Once inserted, records cannot be modified.

    Attributes
    ----------
    id : int
        Auto-incrementing primary key.
    operation_type : AdministrativeOperationType
        The type of administrative operation being logged.
    actor : str
        The identifier of the entity that performed the operation (user, service, key ID).
    timestamp : datetime
        UTC timestamp when the operation occurred (partition key).
    payload : dict
        The full operation payload containing all relevant details.
    record_hash : str
        SHA-256 hash of the canonical record fields for integrity verification.
    signature : str
        Base64-encoded Ed25519 signature of the record_hash.
    key_id : str
        The identifier of the signing key used to create the signature.
    ip_address : Optional[str]
        The source IP address of the actor, if available.
    user_agent : Optional[str]
        The user agent string of the client that initiated the operation.
    transaction_hash : Optional[str]
        On-chain transaction hash if the operation was executed on a blockchain.
    """

    __tablename__ = "audit_logs"

    # -- Columns ----------------------------------------------------------

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
        comment="Auto-incrementing audit log record ID",
    )

    operation_type: Mapped[AdministrativeOperationType] = mapped_column(
        Enum(AdministrativeOperationType, name="operation_type"),
        nullable=False,
        index=True,
        comment="Type of administrative operation",
    )

    actor: Mapped[str] = mapped_column(
        String(256),
        nullable=False,
        index=True,
        comment="Identifier of the entity that performed the operation",
    )

    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
        default=lambda: datetime.now(timezone.utc),
        comment="UTC timestamp of the operation (partition key)",
    )

    payload: Mapped[Dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        comment="Full operation payload with all relevant details",
    )

    record_hash: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
        comment="SHA-256 hash of canonical record fields",
    )

    signature: Mapped[str] = mapped_column(
        String(512),
        nullable=False,
        comment="Base64-encoded Ed25519 signature of record_hash",
    )

    key_id: Mapped[str] = mapped_column(
        String(256),
        nullable=False,
        index=True,
        comment="ID of the signing key used to create the signature",
    )

    ip_address: Mapped[Optional[str]] = mapped_column(
        String(45),  # Supports IPv6 addresses
        nullable=True,
        index=True,
        comment="Source IP address of the actor",
    )

    user_agent: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
        comment="User agent string of the initiating client",
    )

    transaction_hash: Mapped[Optional[str]] = mapped_column(
        String(128),
        nullable=True,
        index=True,
        comment="On-chain transaction hash if applicable",
    )

    def compute_record_hash(self) -> str:
        """Compute the SHA-256 hash of the canonical record fields.

        Creates a deterministic string representation of the record's immutable
        fields and hashes it to produce a unique fingerprint. This hash is then
        signed to provide authenticity and integrity guarantees.

        Returns
        -------
        str
            Hex-encoded SHA-256 hash of the canonical record.
        """
        # Create a canonical string representation of the immutable fields
        canonical = f"{self.operation_type}:{self.actor}:{self.timestamp.isoformat()}:{str(self.payload)}"
        return hashlib.sha256(canonical.encode('utf-8')).hexdigest()

    def verify_integrity(self) -> bool:
        """Verify that the record hasn't been tampered with by recomputing the hash.

        Returns
        -------
        bool
            True if the stored record_hash matches the recomputed hash, False otherwise.
        """
        computed_hash = self.compute_record_hash()
        return computed_hash == self.record_hash