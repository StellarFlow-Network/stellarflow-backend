"""Initial schema — all StellarFlow Prisma models.

Revision ID: 0001
Revises:     None
Create Date: 2026-07-28 00:00:00.000000 UTC

Creates every table that matches the Prisma schema (prisma/schema.prisma).
Tables are created in foreign-key dependency order:

  Currency                 (no deps)
  PriceHistory             (→ Currency)
  OnChainPrice             (no deps)
  ProviderReputation       (no deps)
  ErrorLog                 (no deps)
  RawData                  (no deps)
  Relayer                  (no deps)
  RelayerRegistry          (→ Relayer)
  ApiKey                   (no deps)
  UserSession              (→ Relayer)
  PermissionChange         (→ Relayer)
  OhlcCandle               (no deps)
  HourlyStats              (no deps)
  ComplianceMetadata       (no deps)
  MultiSigPrice            (no deps)
  MultiSigSignature        (→ MultiSigPrice)
  PendingConsensus         (no deps)
  PendingSignature         (→ PendingConsensus)
  AuditLog                 (no deps)
  IssuerOnboardingRequest  (no deps)

downgrade() drops all tables in reverse order so the rollback test suite
can verify a clean round-trip for every schema.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------
revision: str = "0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _table_exists(name: str) -> bool:
    """Return True when *name* already exists in the public schema."""
    bind = op.get_bind()
    if bind is None or getattr(bind, "dialect", None) is None:
        return False
    try:
        return sa.inspect(bind).has_table(name)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# upgrade — create all tables
# ---------------------------------------------------------------------------

def upgrade() -> None:
    """Create every StellarFlow table (idempotent: skips existing tables)."""

    # ------------------------------------------------------------------
    # 1. Currency (referenced by PriceHistory)
    # ------------------------------------------------------------------
    if not _table_exists("Currency"):
        op.create_table(
            "Currency",
            sa.Column("code", sa.String(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("symbol", sa.String(), nullable=False),
            sa.Column("decimals", sa.Integer(), nullable=False, server_default="2"),
            sa.Column("isActive", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("code"),
        )

    # ------------------------------------------------------------------
    # 2. PriceHistory (→ Currency)
    # ------------------------------------------------------------------
    if not _table_exists("PriceHistory"):
        op.create_table(
            "PriceHistory",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("rate", sa.Numeric(), nullable=False),
            sa.Column("bid", sa.Numeric(), nullable=True),
            sa.Column("ask", sa.Numeric(), nullable=True),
            sa.Column("source", sa.String(), nullable=False),
            sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.ForeignKeyConstraint(["currency"], ["Currency.code"], name="fk_pricehistory_currency"),
            sa.UniqueConstraint("currency", "source", "timestamp",
                                name="uq_pricehistory_currency_source_ts"),
        )
        op.create_index("ix_pricehistory_currency_ts", "PriceHistory",
                        ["currency", "timestamp"])
        op.create_index("ix_pricehistory_ts", "PriceHistory", ["timestamp"])

    # ------------------------------------------------------------------
    # 3. OnChainPrice
    # ------------------------------------------------------------------
    if not _table_exists("OnChainPrice"):
        op.create_table(
            "OnChainPrice",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("rate", sa.Numeric(), nullable=False),
            sa.Column("txHash", sa.String(), nullable=False),
            sa.Column("memoId", sa.String(), nullable=True),
            sa.Column("ledgerSeq", sa.Integer(), nullable=False),
            sa.Column("confirmedAt", sa.DateTime(timezone=True), nullable=False),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("txHash", "currency", name="uq_onchainprice_txhash_currency"),
        )
        op.create_index("ix_onchainprice_currency_confirmed",
                        "OnChainPrice", ["currency", "confirmedAt"])
        op.create_index("ix_onchainprice_txhash", "OnChainPrice", ["txHash"])
        op.create_index("ix_onchainprice_ledgerseq", "OnChainPrice", ["ledgerSeq"])

    # ------------------------------------------------------------------
    # 4. ProviderReputation
    # ------------------------------------------------------------------
    if not _table_exists("ProviderReputation"):
        op.create_table(
            "ProviderReputation",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("providerName", sa.String(), nullable=False),
            sa.Column("endpoint", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("totalRequests", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("successfulRequests", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("failedRequests", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("incorrectResponses", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("averageLatency", sa.Float(), nullable=True),
            sa.Column("lastSuccess", sa.DateTime(timezone=True), nullable=True),
            sa.Column("lastFailure", sa.DateTime(timezone=True), nullable=True),
            sa.Column("lastIncorrect", sa.DateTime(timezone=True), nullable=True),
            sa.Column("consecutiveFailures", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("consecutiveIncorrect", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("reliabilityScore", sa.Float(), nullable=True),
            sa.Column("lastUpdated", sa.DateTime(timezone=True), nullable=False),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("providerName", "endpoint",
                                name="uq_providerrep_name_endpoint"),
        )
        op.create_index("ix_providerrep_name", "ProviderReputation", ["providerName"])
        op.create_index("ix_providerrep_status", "ProviderReputation", ["status"])
        op.create_index("ix_providerrep_score", "ProviderReputation", ["reliabilityScore"])

    # ------------------------------------------------------------------
    # 5. ErrorLog
    # ------------------------------------------------------------------
    if not _table_exists("ErrorLog"):
        op.create_table(
            "ErrorLog",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("providerName", sa.String(), nullable=False),
            sa.Column("errorMessage", sa.String(), nullable=True),
            sa.Column("occurredAt", sa.DateTime(timezone=True), nullable=False),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_errorlog_provider", "ErrorLog", ["providerName"])
        op.create_index("ix_errorlog_occurred", "ErrorLog", ["occurredAt"])

    # ------------------------------------------------------------------
    # 6. RawData
    # ------------------------------------------------------------------
    if not _table_exists("RawData"):
        op.create_table(
            "RawData",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("provider", sa.String(), nullable=False),
            sa.Column("endpoint", sa.String(), nullable=True),
            sa.Column("payload", sa.Text(), nullable=False),
            sa.Column("fetchedAt", sa.DateTime(timezone=True), nullable=False),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_rawdata_currency_fetched", "RawData", ["currency", "fetchedAt"])
        op.create_index("ix_rawdata_provider_fetched", "RawData", ["provider", "fetchedAt"])
        op.create_index("ix_rawdata_created", "RawData", ["createdAt"])

    # ------------------------------------------------------------------
    # 7. Relayer (referenced by RelayerRegistry, UserSession, PermissionChange)
    # ------------------------------------------------------------------
    if not _table_exists("Relayer"):
        op.create_table(
            "Relayer",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("apiKey", sa.String(), nullable=False),
            sa.Column("isActive", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("allowedAssets", sa.String(), nullable=False),
            sa.Column("whitelistedIps", sa.ARRAY(sa.Text()),
                      nullable=False, server_default=sa.text("ARRAY[]::TEXT[]")),
            sa.Column("email", sa.String(), nullable=True),
            sa.Column("passwordHash", sa.String(), nullable=True),
            sa.Column("role", sa.String(), nullable=True, server_default="'VIEWER'"),
            sa.Column("lastLoginAt", sa.DateTime(timezone=True), nullable=True),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("apiKey", name="uq_relayer_apikey"),
            sa.UniqueConstraint("email", name="uq_relayer_email"),
        )

    # ------------------------------------------------------------------
    # 8. RelayerRegistry (→ Relayer)
    # ------------------------------------------------------------------
    if not _table_exists("RelayerRegistry"):
        op.create_table(
            "RelayerRegistry",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("relayerId", sa.Integer(), nullable=False),
            sa.Column("contactName", sa.String(), nullable=False),
            sa.Column("email", sa.String(), nullable=False),
            sa.Column("organizationName", sa.String(), nullable=False),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("relayerId", name="uq_relayerreg_relayerid"),
            sa.ForeignKeyConstraint(
                ["relayerId"], ["Relayer.id"],
                name="fk_relayerreg_relayer",
                ondelete="CASCADE",
            ),
        )

    # ------------------------------------------------------------------
    # 9. ApiKey
    # ------------------------------------------------------------------
    if not _table_exists("ApiKey"):
        op.create_table(
            "ApiKey",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("key", sa.String(), nullable=False),
            sa.Column("label", sa.String(), nullable=True),
            sa.Column("scopes", sa.ARRAY(sa.Text()), nullable=False,
                      server_default=sa.text("ARRAY[]::TEXT[]")),
            sa.Column("ownerId", sa.String(), nullable=True),
            sa.Column("isActive", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("expiresAt", sa.DateTime(timezone=True), nullable=True),
            sa.Column("lastUsedAt", sa.DateTime(timezone=True), nullable=True),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("key", name="uq_apikey_key"),
        )

    # ------------------------------------------------------------------
    # 10. UserSession (→ Relayer)
    # ------------------------------------------------------------------
    if not _table_exists("UserSession"):
        op.create_table(
            "UserSession",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("relayerId", sa.Integer(), nullable=False),
            sa.Column("token", sa.String(), nullable=False),
            sa.Column("ipAddress", sa.String(), nullable=False),
            sa.Column("userAgent", sa.String(), nullable=False),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("expiresAt", sa.DateTime(timezone=True), nullable=False),
            sa.Column("isActive", sa.Boolean(), nullable=False, server_default="true"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("token", name="uq_usersession_token"),
            sa.ForeignKeyConstraint(
                ["relayerId"], ["Relayer.id"],
                name="fk_usersession_relayer",
            ),
        )

    # ------------------------------------------------------------------
    # 11. PermissionChange (→ Relayer)
    # ------------------------------------------------------------------
    if not _table_exists("PermissionChange"):
        op.create_table(
            "PermissionChange",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("relayerId", sa.Integer(), nullable=False),
            sa.Column("changedBy", sa.Integer(), nullable=False),
            sa.Column("targetId", sa.Integer(), nullable=True),
            sa.Column("field", sa.String(), nullable=False),
            sa.Column("oldValue", sa.String(), nullable=True),
            sa.Column("newValue", sa.String(), nullable=True),
            sa.Column("reason", sa.String(), nullable=True),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.PrimaryKeyConstraint("id"),
            sa.ForeignKeyConstraint(
                ["relayerId"], ["Relayer.id"],
                name="fk_permchange_relayer",
            ),
        )

    # ------------------------------------------------------------------
    # 12. OhlcCandle
    # ------------------------------------------------------------------
    if not _table_exists("OhlcCandle"):
        op.create_table(
            "OhlcCandle",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("granularity", sa.String(), nullable=False),
            sa.Column("openTime", sa.DateTime(timezone=True), nullable=False),
            sa.Column("closeTime", sa.DateTime(timezone=True), nullable=False),
            sa.Column("open", sa.Numeric(), nullable=False),
            sa.Column("high", sa.Numeric(), nullable=False),
            sa.Column("low", sa.Numeric(), nullable=False),
            sa.Column("close", sa.Numeric(), nullable=False),
            sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("currency", "granularity", "openTime",
                                name="uq_ohlccandle_currency_gran_open"),
        )
        op.create_index("ix_ohlccandle_currency_gran_open", "OhlcCandle",
                        ["currency", "granularity", "openTime"])
        op.create_index("ix_ohlccandle_gran_open", "OhlcCandle",
                        ["granularity", "openTime"])

    # ------------------------------------------------------------------
    # 13. HourlyStats
    # ------------------------------------------------------------------
    if not _table_exists("HourlyStats"):
        op.create_table(
            "HourlyStats",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("averageRate", sa.Numeric(), nullable=False),
            sa.Column("hour", sa.DateTime(timezone=True), nullable=False),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("currency", "hour", name="uq_hourlystats_currency_hour"),
        )
        op.create_index("ix_hourlystats_hour", "HourlyStats", ["hour"])

    # ------------------------------------------------------------------
    # 14. ComplianceMetadata
    # ------------------------------------------------------------------
    if not _table_exists("ComplianceMetadata"):
        op.create_table(
            "ComplianceMetadata",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("relayerId", sa.Integer(), nullable=True),
            sa.Column("relayerName", sa.String(), nullable=True),
            sa.Column("eventType", sa.String(), nullable=False),
            sa.Column("payloadTimestamp", sa.DateTime(timezone=True), nullable=True),
            sa.Column("receivedAt", sa.DateTime(timezone=True), nullable=False),
            sa.Column("latencyDiffMs", sa.Integer(), nullable=True),
            sa.Column("thresholdMs", sa.Integer(), nullable=True),
            sa.Column("details", sa.Text(), nullable=True),
            sa.Column("resolved", sa.Boolean(), nullable=False, server_default="false"),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_compliance_relayerid", "ComplianceMetadata", ["relayerId"])
        op.create_index("ix_compliance_eventtype", "ComplianceMetadata", ["eventType"])
        op.create_index("ix_compliance_created", "ComplianceMetadata", ["createdAt"])
        op.create_index("ix_compliance_relayername_created", "ComplianceMetadata",
                        ["relayerName", "createdAt"])

    # ------------------------------------------------------------------
    # 15. MultiSigPrice (referenced by MultiSigSignature)
    # ------------------------------------------------------------------
    if not _table_exists("MultiSigPrice"):
        op.create_table(
            "MultiSigPrice",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("priceReviewId", sa.Integer(), nullable=False),
            sa.Column("currency", sa.String(), nullable=False),
            sa.Column("rate", sa.Numeric(), nullable=False),
            sa.Column("source", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("requiredSignatures", sa.Integer(), nullable=False,
                      server_default="2"),
            sa.Column("collectedSignatures", sa.Integer(), nullable=False,
                      server_default="0"),
            sa.Column("memoId", sa.String(), nullable=True),
            sa.Column("stellarTxHash", sa.String(), nullable=True),
            sa.Column("submittedAt", sa.DateTime(timezone=True), nullable=True),
            sa.Column("requestedAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("expiresAt", sa.DateTime(timezone=True), nullable=False),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_multisigprice_currency_status_req",
                        "MultiSigPrice", ["currency", "status", "requestedAt"])
        op.create_index("ix_multisigprice_status_expires",
                        "MultiSigPrice", ["status", "expiresAt"])
        op.create_index("ix_multisigprice_reviewid",
                        "MultiSigPrice", ["priceReviewId"])

    # ------------------------------------------------------------------
    # 16. MultiSigSignature (→ MultiSigPrice)
    # ------------------------------------------------------------------
    if not _table_exists("MultiSigSignature"):
        op.create_table(
            "MultiSigSignature",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("multiSigPriceId", sa.Integer(), nullable=False),
            sa.Column("signerPublicKey", sa.String(), nullable=False),
            sa.Column("signerName", sa.String(), nullable=False),
            sa.Column("signature", sa.Text(), nullable=False),
            sa.Column("signedAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("multiSigPriceId", "signerPublicKey",
                                name="uq_multisigsig_price_signer"),
            sa.ForeignKeyConstraint(
                ["multiSigPriceId"], ["MultiSigPrice.id"],
                name="fk_multisigsig_price",
                ondelete="CASCADE",
            ),
        )
        op.create_index("ix_multisigsig_priceid", "MultiSigSignature", ["multiSigPriceId"])
        op.create_index("ix_multisigsig_signer", "MultiSigSignature", ["signerPublicKey"])

    # ------------------------------------------------------------------
    # 17. PendingConsensus (referenced by PendingSignature)
    # ------------------------------------------------------------------
    if not _table_exists("PendingConsensus"):
        op.create_table(
            "PendingConsensus",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("actionType", sa.String(50), nullable=False),
            sa.Column("actionData", sa.Text(), nullable=True),
            sa.Column("status", sa.String(20), nullable=False),
            sa.Column("requiredSignatures", sa.Integer(), nullable=False,
                      server_default="2"),
            sa.Column("collectedSignatures", sa.Integer(), nullable=False,
                      server_default="0"),
            sa.Column("requestedBy", sa.String(100), nullable=False),
            sa.Column("requestedAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("expiresAt", sa.DateTime(timezone=True), nullable=False),
            sa.Column("executedAt", sa.DateTime(timezone=True), nullable=True),
            sa.Column("executionResult", sa.Text(), nullable=True),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_pendingconsensus_action_status",
                        "PendingConsensus", ["actionType", "status"])
        op.create_index("ix_pendingconsensus_status_expires",
                        "PendingConsensus", ["status", "expiresAt"])
        op.create_index("ix_pendingconsensus_requested_by",
                        "PendingConsensus", ["requestedBy", "requestedAt"])

    # ------------------------------------------------------------------
    # 18. PendingSignature (→ PendingConsensus)
    # ------------------------------------------------------------------
    if not _table_exists("PendingSignature"):
        op.create_table(
            "PendingSignature",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("pendingConsensusId", sa.Integer(), nullable=False),
            sa.Column("adminPublicKey", sa.String(56), nullable=False),
            sa.Column("adminName", sa.String(100), nullable=False),
            sa.Column("adminRole", sa.String(50), nullable=False),
            sa.Column("signature", sa.Text(), nullable=False),
            sa.Column("ipAddress", sa.String(45), nullable=False),
            sa.Column("userAgent", sa.String(500), nullable=True),
            sa.Column("signedAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("pendingConsensusId", "adminPublicKey",
                                name="uq_pendingsig_consensus_admin"),
            sa.ForeignKeyConstraint(
                ["pendingConsensusId"], ["PendingConsensus.id"],
                name="fk_pendingsig_consensus",
                ondelete="CASCADE",
            ),
        )
        op.create_index("ix_pendingsig_consensusid",
                        "PendingSignature", ["pendingConsensusId"])
        op.create_index("ix_pendingsig_adminkey",
                        "PendingSignature", ["adminPublicKey"])

    # ------------------------------------------------------------------
    # 19. AuditLog
    # ------------------------------------------------------------------
    if not _table_exists("AuditLog"):
        op.create_table(
            "AuditLog",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("eventType", sa.String(50), nullable=False),
            sa.Column("actionType", sa.String(50), nullable=True),
            sa.Column("relatedId", sa.Integer(), nullable=True),
            sa.Column("actorPublicKey", sa.String(56), nullable=False),
            sa.Column("actorName", sa.String(100), nullable=False),
            sa.Column("actorRole", sa.String(50), nullable=True),
            sa.Column("eventDetails", sa.Text(), nullable=True),
            sa.Column("previousState", sa.Text(), nullable=True),
            sa.Column("newState", sa.Text(), nullable=True),
            sa.Column("ipAddress", sa.String(45), nullable=True),
            sa.Column("userAgent", sa.String(500), nullable=True),
            sa.Column("occurredAt",
                      sa.DateTime(timezone=True), nullable=False),
            sa.Column("createdAt",
                      sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_auditlog_eventtype_occurred",
                        "AuditLog", ["eventType", "occurredAt"])
        op.create_index("ix_auditlog_actiontype_occurred",
                        "AuditLog", ["actionType", "occurredAt"])
        op.create_index("ix_auditlog_actor_occurred",
                        "AuditLog", ["actorPublicKey", "occurredAt"])
        op.create_index("ix_auditlog_relatedid", "AuditLog", ["relatedId"])
        op.create_index("ix_auditlog_occurred", "AuditLog", ["occurredAt"])

    # ------------------------------------------------------------------
    # 20. IssuerOnboardingRequest
    # ------------------------------------------------------------------
    if not _table_exists("IssuerOnboardingRequest"):
        op.create_table(
            "IssuerOnboardingRequest",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("licenseNumber", sa.String(100), nullable=False),
            sa.Column("country", sa.String(100), nullable=False),
            sa.Column("walletAddress", sa.String(56), nullable=False),
            sa.Column("status", sa.String(20), nullable=False,
                      server_default="'PENDING'"),
            sa.Column("reviewedBy", sa.String(100), nullable=True),
            sa.Column("reviewedAt", sa.DateTime(timezone=True), nullable=True),
            sa.Column("reviewNote", sa.Text(), nullable=True),
            sa.Column("addedToAllowlist", sa.Boolean(), nullable=False,
                      server_default="false"),
            sa.Column("allowlistTxHash", sa.String(100), nullable=True),
            sa.Column("createdAt", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updatedAt", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_issueronboard_status",
                        "IssuerOnboardingRequest", ["status"])
        op.create_index("ix_issueronboard_wallet",
                        "IssuerOnboardingRequest", ["walletAddress"])
        op.create_index("ix_issueronboard_created",
                        "IssuerOnboardingRequest", ["createdAt"])


# ---------------------------------------------------------------------------
# downgrade — drop all tables in reverse dependency order
# ---------------------------------------------------------------------------

def downgrade() -> None:
    """Drop every StellarFlow table (reverse of upgrade dependency order)."""

    # Child tables that reference parents must be dropped first.

    # 20
    op.drop_table("IssuerOnboardingRequest")
    # 19
    op.drop_table("AuditLog")
    # 18 (→ PendingConsensus)
    op.drop_table("PendingSignature")
    # 17
    op.drop_table("PendingConsensus")
    # 16 (→ MultiSigPrice)
    op.drop_table("MultiSigSignature")
    # 15
    op.drop_table("MultiSigPrice")
    # 14
    op.drop_table("ComplianceMetadata")
    # 13
    op.drop_table("HourlyStats")
    # 12
    op.drop_table("OhlcCandle")
    # 11 (→ Relayer)
    op.drop_table("PermissionChange")
    # 10 (→ Relayer)
    op.drop_table("UserSession")
    # 9
    op.drop_table("ApiKey")
    # 8 (→ Relayer)
    op.drop_table("RelayerRegistry")
    # 7
    op.drop_table("Relayer")
    # 6
    op.drop_table("RawData")
    # 5
    op.drop_table("ErrorLog")
    # 4
    op.drop_table("ProviderReputation")
    # 3
    op.drop_table("OnChainPrice")
    # 2 (→ Currency)
    op.drop_table("PriceHistory")
    # 1
    op.drop_table("Currency")
