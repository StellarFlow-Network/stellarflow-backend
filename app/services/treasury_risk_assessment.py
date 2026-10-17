"""app/services/treasury_risk_assessment.py — Protocol Treasury Diversification Risk Assessment Matrix.

Calculates Sharpe ratio and Value at Risk (VaR) for proposed treasury portfolio distributions,
enforces rejection of proposals with 30-day VaR exceeding the 15% threshold, and exports
quantitative risk breakdown reports for governance proposals.
"""

from __future__ import annotations

import math
import time
import uuid
from dataclasses import dataclass, asdict
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import structlog

log = structlog.get_logger(__name__)

#: Maximum allowed 30-day Value at Risk (VaR) threshold (15%)
MAX_ALLOWED_VAR_30D = Decimal("0.15")

#: Maximum delay (seconds) before a bad-debt auction must open after liquidation failure
MAX_AUCTION_OPEN_DELAY_SECONDS = 10.0


class TreasuryRiskAssessmentError(RuntimeError):
    """Raised when a treasury diversification proposal violates risk thresholds or validation rules."""
    pass


class DebtAuctionSchedulerError(RuntimeError):
    """Raised when a debt auction cannot be created, advanced, or settled."""
    pass


@dataclass
class PortfolioProposalItem:
    """Represents an asset or strategy allocation within a treasury proposal."""
    strategy_id: str
    weight: Decimal
    expected_apy: Decimal
    volatility_30d: Decimal  # 30-day volatility (annualized or standard deviation)


@dataclass
class DebtAuctionRecord:
    """Represents a multi-stage collateral debt auction for uncollateralized bad debt."""
    auction_id: str
    vault_id: str
    debt_token: str
    total_debt: Decimal
    collateral_value: Decimal
    bad_debt: Decimal
    start_price: Decimal
    decay_rate: Decimal  # k in P(t) = P_start * e^(-k t)
    created_at: float
    opened_at: Optional[float] = None
    settled_at: Optional[float] = None
    winning_bid: Optional[Decimal] = None
    winning_bidder: Optional[str] = None
    status: str = "pending"  # pending | open | settled | cancelled

    def is_open(self) -> bool:
        return self.status == "open"

    def is_settled(self) -> bool:
        return self.status == "settled"


@dataclass
class DebtAuctionBid:
    """A bid submitted against a debt auction at a given time."""
    bidder: str
    amount: Decimal
    submitted_at: float


@dataclass
class DebtAuctionSettlement:
    """Result of settling a debt auction."""
    auction_id: str
    winning_bidder: str
    winning_bid: Decimal
    debt_burned: Decimal
    settled_at: float


@dataclass
class RiskAssessmentReport:
    """Quantitative risk breakdown report for governance proposals."""
    expected_portfolio_return: Decimal
    portfolio_volatility: Decimal
    sharpe_ratio: Decimal
    var_30d_95: Decimal
    exceeds_var_threshold: bool
    proposal_approved: bool
    breakdown: List[Dict[str, Any]]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "expected_portfolio_return": str(self.expected_portfolio_return),
            "portfolio_volatility": str(self.portfolio_volatility),
            "sharpe_ratio": str(self.sharpe_ratio),
            "var_30d_95": str(self.var_30d_95),
            "exceeds_var_threshold": self.exceeds_var_threshold,
            "proposal_approved": self.proposal_approved,
            "breakdown": self.breakdown,
        }



