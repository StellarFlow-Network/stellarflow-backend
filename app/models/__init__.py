"""app/models.py — Strict Pydantic v2 request/response models for the StellarFlow API.

Every model uses ``model_config = ConfigDict(strict=True)`` so that type
coercion is disabled and FastAPI raises a 422 Unprocessable Entity for any
mismatched input instead of silently casting it.

Naming convention
-----------------
* ``*Request``  — HTTP request body schema.
* ``*Response`` — HTTP response body schema (success path).
* ``*Item``     — Nested element used inside a collection field.
* ``ErrorDetail`` / ``ErrorResponse`` — Shared error envelope.

All models are exported in ``__all__`` at the bottom of this file so that
``app/main.py`` can do a single ``from app.models import *``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Base config — applied to every model via inheritance
# ---------------------------------------------------------------------------

class _StrictModel(BaseModel):
    """Base class that enforces strict type checking across all API models."""

    model_config = ConfigDict(
        strict=True,
        # Populate model fields from ORM attribute names (used for Prisma compat).
        populate_by_name=True,
        # Serialize datetime fields as ISO-8601 strings.
        json_encoders={datetime: lambda v: v.isoformat()},
    )


# ---------------------------------------------------------------------------
# Shared error envelope
# ---------------------------------------------------------------------------

class ErrorDetail(_StrictModel):
    """Machine-readable error detail object."""

    code: str = Field(
        ...,
        description="Short error code (e.g. INVALID_CREDENTIALS).",
        examples=["INVALID_CREDENTIALS"],
    )
    message: str = Field(
        ...,
        description="Human-readable error message.",
        examples=["Invalid email or password"],
    )


class ErrorResponse(_StrictModel):
    """Standard error envelope returned by all endpoints on failure."""

    success: Literal[False] = Field(
        default=False,
        description="Always false for error responses.",
    )
    error: Union[str, ErrorDetail] = Field(
        ...,
        description="Either a plain error string or a structured ErrorDetail object.",
        examples=["INTERNAL_SERVER_ERROR"],
    )


class SuccessEnvelope(_StrictModel):
    """Minimal success wrapper used when no data payload is needed."""

    success: Literal[True] = Field(default=True)
    message: Optional[str] = Field(default=None, examples=["Operation completed"])


# ---------------------------------------------------------------------------
# Auth — POST /api/v1/auth/login  &  POST /api/v1/auth/logout
# ---------------------------------------------------------------------------

class LoginRequest(_StrictModel):
    """Request body for POST /api/v1/auth/login."""

    email: str = Field(
        ...,
        description="Registered relayer e-mail address.",
        examples=["oracle@stellarflow.io"],
    )
    password: str = Field(
        ...,
        description="Account password.",
        min_length=1,
        examples=["s3cr3tP@ss"],
    )


class LoginUserItem(_StrictModel):
    """Authenticated user summary returned inside LoginResponse."""

    id: int = Field(..., examples=[42])
    email: Optional[str] = Field(default=None, examples=["oracle@stellarflow.io"])
    name: str = Field(..., examples=["Oracle Server 1"])
    role: Optional[str] = Field(default="VIEWER", examples=["OPERATOR"])
    lastLoginAt: Optional[datetime] = Field(default=None)


class LoginData(_StrictModel):
    token: str = Field(..., description="JWT bearer token.", examples=["eyJhbGci..."])
    user: LoginUserItem


class LoginResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: LoginData


class LogoutResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    message: str = Field(default="Logged out successfully", examples=["Logged out successfully"])


# ---------------------------------------------------------------------------
# Status — GET /api/v1/status
# ---------------------------------------------------------------------------

class StatusResponse(_StrictModel):
    """Response for GET /api/v1/status."""

    status: Literal["green", "red"] = Field(
        ...,
        description="'green' when the database is reachable, 'red' otherwise.",
        examples=["green"],
    )
    db: Literal["ok", "error"] = Field(..., examples=["ok"])
    lastSync: Optional[datetime] = Field(
        default=None,
        description="ISO-8601 timestamp of the most recent PriceHistory record.",
    )
    timestamp: datetime = Field(
        ...,
        description="Server time at which this response was generated.",
    )


# ---------------------------------------------------------------------------
# Market Rates — GET /api/v1/market-rates/*
# ---------------------------------------------------------------------------

class MarketRateItem(_StrictModel):
    """A single currency's current exchange rate."""

    currency: str = Field(..., examples=["NGN"])
    rate: Decimal = Field(..., examples=[Decimal("1825.42")])
    bid: Optional[Decimal] = Field(default=None, examples=[Decimal("1820.00")])
    ask: Optional[Decimal] = Field(default=None, examples=[Decimal("1830.00")])
    source: str = Field(..., examples=["CoinGecko"])
    timestamp: datetime = Field(..., description="When this rate was last fetched.")


class MarketRatesResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: List[MarketRateItem]
    errors: Optional[List[str]] = Field(default=None)


class SingleRateResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: MarketRateItem


class MarketHealthResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: Dict[str, bool] = Field(
        ...,
        description="Map of provider name → health boolean.",
        examples=[{"CoinGecko": True, "ExchangeRateAPI": False}],
    )
    overallHealthy: bool = Field(..., examples=[False])


class CurrencyItem(_StrictModel):
    code: str = Field(..., examples=["GHS"])
    name: str = Field(..., examples=["Ghanaian Cedi"])
    symbol: str = Field(..., examples=["₵"])


class CurrenciesResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: List[str] = Field(..., description="Supported currency codes.", examples=[["NGN", "KES", "GHS"]])


class CacheStatusResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: Dict[str, Any]


class ClearCacheResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    message: str = Field(default="Cache cleared successfully")


# ---------------------------------------------------------------------------
# Price Reviews — GET/POST /api/v1/market-rates/reviews/*
# ---------------------------------------------------------------------------

class ReviewActionRequest(_StrictModel):
    """Request body for approve/reject review endpoints."""

    reviewedBy: Optional[str] = Field(
        default=None,
        description="Name or identifier of the reviewer.",
        examples=["admin@stellarflow.io"],
    )
    note: Optional[str] = Field(
        default=None,
        description="Optional review note.",
        examples=["Rate verified against CoinGecko"],
    )


class PriceReviewItem(_StrictModel):
    id: int = Field(..., examples=[17])
    currency: str = Field(..., examples=["NGN"])
    rate: Decimal = Field(..., examples=[Decimal("1825.00")])
    source: str = Field(..., examples=["CoinGecko"])
    status: str = Field(..., examples=["PENDING"])
    createdAt: datetime


class PriceReviewsResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: List[PriceReviewItem]


class PriceReviewResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: PriceReviewItem


# ---------------------------------------------------------------------------
# History — GET /api/v1/history/:asset
# ---------------------------------------------------------------------------

class PriceHistoryItem(_StrictModel):
    timestamp: datetime
    rate: Decimal = Field(..., examples=[Decimal("1825.42")])
    source: str = Field(..., examples=["CoinGecko"])


class HistoryResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    asset: str = Field(..., examples=["NGN"])
    range: str = Field(..., examples=["7d"])
    data: List[PriceHistoryItem]


# ---------------------------------------------------------------------------
# Stats — GET /api/v1/stats/volume  &  GET /api/v1/stats/relayers
# ---------------------------------------------------------------------------

class DataPointsItem(_StrictModel):
    priceHistoryEntries: int = Field(..., examples=[240])
    onChainConfirmations: int = Field(..., examples=[12])
    total: int = Field(..., examples=[252])


class ApiRequestsItem(_StrictModel):
    total: int = Field(..., examples=[1440])
    successful: int = Field(..., examples=[1380])
    failed: int = Field(..., examples=[60])
    successRate: str = Field(..., examples=["95.83%"])


