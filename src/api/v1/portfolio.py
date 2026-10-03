"""src/api/v1/portfolio.py — Multi-address wallet aggregation and portfolio indexing endpoints.

Routes:
  POST /api/v1/portfolio/groups               — Create a new wallet group
  GET  /api/v1/portfolio/groups               — List user's wallet groups
  POST /api/v1/portfolio/groups/{id}/members — Add member to wallet group
  GET  /api/v1/portfolio/grouped-summary     — Get aggregated portfolio summary
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_async_session
from app.models import (
    ErrorResponse,
    GroupedPortfolioSummaryData,
    GroupedPortfolioSummaryResponse,
    TokenBalanceItem,
    TradeItem,
    WalletGroup,
    WalletGroupMember,
    WalletSummary,
    YieldRewardItem,
)

router = APIRouter(prefix="/portfolio", tags=["Portfolio"])


@router.get(
    "/grouped-summary",
    response_model=GroupedPortfolioSummaryResponse,
    summary="Get Grouped Portfolio Summary",
    description=(
        "Returns aggregated portfolio metrics across all wallets in a group, "
        "including combined token balances, active trades, and yield rewards."
    ),
    responses={
        200: {"description": "Grouped portfolio summary returned successfully"},
        404: {"description": "Wallet group not found", "model": ErrorResponse},
    },
)
async def get_grouped_portfolio_summary(
    wallet_group_id: str = Query(
        ...,
        description="Wallet group ID to aggregate",
        example="group_123",
    ),
    session: AsyncSession = Depends(get_async_session),
) -> GroupedPortfolioSummaryResponse:
    """Retrieve aggregated portfolio summary for a wallet group."""
    # Fetch wallet group
    result = await session.execute(
        select(WalletGroup).where(WalletGroup.id == wallet_group_id)
    )
    wallet_group = result.scalar_one_or_none()

    if not wallet_group:
        raise HTTPException(
            status_code=404,
            detail=f"Wallet group '{wallet_group_id}' not found",
        )

    # Fetch wallet group members
    members_result = await session.execute(
        select(WalletGroupMember).where(
            WalletGroupMember.wallet_group_id == wallet_group_id
        )
    )
    members = members_result.scalars().all()

    if not members:
        return GroupedPortfolioSummaryResponse(
            data=GroupedPortfolioSummaryData(
                wallet_group_id=wallet_group.id,
                wallet_group_name=wallet_group.name,
                combined_token_balances=[],
                combined_active_trades=[],
                combined_yield_rewards=[],
                total_balance_usd=Decimal("0"),
                wallet_count=0,
                wallets=[],
                calculated_at=datetime.now(timezone.utc),
            )
        )

    # Aggregate data across all wallets
    # Note: This is a placeholder implementation. In production, you would:
    # 1. Query actual token balances from Stellar Horizon or an indexer
    # 2. Query active trades from a trades table
    # 3. Query yield rewards from a rewards table
    # For now, we return mock data to demonstrate the structure

    wallets: List[WalletSummary] = []
    combined_token_balances: List[TokenBalanceItem] = []
    combined_active_trades: List[TradeItem] = []
    combined_yield_rewards: List[YieldRewardItem] = []
    total_balance_usd = Decimal("0")

    for member in members:
        # Mock data for each wallet
        wallet_summary = WalletSummary(
            public_key=member.public_key,
            label=member.label,
            token_balances=[
                TokenBalanceItem(
                    asset_code="XLM",
                    asset_issuer=None,
                    balance=Decimal("1000.00"),
                    usd_value=Decimal("125.00"),
                ),
                TokenBalanceItem(
                    asset_code="USDC",
                    asset_issuer="GABC...",
                    balance=Decimal("500.00"),
                    usd_value=Decimal("500.00"),
                ),
            ],
            active_trades=[
                TradeItem(
                    trade_id=f"trade_{member.id}",
                    asset_pair="XLM/USDC",
                    amount=Decimal("100.00"),
                    status="OPEN",
                    entered_at=datetime.now(timezone.utc),
                )
            ],
            yield_rewards=[
                YieldRewardItem(
                    reward_id=f"reward_{member.id}",
                    vault_address="GXYZ...",
                    amount=Decimal("2.50"),
                    asset_code="USDC",
                    earned_at=datetime.now(timezone.utc),
                )
            ],
            total_balance_usd=Decimal("625.00"),
        )
        wallets.append(wallet_summary)

        # Aggregate totals
        total_balance_usd += wallet_summary.total_balance_usd
        combined_token_balances.extend(wallet_summary.token_balances)
        combined_active_trades.extend(wallet_summary.active_trades)
        combined_yield_rewards.extend(wallet_summary.yield_rewards)

    return GroupedPortfolioSummaryResponse(
        data=GroupedPortfolioSummaryData(
            wallet_group_id=wallet_group.id,
            wallet_group_name=wallet_group.name,
            combined_token_balances=combined_token_balances,
            combined_active_trades=combined_active_trades,
            combined_yield_rewards=combined_yield_rewards,
            total_balance_usd=total_balance_usd,
            wallet_count=len(members),
            wallets=wallets,
            calculated_at=datetime.now(timezone.utc),
        )
    )


__all__ = ["router"]