class TreasuryRiskAssessmentMatrix:
    """Assesses risk for protocol treasury diversification proposals.

    Calculates Sharpe ratio, 30-day Value at Risk (VaR), and rejects any proposal
    where 30-day VaR exceeds the 15% threshold.
    """

    def __init__(self, risk_free_rate: Decimal = Decimal("0.03")) -> None:
        if risk_free_rate < 0:
            raise ValueError("risk_free_rate cannot be negative")
        self.risk_free_rate = risk_free_rate
        log.info(
            "treasury_risk_assessment.initialized",
            component="TreasuryRiskAssessmentMatrix",
            risk_free_rate=float(risk_free_rate),
        )

    def calculate_sharpe_ratio(
        self, portfolio_return: Decimal, portfolio_volatility: Decimal
    ) -> Decimal:
        """Calculate the Sharpe ratio given portfolio return and volatility."""
        if portfolio_volatility <= 0:
            return Decimal("0.0")
        sharpe = (portfolio_return - self.risk_free_rate) / portfolio_volatility
        return sharpe.quantize(Decimal("0.0001"))

    def calculate_var_30d(
        self, portfolio_volatility: Decimal, confidence_z: Decimal = Decimal("1.645")
    ) -> Decimal:
        """Calculate 30-day Value at Risk (VaR) at 95% confidence (Z = 1.645 for 95%).

        VaR_30d = Z * portfolio_volatility * sqrt(30 / 365)
        """
        if portfolio_volatility < 0:
            raise ValueError("portfolio_volatility cannot be negative")
        time_factor = Decimal(str(math.sqrt(30.0 / 365.0)))
        var = confidence_z * portfolio_volatility * time_factor
        return var.quantize(Decimal("0.0001"))

    def assess_proposal(
        self, items: List[PortfolioProposalItem], correlation_matrix: Optional[List[List[Decimal]]] = None
    ) -> RiskAssessmentReport:
        """Assess a treasury diversification proposal against risk limits.

        Parameters
        ----------
        items : List[PortfolioProposalItem]
            Proposed assets/strategies with weights, expected APY, and 30d volatility.
        correlation_matrix : Optional[List[List[Decimal]]]
            Optional correlation matrix between items. If None, assumes independence (diagonal).

        Returns
        -------
        RiskAssessmentReport
            Comprehensive quantitative risk metrics report.

        Raises
        ------
        TreasuryRiskAssessmentError
            If weights do not sum to ~1.0 or inputs are invalid.
        """
        if not items:
            raise TreasuryRiskAssessmentError("Proposal contains no allocation items")

        total_weight = sum((item.weight for item in items), Decimal("0"))
        if abs(total_weight - Decimal("1.0")) > Decimal("0.001"):
            raise TreasuryRiskAssessmentError(
                f"Portfolio weights must sum to 1.0 (got {total_weight})"
            )

        n = len(items)
        weights = [float(item.weight) for item in items]
        returns = [float(item.expected_apy) for item in items]
        volatilities = [float(item.volatility_30d) for item in items]

        # Expected portfolio return (weighted average APY)
        expected_return = sum(w * r for w, r in zip(weights, returns))

        # Build covariance matrix
        if correlation_matrix is not None:
            if len(correlation_matrix) != n or any(len(row) != n for row in correlation_matrix):
                raise TreasuryRiskAssessmentError("Correlation matrix dimensions mismatch item count")
            # Compute covariance from correlation and volatilities
            cov_matrix = []
            for i in range(n):
                row = []
                for j in range(n):
                    corr = float(correlation_matrix[i][j])
                    v_cov = corr * volatilities[i] * volatilities[j]
                    row.append(v_cov)
                cov_matrix.append(row)
            
            # Portfolio variance = w^T * Cov * w
            port_var = 0.0
            for i in range(n):
                for j in range(n):
                    port_var += weights[i] * weights[j] * cov_matrix[i][j]
            portfolio_volatility = math.sqrt(max(0.0, port_var))
        else:
            # Assume uncorrelated (diagonal covariance)
            port_var = sum((w * v) ** 2 for w, v in zip(weights, volatilities))
            portfolio_volatility = math.sqrt(port_var)

        dec_return = Decimal(str(expected_return)).quantize(Decimal("0.0001"))
        dec_vol = Decimal(str(portfolio_volatility)).quantize(Decimal("0.0001"))

        sharpe = self.calculate_sharpe_ratio(dec_return, dec_vol)
        var_30d = self.calculate_var_30d(dec_vol)

        exceeds_var = var_30d > MAX_ALLOWED_VAR_30D
        proposal_approved = not exceeds_var

        breakdown = [
            {
                "strategy_id": item.strategy_id,
                "weight": str(item.weight),
                "expected_apy": str(item.expected_apy),
                "volatility_30d": str(item.volatility_30d),
            }
            for item in items
        ]

        report = RiskAssessmentReport(
            expected_portfolio_return=dec_return,
            portfolio_volatility=dec_vol,
            sharpe_ratio=sharpe,
            var_30d_95=var_30d,
            exceeds_var_threshold=exceeds_var,
            proposal_approved=proposal_approved,
            breakdown=breakdown,
        )

        log.info(
            "treasury_risk_assessment.assessed",
            component="TreasuryRiskAssessmentMatrix",
            expected_return=float(dec_return),
            portfolio_volatility=float(dec_vol),
            sharpe_ratio=float(sharpe),
            var_30d_95=float(var_30d),
            proposal_approved=proposal_approved,
        )

        if exceeds_var:
            log.warning(
                "treasury_risk_assessment.rejected_due_to_var",
                component="TreasuryRiskAssessmentMatrix",
                var_30d_95=float(var_30d),
                threshold=float(MAX_ALLOWED_VAR_30D),
            )

        return report

    def export_governance_report(self, report: RiskAssessmentReport) -> Dict[str, Any]:
        """Export quantitative risk breakdown report for governance proposals."""
        return report.to_dict()