class ActivityItem(_StrictModel):
    activeCurrencies: int = Field(..., examples=[3])
    activeDataSources: int = Field(..., examples=[4])
    currencies: List[str] = Field(..., examples=[["NGN", "KES", "GHS"]])
    sources: List[str] = Field(..., examples=[["CoinGecko", "ExchangeRateAPI"]])


class ProviderStatItem(_StrictModel):
    name: str = Field(..., examples=["CoinGecko"])
    totalRequests: int = Field(..., examples=[480])
    successRate: str = Field(..., examples=["97.50%"])
    lastActivity: Optional[datetime] = Field(default=None)


class VolumeData(_StrictModel):
    date: str = Field(..., examples=["2026-07-28"])
    dataPoints: DataPointsItem
    apiRequests: ApiRequestsItem
    activity: ActivityItem
    providers: List[ProviderStatItem]


class VolumeResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: VolumeData


class RelayerStatItem(_StrictModel):
    signerPublicKey: str = Field(..., examples=["GABC..."])
    signerName: str = Field(..., examples=["oracle-server-1"])
    totalSignatures: int = Field(..., examples=[120])
    successfulPushes: int = Field(..., examples=[118])
    failedSignatures: int = Field(..., examples=[2])
    uptimePercentage: float = Field(..., examples=[98.33])
    averageLatencyMs: float = Field(..., examples=[142.5])
    lastActivity: Optional[datetime] = Field(default=None)


class RelayerStatsData(_StrictModel):
    totalRelayers: int = Field(..., examples=[3])
    relayers: List[RelayerStatItem]


class RelayerStatsResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: RelayerStatsData


# ---------------------------------------------------------------------------
# Intelligence — GET /api/v1/intelligence/*
# ---------------------------------------------------------------------------

class VolatilityItem(_StrictModel):
    currency: str = Field(..., examples=["NGN"])
    standardDeviation: float = Field(
        ...,
        description="Population standard deviation of rates in the last 60 minutes.",
        examples=[12.3456],
    )
    sampleCount: int = Field(..., examples=[8])
    meanRate: Optional[float] = Field(default=None, examples=[1825.42])
    latestRate: Optional[float] = Field(default=None, examples=[1830.10])
    latestTimestamp: Optional[datetime] = Field(default=None)


class HourlyVolatilitySnapshot(_StrictModel):
    windowMinutes: int = Field(default=60, examples=[60])
    windowStart: datetime
    windowEnd: datetime
    generatedAt: datetime
    currencies: List[VolatilityItem]


class HourlyVolatilityResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: HourlyVolatilitySnapshot


class PriceChangeResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    currency: str = Field(..., examples=["NGN"])
    change24h: str = Field(..., examples=["+2.5%"])


class StaleCurrenciesResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    staleCurrencies: List[str] = Field(..., examples=[["GHS"]])


# ---------------------------------------------------------------------------
# Price Updates — POST & GET /api/v1/price-updates/*
# ---------------------------------------------------------------------------

class MultiSigRequestBody(_StrictModel):
    """Request body for POST /api/v1/price-updates/multi-sig/request."""

    priceReviewId: int = Field(..., examples=[17])
    currency: str = Field(..., examples=["NGN"])
    rate: Decimal = Field(..., examples=[Decimal("1825.00")])
    source: str = Field(..., examples=["CoinGecko"])
    memoId: Optional[str] = Field(default=None, examples=["SF-NGN-1234567890-001"])


class SignRequestBody(_StrictModel):
    """Request body for POST /api/v1/price-updates/sign."""

    multiSigPriceId: int = Field(..., examples=[42])


class RemoteSignatureRequestBody(_StrictModel):
    """Request body for POST /api/v1/price-updates/multi-sig/:id/request-signature."""

    remoteServerUrl: str = Field(
        ...,
        description="Base URL of the remote oracle server to request a signature from.",
        examples=["https://oracle2.stellarflow.io"],
    )


