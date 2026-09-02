"""app/services/audit_logger.py — Service for creating and managing immutable audit logs.

Provides a centralized service to capture high-risk administrative operations,
cryptographically sign them using KMS, and store them in PostgreSQL. Ensures all
audit records are immutable, tamper-proof, and searchable for compliance purposes.
"""

from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog, AdministrativeOperationType
from app.security.kms import KeyRotationHandler, verify_signed_envelope, KeyHandle
from app.db.session import async_session_factory

logger = logging.getLogger(__name__)

__all__ = [
    "AuditLogger",
    "get_audit_logger",
    "log_administrative_operation",
]


class AuditLogger:
    """Service for creating and managing cryptographically signed audit logs.

    This service ensures that all high-risk administrative operations are captured,
    signed, and stored in an immutable audit trail. It integrates with the existing
    KMS infrastructure to use the same key management and signing capabilities.
    """

    def __init__(self, key_handler: KeyRotationHandler):
        """Initialize the audit logger with a KMS key handler for signing.

        Parameters
        ----------
        key_handler : KeyRotationHandler
            The active key rotation handler that provides access to signing keys.
        """
        self.key_handler = key_handler

    async def log_operation(
        self,
        operation_type: AdministrativeOperationType,
        actor: str,
        payload: Dict[str, Any],
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        transaction_hash: Optional[str] = None,
        session: Optional[AsyncSession] = None,
    ) -> AuditLog:
        """Create and persist a new audit log record for an administrative operation.

        This method:
        1. Creates an AuditLog record with all provided metadata
        2. Computes the SHA-256 record hash for integrity
        3. Signs the hash using the active KMS signing key
        4. Stores the signed record in the database (append-only)

        Parameters
        ----------
        operation_type : AdministrativeOperationType
            The type of high-risk operation being logged.
        actor : str
            Identifier of the entity that performed the operation.
        payload : Dict[str, Any]
            All relevant details about the operation.
        ip_address : Optional[str]
            Source IP address of the actor, if available.
        user_agent : Optional[str]
            Client user agent string, if available.
        transaction_hash : Optional[str]
            On-chain transaction hash if the operation was executed on-chain.
        session : Optional[AsyncSession]
            Existing database session to use, if provided.

        Returns
        -------
        AuditLog
            The created and persisted audit log record.

        Raises
        ------
        RuntimeError
            If no active signing key is available to sign the record.
        Exception
            If database persistence fails.
        """
        # Get the active signing key
        active_key: Optional[KeyHandle] = self.key_handler.get_active_key()
        if not active_key:
            logger.error("No active signing key available to create audit log")
            raise RuntimeError("Cannot create audit log: no active signing key available")

        # Create the audit log record
        audit_record = AuditLog(
            operation_type=operation_type,
            actor=actor,
            timestamp=datetime.now(timezone.utc),
            payload=payload,
            ip_address=ip_address,
            user_agent=user_agent,
            transaction_hash=transaction_hash,
            key_id=active_key.key_id,
            # Placeholders that will be filled after computation
            record_hash="",
            signature="",
        )

        # Compute the record hash
        record_hash = audit_record.compute_record_hash()
        audit_record.record_hash = record_hash

        # Sign the record hash using the active key
        try:
            # The KMS sign method expects bytes, so we pass the hash as bytes
            signature_bytes = await self.key_handler.sign_bytes(record_hash.encode('utf-8'), active_key)
            audit_record.signature = base64.b64encode(signature_bytes).decode('utf-8')
        except Exception as exc:
            logger.error("Failed to sign audit log record: %s", exc)
            raise

        # Store the record in the database
        should_close_session = False
        if session is None:
            session = async_session_factory()
            should_close_session = True

        try:
            session.add(audit_record)
            await session.commit()
            await session.refresh(audit_record)
            logger.info(
                "Created audit log record: id=%s, operation=%s, actor=%s",
                audit_record.id, audit_record.operation_type, audit_record.actor
            )
            return audit_record
        except Exception as exc:
            await session.rollback()
            logger.error("Failed to persist audit log record: %s", exc)
            raise
        finally:
            if should_close_session:
                await session.close()

    async def verify_record(self, record: AuditLog) -> bool:
        """Verify the integrity and authenticity of an existing audit record.

        Parameters
        ----------
        record : AuditLog
            The audit record to verify.

        Returns
        -------
        bool
            True if the record is valid (unmodified and authentic), False otherwise.
        """
        # First verify the integrity (hash matches)
        if not record.verify_integrity():
            logger.warning("Audit record %s failed integrity check", record.id)
            return False

        # Get the key that was used to sign this record
        signing_key: Optional[KeyHandle] = self.key_handler.get_key_by_id(record.key_id)
        if not signing_key:
            logger.error("Could not find signing key %s for audit record %s", record.key_id, record.id)
            return False

        # Verify the signature
        try:
            signature_bytes = base64.b64decode(record.signature)
            record_hash_bytes = record.record_hash.encode('utf-8')
            return await self.key_handler.verify_signature(
                record_hash_bytes,
                signature_bytes,
                signing_key.public_key_b64
            )
        except Exception as exc:
            logger.error("Failed to verify audit record signature: %s", exc)
            return False


# Singleton instance
_audit_logger: Optional[AuditLogger] = None


def get_audit_logger() -> AuditLogger:
    """Get or create the singleton audit logger instance.

    Returns
    -------
    AuditLogger
        The global audit logger instance.

    Raises
    ------
    RuntimeError
        If the audit logger hasn't been initialized yet.
    """
    if _audit_logger is None:
        raise RuntimeError("Audit logger has not been initialized. Call init_audit_logger first.")
    return _audit_logger


def init_audit_logger(key_handler: KeyRotationHandler) -> None:
    """Initialize the global audit logger singleton.

    Parameters
    ----------
    key_handler : KeyRotationHandler
        The KMS key handler to use for signing audit records.
    """
    global _audit_logger
    _audit_logger = AuditLogger(key_handler)
    logger.info("Audit logger initialized successfully")


async def log_administrative_operation(
    operation_type: Union[AdministrativeOperationType, str],
    actor: str,
    payload: Dict[str, Any],
    **kwargs
) -> AuditLog:
    """Convenience function to quickly log an administrative operation.

    This is the primary interface that other parts of the system should use to
    create audit log records. It handles retrieving the global audit logger and
    passing through all parameters.

    Parameters
    ----------
    operation_type : Union[AdministrativeOperationType, str]
        The type of operation. If a string is provided, it will be converted to
        the appropriate enum value.
    actor : str
        Identifier of the entity that performed the operation.
    payload : Dict[str, Any]
        All details about the operation.
    **kwargs
        Additional keyword arguments passed to log_operation (ip_address, user_agent, etc.)

    Returns
    -------
    AuditLog
        The created audit record.
    """
    if isinstance(operation_type, str):
        operation_type = AdministrativeOperationType(operation_type)

    logger = get_audit_logger()
    return await logger.log_operation(operation_type, actor, payload, **kwargs)