class DebtAuctionScheduler:
    """Schedules and manages multi-stage collateral debt auctions for bad debt.

    When a vault liquidation leaves uncollateralized bad debt, a debt auction record
    is created and opened automatically within ``MAX_AUCTION_OPEN_DELAY_SECONDS``.
    Bidding thresholds follow a time-based price decay curve:

        P(t) = P_start * e^(-k * t)

    Winning bids settle the auction and burn the corresponding protocol debt tokens.
    """

    def __init__(
        self,
        default_decay_rate: Decimal = Decimal("0.0005"),
        auction_open_delay_seconds: float = MAX_AUCTION_OPEN_DELAY_SECONDS,
        clock: Optional[Any] = None,
    ) -> None:
        if default_decay_rate <= 0:
            raise ValueError("default_decay_rate must be positive")
        if auction_open_delay_seconds < 0:
            raise ValueError("auction_open_delay_seconds cannot be negative")
        if auction_open_delay_seconds > MAX_AUCTION_OPEN_DELAY_SECONDS:
            raise ValueError(
                f"auction_open_delay_seconds cannot exceed {MAX_AUCTION_OPEN_DELAY_SECONDS}"
            )
        self.default_decay_rate = default_decay_rate
        self.auction_open_delay_seconds = auction_open_delay_seconds
        self._clock = clock or time.time
        self._auctions: Dict[str, DebtAuctionRecord] = {}
        self._bids: Dict[str, List[DebtAuctionBid]] = {}
        self._burned_debt: Dict[str, Decimal] = {}
        log.info(
            "debt_auction_scheduler.initialized",
            component="DebtAuctionScheduler",
            default_decay_rate=float(default_decay_rate),
            auction_open_delay_seconds=auction_open_delay_seconds,
        )

    def _now(self) -> float:
        return float(self._clock())

    def create_auction_from_liquidation(
        self,
        vault_id: str,
        debt_token: str,
        total_debt: Decimal,
        collateral_value: Decimal,
        start_price: Optional[Decimal] = None,
        decay_rate: Optional[Decimal] = None,
    ) -> DebtAuctionRecord:
        """Create a debt auction record when a liquidation leaves bad debt.

        Raises
        ------
        DebtAuctionSchedulerError
            If the vault is fully collateralized (no bad debt) or inputs are invalid.
        """
        if total_debt < 0 or collateral_value < 0:
            raise DebtAuctionSchedulerError("total_debt and collateral_value cannot be negative")
        bad_debt = total_debt - collateral_value
        if bad_debt <= 0:
            raise DebtAuctionSchedulerError(
                "No bad debt to auction: collateral covers total debt"
            )

        effective_start_price = start_price if start_price is not None else bad_debt
        if effective_start_price <= 0:
            raise DebtAuctionSchedulerError("start_price must be positive")
        effective_decay_rate = decay_rate if decay_rate is not None else self.default_decay_rate
        if effective_decay_rate <= 0:
            raise DebtAuctionSchedulerError("decay_rate must be positive")

        auction_id = f"debt-auction-{uuid.uuid4().hex}"
        now = self._now()
        record = DebtAuctionRecord(
            auction_id=auction_id,
            vault_id=vault_id,
            debt_token=debt_token,
            total_debt=total_debt,
            collateral_value=collateral_value,
            bad_debt=bad_debt,
            start_price=effective_start_price,
            decay_rate=effective_decay_rate,
            created_at=now,
            status="pending",
        )
        self._auctions[auction_id] = record
        self._bids[auction_id] = []
        log.info(
            "debt_auction_scheduler.auction_created",
            component="DebtAuctionScheduler",
            auction_id=auction_id,
            vault_id=vault_id,
            bad_debt=float(bad_debt),
        )
        return record

    def open_due_auctions(self) -> List[DebtAuctionRecord]:
        """Open all pending auctions whose open delay has elapsed."""
        now = self._now()
        opened: List[DebtAuctionRecord] = []
        for record in self._auctions.values():
            if record.status != "pending":
                continue
            if now - record.created_at >= self.auction_open_delay_seconds:
                record.status = "open"
                record.opened_at = now
                opened.append(record)
                log.info(
                    "debt_auction_scheduler.auction_opened",
                    component="DebtAuctionScheduler",
                    auction_id=record.auction_id,
                    delay_seconds=now - record.created_at,
                )
        return opened

    def get_auction(self, auction_id: str) -> DebtAuctionRecord:
        record = self._auctions.get(auction_id)
        if record is None:
            raise DebtAuctionSchedulerError(f"Unknown auction_id: {auction_id}")
        return record

    def current_price(self, auction_id: str, at_time: Optional[float] = None) -> Decimal:
        """Compute the current bidding threshold using P(t) = P_start * e^(-k t)."""
        record = self.get_auction(auction_id)
        if record.opened_at is None:
            return record.start_price
        now = at_time if at_time is not None else self._now()
        elapsed = max(0.0, now - record.opened_at)
        decayed = float(record.start_price) * math.exp(-float(record.decay_rate) * elapsed)
        return Decimal(str(decayed)).quantize(Decimal("0.0001"))

    def submit_bid(self, auction_id: str, bidder: str, amount: Decimal) -> DebtAuctionBid:
        """Submit a bid against an open auction at or above the current threshold."""
        record = self.get_auction(auction_id)
        if not record.is_open():
            raise DebtAuctionSchedulerError(
                f"Auction {auction_id} is not open (status={record.status})"
            )
        if amount <= 0:
            raise DebtAuctionSchedulerError("Bid amount must be positive")
        threshold = self.current_price(auction_id)
        if amount < threshold:
            raise DebtAuctionSchedulerError(
                f"Bid {amount} below current threshold {threshold}"
            )
        bid = DebtAuctionBid(bidder=bidder, amount=amount, submitted_at=self._now())
        self._bids[auction_id].append(bid)
        log.info(
            "debt_auction_scheduler.bid_submitted",
            component="DebtAuctionScheduler",
            auction_id=auction_id,
            bidder=bidder,
            amount=float(amount),
            threshold=float(threshold),
        )
        return bid

    def settle_auction(self, auction_id: str) -> DebtAuctionSettlement:
        """Settle the auction with the highest bid and burn the corresponding debt tokens."""
        record = self.get_auction(auction_id)
        if record.is_settled():
            raise DebtAuctionSchedulerError(f"Auction {auction_id} already settled")
        if not record.is_open():
            raise DebtAuctionSchedulerError(
                f"Auction {auction_id} is not open (status={record.status})"
            )
        bids = self._bids.get(auction_id, [])
        if not bids:
            raise DebtAuctionSchedulerError(f"Auction {auction_id} has no bids to settle")
        winning = max(bids, key=lambda b: (b.amount, -b.submitted_at))
        debt_burned = min(winning.amount, record.bad_debt)
        now = self._now()
        record.status = "settled"
        record.settled_at = now
        record.winning_bid = winning.amount
        record.winning_bidder = winning.bidder
        self._burned_debt[record.debt_token] = (
            self._burned_debt.get(record.debt_token, Decimal("0")) + debt_burned
        )
        settlement = DebtAuctionSettlement(
            auction_id=auction_id,
            winning_bidder=winning.bidder,
            winning_bid=winning.amount,
            debt_burned=debt_burned,
            settled_at=now,
        )
        log.info(
            "debt_auction_scheduler.auction_settled",
            component="DebtAuctionScheduler",
            auction_id=auction_id,
            winning_bidder=winning.bidder,
            winning_bid=float(winning.amount),
            debt_burned=float(debt_burned),
            debt_token=record.debt_token,
        )
        return settlement

    def burned_debt(self, debt_token: str) -> Decimal:
        """Return total debt tokens burned for a given debt token."""
        return self._burned_debt.get(debt_token, Decimal("0"))

    def list_auctions(self, status: Optional[str] = None) -> List[DebtAuctionRecord]:
        """List auctions, optionally filtered by status."""
        records = list(self._auctions.values())
        if status is not None:
            records = [r for r in records if r.status == status]
        return records