class RecordSubmissionBody(_StrictModel):
    """Request body for POST /api/v1/price-updates/multi-sig/:id/record-submission."""

    memoId: str = Field(..., examples=["SF-NGN-1234567890-001"])
    stellarTxHash: str = Field(
        ...,
        description="Stellar transaction hash of the submitted update.",
        examples=["a1b2c3..."],
    )


class MultiSigPriceItem(_StrictModel):
    id: int = Field(..., examples=[42])
    currency: str = Field(..., examples=["NGN"])
    rate: Decimal = Field(..., examples=[Decimal("1825.00")])
    status: str = Field(..., examples=["PENDING"])
    collectedSignatures: int = Field(..., examples=[1])
    requiredSignatures: int = Field(..., examples=[2])
    expiresAt: datetime
    signerCount: Optional[int] = Field(default=None, examples=[1])


class MultiSigSignerItem(_StrictModel):
    publicKey: str = Field(..., examples=["GABC..."])
    name: str = Field(..., examples=["oracle-server-1"])
    signedAt: datetime


class MultiSigStatusData(_StrictModel):
    id: int = Field(..., examples=[42])
    currency: str = Field(..., examples=["NGN"])
    rate: Decimal = Field(..., examples=[Decimal("1825.00")])
    status: str = Field(..., examples=["APPROVED"])
    collectedSignatures: int = Field(..., examples=[2])
    requiredSignatures: int = Field(..., examples=[2])
    expiresAt: datetime
    signers: List[MultiSigSignerItem]


class MultiSigStatusResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: MultiSigStatusData


class MultiSigPendingResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: List[MultiSigPriceItem]


class SignatureItem(_StrictModel):
    signerPublicKey: str = Field(..., examples=["GABC..."])
    signerName: str = Field(..., examples=["oracle-server-1"])
    signature: str = Field(..., description="XDR-encoded Ed25519 signature.", examples=["base64..."])


class MultiSigSignaturesData(_StrictModel):
    multiSigPriceId: int = Field(..., examples=[42])
    currency: str = Field(..., examples=["NGN"])
    rate: Decimal = Field(..., examples=[Decimal("1825.00")])
    signatures: List[SignatureItem]


class MultiSigSignaturesResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: MultiSigSignaturesData


class SignerInfoData(_StrictModel):
    name: str = Field(..., examples=["oracle-server-1"])
    publicKey: str = Field(..., examples=["GABC..."])


class SignerInfoResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: SignerInfoData


class SignData(_StrictModel):
    multiSigPriceId: int = Field(..., examples=[42])
    signature: str = Field(..., examples=["base64..."])
    signerPublicKey: str = Field(..., examples=["GABC..."])
    signerName: str = Field(..., examples=["oracle-server-1"])


class SignResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: SignData


class MultiSigRequestResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: MultiSigPriceItem


# ---------------------------------------------------------------------------
# Assets — GET /api/v1/assets
# ---------------------------------------------------------------------------

class AssetsResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    assets: List[CurrencyItem]


# ---------------------------------------------------------------------------
# Derived Assets — GET /api/v1/derived-assets/*
# ---------------------------------------------------------------------------

class DerivedRateData(_StrictModel):
    base: str = Field(..., examples=["NGN"])
    quote: str = Field(..., examples=["GHS"])
    rate: Decimal = Field(
        ...,
        description="Synthetic cross-rate: 1 base unit in quote units.",
        examples=[Decimal("74.38")],
    )
    calculatedAt: datetime


class DerivedRateResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: DerivedRateData


# ---------------------------------------------------------------------------
# Sanity Check — GET /api/v1/sanity-check/*
# ---------------------------------------------------------------------------

class SanityCheckResult(_StrictModel):
    currency: str = Field(..., examples=["NGN"])
    oraclePrice: float = Field(..., examples=[1825.42])
    externalPrice: float = Field(..., examples=[1830.00])
    deviationPct: float = Field(..., examples=[0.25])
    threshold: float = Field(..., examples=[2.0])
    passed: bool = Field(..., examples=[True])
    checkedAt: datetime


class SanityCheckResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: SanityCheckResult


