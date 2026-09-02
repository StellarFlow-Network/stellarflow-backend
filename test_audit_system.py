"""Test script to verify the audit logging system functionality.

This script demonstrates the complete flow of creating, storing, and verifying
audit log records for high-risk administrative operations.
"""

import asyncio
import base64
from datetime import datetime, timezone
from app.security.kms import KeyRotationHandler, LocalVaultProvider
from app.services.audit_logger import AuditLogger, log_administrative_operation, init_audit_logger, get_audit_logger
from app.models.audit import AuditLog, AdministrativeOperationType


async def test_audit_logging_system():
    """Test the complete audit logging workflow."""
    print("🚀 Starting audit logging system test...")
    
    # 1. Initialize KMS and audit logger
    print("\n1. Initializing KMS provider and key rotation handler...")
    provider = LocalVaultProvider()  # Uses stub mode for testing
    key_handler = KeyRotationHandler(provider)
    await key_handler.start()
    
    # Initialize the audit logger
    init_audit_logger(key_handler)
    audit_logger = get_audit_logger()
    print("✅ Audit logger initialized successfully")
    
    # 2. Create and log an administrative operation
    print("\n2. Creating a test key rotation audit record...")
    try:
        record = await audit_logger.log_operation(
            operation_type=AdministrativeOperationType.KEY_ROTATION,
            actor="test-admin@stellarflow.io",
            payload={
                "reason": "Test key rotation for audit system verification",
                "old_key_id": key_handler.active_key_id,
                "new_key_rotation_scheduled": True
            },
            ip_address="192.168.1.100",
            user_agent="TestScript/1.0"
        )
        print(f"✅ Audit record created successfully with ID: {record.id}")
        print(f"   Record hash: {record.record_hash}")
        print(f"   Signature: {record.signature[:30]}...")  # Truncate for readability
    except Exception as exc:
        print(f"❌ Failed to create audit record: {exc}")
        return False
    
    # 3. Verify the record's integrity and signature
    print("\n3. Verifying the audit record's integrity and authenticity...")
    is_valid = await audit_logger.verify_record(record)
    if is_valid:
        print("✅ Audit record verified successfully - integrity and signature are valid")
    else:
        print("❌ Audit record verification failed")
        return False
    
    # 4. Test the convenience logging function
    print("\n4. Testing the convenience log_administrative_operation function...")
    try:
        record2 = await log_administrative_operation(
            operation_type="contract_upgrade",
            actor="deploy-bot@stellarflow.io",
            payload={
                "contract_address": "CCJWV4XJZ4...",
                "new_version": "2.1.0",
                "upgrade_transaction": "abc123def456..."
            },
            transaction_hash="abc123def456"
        )
        print(f"✅ Contract upgrade logged successfully with ID: {record2.id}")
    except Exception as exc:
        print(f"❌ Failed to log contract upgrade: {exc}")
        return False
    
    # 5. Test tamper detection
    print("\n5. Testing tamper detection (simulating an unauthorized modification)...")
    # Create a copy of the record and modify it
    record_copy = AuditLog(
        operation_type=record.operation_type,
        actor=record.actor,
        timestamp=record.timestamp,
        payload={"reason": "Hacked! I changed the record"},  # Malicious modification
        signature=record.signature,
        key_id=record.key_id,
        record_hash=record.record_hash,  # Same hash but modified payload - should fail
        ip_address=record.ip_address,
        user_agent=record.user_agent,
        transaction_hash=record.transaction_hash
    )
    
    integrity_ok = record_copy.verify_integrity()
    if not integrity_ok:
        print("✅ Tampering detected! Modified record fails integrity check")
    else:
        print("❌ Tampering not detected - this is a security issue!")
        return False
    
    # 6. Cleanup
    print("\n6. Cleaning up resources...")
    await key_handler.stop()
    
    print("\n🎉 All audit logging system tests passed!")
    return True


if __name__ == "__main__":
    success = asyncio.run(test_audit_logging_system())
    exit(0 if success else 1)