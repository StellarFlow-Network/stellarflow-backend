"""app/models/treasury.py — ORM models for protocol treasury yield auto-staking.

Tables:
  treasury_yield_allocation — individual staking allocations of idle treasury USDC
  treasury_yield_report     — monthly yield generation summaries for governance
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import (
    DateTime,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class TreasuryYieldAllocation(Base):
    """A single staking allocation of idle treasury USDC into a yield vault.

    Attributes
    ----------
    id : str
        Deterministic dedup key (SHA-256 of strategy_id + window_start).
    strategy_id : str
        Reference to vault_strategy.id receiving the staked capital.
    vault_address : str
        On-chain vault contract address.
    amount : Decimal
        USDC amount staked into the vault.
    apy : Decimal
        Expected APY at allocation time (fractional, e.g. 0.0523 = 5.23%).
    status : str
        Allocation status (PENDING, STAKED, FAILED, UNSTAKED).
    transaction_hash : str
        On-chain transaction hash for the staking operation.
    window_start : datetime
        Start of the allocation window (UTC).
    created_at : datetime
        Wall-clock timestamp of allocation creation.
    metadata : dict
        Additional execution context.
    """

    __tablename__ = "treasury_yield_allocation"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        comment="SHA-256(strategy_id:window_start)",
    )

    strategy_id: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        index=True,
        comment="Reference to vault_strategy.id",
    )

    vault_address: Mapped[str] = mapped_column(
        String(56),
        nullable=False,
        comment="On-chain vault contract address",
    )

    amount: Mapped[Any] = mapped_column(
        Numeric(32, 7),
        nullable=False,
        comment="USDC amount staked into the vault",
    )

    apy: Mapped[Any] = mapped_column(
        Numeric(10, 7),
        nullable=False,
        comment="Expected APY at allocation time (fractional)",
    )

    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        index=True,
        comment="Allocation status (PENDING, STAKED, FAILED, UNSTAKED)",
    )

    transaction_hash: Mapped[Optional[str]] = mapped_column(
        String(64),
        nullable=True,
        comment="On-chain staking transaction hash",
    )

    window_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
        comment="Allocation window start (UTC)",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        comment="Record creation timestamp",
    )

    metadata: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Additional execution context",
    )

    __table_args__ = (
        UniqueConstraint(
            "strategy_id", "window_start", name="uq_treasury_allocation_window"
        ),
        Index("ix_treasury_allocation_status_window", "status", "window_start"),
    )

    def __repr__(self) -> str:
        return (
            f"<TreasuryYieldAllocation strategy={self.strategy_id} "
            f"amount={self.amount} status={self.status}>"
        )


class TreasuryYieldReport(Base):
    """Monthly yield generation summary for governance review.

    Attributes
    ----------
    id : str
        Deterministic dedup key (SHA-256 of period_start).
    period_start : datetime
        Start of the reporting month (UTC).
    period_end : datetime
        End of the reporting month (UTC).
    total_staked : Decimal
        Total USDC staked into yield vaults during the period.
    total_yield_earned : Decimal
        Total USDC yield earned during the period.
    average_apy : Decimal
        Weighted average APY across active allocations (fractional).
    liquid_reserve : Decimal
        Liquid reserve balance maintained at period close.
    reserve_ratio : Decimal
        Liquid reserve as a fraction of total treasury balance.
    allocation_count : int
        Number of staking allocations in the period.
    summary : dict
        Structured per-strategy breakdown for governance.
    created_at : datetime
        Wall-clock timestamp of report creation.
    """

    __tablename__ = "treasury_yield_report"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        comment="SHA-256(period_start)",
    )

    period_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
        comment="Reporting period start (UTC)",
    )

    period_end: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        comment="Reporting period end (UTC)",
    )

    total_staked: Mapped[Any] = mapped_column(
        Numeric(32, 7),
        nullable=False,
        comment="Total USDC staked during the period",
    )

    total_yield_earned: Mapped[Any] = mapped_column(
        Numeric(32, 7),
        nullable=False,
        comment="Total USDC yield earned during the period",
    )

    average_apy: Mapped[Any] = mapped_column(
        Numeric(10, 7),
        nullable=False,
        comment="Weighted average APY (fractional)",
    )

    liquid_reserve: Mapped[Any] = mapped_column(
        Numeric(32, 7),
        nullable=False,
        comment="Liquid reserve balance at period close",
    )

    reserve_ratio: Mapped[Any] = mapped_column(
        Numeric(5, 4),
        nullable=False,
        comment="Liquid reserve fraction of total treasury balance",
    )

    allocation_count: Mapped[int] = mapped_column(
        nullable=False,
        server_default=text("0"),
        comment="Number of staking allocations in the period",
    )

    summary: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Structured per-strategy breakdown for governance",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        comment="Record creation timestamp",
    )

    __table_args__ = (
        UniqueConstraint("period_start", name="uq_treasury_report_period"),
        Index("ix_treasury_report_period", "period_start", "period_end"),
    )

    def __repr__(self) -> str:
        return (
            f"<TreasuryYieldReport period={self.period_start} "
            f"yield={self.total_yield_earned} apy={self.average_apy}>"
        )