class SanityCheckAllSummary(_StrictModel):
    total: int = Field(..., examples=[3])
    passed: int = Field(..., examples=[3])
    failed: int = Field(..., examples=[0])


class SanityCheckAllResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    summary: SanityCheckAllSummary
    data: List[SanityCheckResult]


class SanityThresholdData(_StrictModel):
    threshold: float = Field(..., examples=[2.0])
    description: str = Field(..., examples=["Alerts are triggered when price deviation exceeds 2.0%"])


class SanityThresholdResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: SanityThresholdData


# ---------------------------------------------------------------------------
# Analytics — GET /api/v1/analytics/*
# ---------------------------------------------------------------------------

class OhlcCandleItem(_StrictModel):
    currency: str = Field(..., examples=["NGN"])
    granularity: Literal["MINUTE", "HOUR", "DAY"] = Field(..., examples=["HOUR"])
    openTime: datetime
    closeTime: datetime
    open: Decimal = Field(..., examples=[Decimal("1820.00")])
    high: Decimal = Field(..., examples=[Decimal("1835.00")])
    low: Decimal = Field(..., examples=[Decimal("1815.00")])
    close: Decimal = Field(..., examples=[Decimal("1828.50")])
    count: int = Field(..., description="Number of raw ticks aggregated.", examples=[12])


class OhlcResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: List[OhlcCandleItem]


class AggregatorStatusData(_StrictModel):
    running: bool = Field(..., examples=[True])
    granularities: List[str] = Field(..., examples=[["MINUTE", "HOUR", "DAY"]])


class AggregatorStatusResponse(_StrictModel):
    success: Literal[True] = Field(default=True)
    data: AggregatorStatusData


# ---------------------------------------------------------------------------
# Public exports
# ---------------------------------------------------------------------------

__all__ = [
    # Base
    "_StrictModel",
    "ErrorDetail",
    "ErrorResponse",
    "SuccessEnvelope",
    # Auth
    "LoginRequest",
    "LoginUserItem",
    "LoginData",
    "LoginResponse",
    "LogoutResponse",
    # Status
    "StatusResponse",
    # Market Rates
    "MarketRateItem",
    "MarketRatesResponse",
    "SingleRateResponse",
    "MarketHealthResponse",
    "CurrencyItem",
    "CurrenciesResponse",
    "CacheStatusResponse",
    "ClearCacheResponse",
    # Reviews
    "ReviewActionRequest",
    "PriceReviewItem",
    "PriceReviewsResponse",
    "PriceReviewResponse",
    # History
    "PriceHistoryItem",
    "HistoryResponse",
    # Stats
    "VolumeResponse",
    "RelayerStatsResponse",
    # Intelligence
    "VolatilityItem",
    "HourlyVolatilitySnapshot",
    "HourlyVolatilityResponse",
    "PriceChangeResponse",
    "StaleCurrenciesResponse",
    # Price Updates
    "MultiSigRequestBody",
    "SignRequestBody",
    "RemoteSignatureRequestBody",
    "RecordSubmissionBody",
    "MultiSigPriceItem",
    "MultiSigStatusResponse",
    "MultiSigPendingResponse",
    "MultiSigSignaturesResponse",
    "SignerInfoResponse",
    "SignResponse",
    "MultiSigRequestResponse",
    # Assets
    "AssetsResponse",
    # Derived Assets
    "DerivedRateResponse",
    # Sanity Check
    "SanityCheckResponse",
    "SanityCheckAllResponse",
    "SanityThresholdResponse",
    # Analytics
    "OhlcCandleItem",
    "OhlcResponse",
    "AggregatorStatusResponse",
    # Shielded Note Indexer ORM models
    "ShieldedCommitment",
    "SpentNullifier",
    "MerkleRoot",
]


# ---------------------------------------------------------------------------
# Shielded Note Indexer ORM models
# ---------------------------------------------------------------------------

from app.models.shielded import MerkleRoot, ShieldedCommitment, SpentNullifier  # noqa: E402
