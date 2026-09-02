"""app/routers/audit.py — API router for compliance auditors to search audit logs.

Provides REST API endpoints for internal compliance teams to search and retrieve
audit log records. Includes filtering capabilities, pagination, and record
verification endpoints to ensure audit trail integrity.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_async_session
from app.models.audit import AuditLog, AdministrativeOperationType
from app.services.audit_logger import get_audit_logger, AuditLogger

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/audit", tags=["audit"])


# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------

class AuditLogResponse(BaseModel):
    """Pydantic model for returning audit log records in API responses."""
    id: int
    operation_type: str
    actor: str
    timestamp: datetime
    payload: Dict[str, Any]
    record_hash: str
    signature: str
    key_id: str
    ip_address: Optional[str]
    user_agent: Optional[str]
    transaction_hash: Optional[str]
    is_valid: Optional[bool] = Field(None, description="Whether the record's signature verified successfully")

    model_config = {
        "from_attributes": True
    }


class AuditSearchRequest(BaseModel):
    """Request parameters for searching audit logs."""
    operation_types: Optional[List[str]] = Field(None, description="Filter by specific operation types")
    actor: Optional[str] = Field(None, description="Filter by actor (supports partial matching)")
    start_date: Optional[datetime] = Field(None, description="Filter records after this timestamp")
    end_date: Optional[datetime] = Field(None, description="Filter records before this timestamp")
    ip_address: Optional[str] = Field(None, description="Filter by source IP address")
    transaction_hash: Optional[str] = Field(None, description="Filter by on-chain transaction hash")
    verify_signatures: bool = Field(False, description="Whether to verify all record signatures")


class AuditSearchResponse(BaseModel):
    """Response model for audit log search results."""
    total: int
    page: int
    page_size: int
    records: List[AuditLogResponse]
    has_more: bool


class VerifyRecordResponse(BaseModel):
    """Response model for record verification endpoint."""
    record_id: int
    integrity_verified: bool
    signature_verified: bool
    is_valid: bool
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@router.post("/search", response_model=AuditSearchResponse, summary="Search audit logs for compliance auditing")
async def search_audit_logs(
    search_params: AuditSearchRequest,
    page: int = Query(1, ge=1, description="Page number for pagination"),
    page_size: int = Query(100, ge=1, le=1000, description="Number of records per page"),
    session: AsyncSession = Depends(get_async_session),
    audit_logger: AuditLogger = Depends(get_audit_logger)
) -> AuditSearchResponse:
    """Search and filter audit log records for compliance auditing.

    This endpoint provides comprehensive filtering capabilities to help auditors
    find relevant records. It supports filtering by operation type, actor, date range,
    IP address, and transaction hash. Results are paginated and can optionally include
    signature verification to ensure record authenticity.
    """
    # Build the base query
    query = select(AuditLog)
    conditions = []

    # Apply filters
    if search_params.operation_types:
        # Validate and convert to enum values
        valid_operations = []
        for op in search_params.operation_types:
            try:
                valid_operations.append(AdministrativeOperationType(op))
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid operation type: {op}"
                )
        conditions.append(AuditLog.operation_type.in_(valid_operations))

    if search_params.actor:
        conditions.append(AuditLog.actor.ilike(f"%{search_params.actor}%"))

    if search_params.start_date:
        conditions.append(AuditLog.timestamp >= search_params.start_date)

    if search_params.end_date:
        conditions.append(AuditLog.timestamp <= search_params.end_date)

    if search_params.ip_address:
        conditions.append(AuditLog.ip_address == search_params.ip_address)

    if search_params.transaction_hash:
        conditions.append(AuditLog.transaction_hash == search_params.transaction_hash)

    # Combine all conditions
    if conditions:
        query = query.where(and_(*conditions))

    # Add ordering by timestamp descending (newest first)
    query = query.order_by(AuditLog.timestamp.desc())

    # Apply pagination
    offset = (page - 1) * page_size
    query = query.offset(offset).limit(page_size + 1)  # Get one extra to check if there's more

    # Execute the query
    try:
        result = await session.execute(query)
        records = list(result.scalars().all())
    except Exception as exc:
        logger.error("Failed to query audit logs: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve audit logs from database"
        )

    # Check if there are more records
    has_more = len(records) > page_size
    if has_more:
        records = records[:page_size]

    # Convert to response models and verify signatures if requested
    response_records = []
    for record in records:
        record_dict = AuditLogResponse.model_validate(record)

        if search_params.verify_signatures:
            is_valid = await audit_logger.verify_record(record)
            record_dict.is_valid = is_valid

        response_records.append(record_dict)

    # Get total count for pagination metadata
    count_query = select(AuditLog.id).where(and_(*conditions)) if conditions else select(AuditLog.id)
    total_result = await session.execute(count_query)
    total = len(list(total_result.scalars().all()))

    return AuditSearchResponse(
        total=total,
        page=page,
        page_size=page_size,
        records=response_records,
        has_more=has_more
    )


@router.get("/{record_id}", response_model=AuditLogResponse, summary="Retrieve a specific audit log record")
async def get_audit_record(
    record_id: int,
    verify: bool = Query(False, description="Whether to verify the record's signature"),
    session: AsyncSession = Depends(get_async_session),
    audit_logger: AuditLogger = Depends(get_audit_logger)
) -> AuditLogResponse:
    """Retrieve a single audit log record by its ID.

    Optionally verifies the record's integrity and signature before returning it.
    """
    query = select(AuditLog).where(AuditLog.id == record_id)
    result = await session.execute(query)
    record = result.scalar_one_or_none()

    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audit record with ID {record_id} not found"
        )

    response = AuditLogResponse.model_validate(record)

    if verify:
        is_valid = await audit_logger.verify_record(record)
        response.is_valid = is_valid

    return response


@router.post("/{record_id}/verify", response_model=VerifyRecordResponse, summary="Verify an audit record's integrity")
async def verify_audit_record(
    record_id: int,
    session: AsyncSession = Depends(get_async_session),
    audit_logger: AuditLogger = Depends(get_audit_logger)
) -> VerifyRecordResponse:
    """Verify the integrity and authenticity of a specific audit record.

    This endpoint performs two checks:
    1. Recomputes the record's hash and verifies it matches the stored hash (integrity)
    2. Verifies the Ed25519 signature using the public key of the signing key (authenticity)
    """
    query = select(AuditLog).where(AuditLog.id == record_id)
    result = await session.execute(query)
    record = result.scalar_one_or_none()

    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audit record with ID {record_id} not found"
        )

    # First check integrity
    integrity_verified = record.verify_integrity()

    # Then check signature if integrity is good
    signature_verified = False
    if integrity_verified:
        try:
            signature_verified = await audit_logger.verify_record(record)
        except Exception as exc:
            logger.error("Signature verification failed for record %s: %s", record_id, exc)

    return VerifyRecordResponse(
        record_id=record_id,
        integrity_verified=integrity_verified,
        signature_verified=signature_verified,
        is_valid=integrity_verified and signature_verified,
        error=None if integrity_verified and signature_verified else "Record verification failed"
    )


@router.get("/operation-types", response_model=List[str], summary="Get all available operation types")
async def get_operation_types() -> JSONResponse:
    """Return a list of all administrative operation types that can be logged.

    Useful for building UI filters that allow auditors to select which operation
    types they want to search for.
    """
    return JSONResponse(
        content=[op.value for op in AdministrativeOperationType]
    )