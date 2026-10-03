"""app/services/treasury_risk_assessment.py — Protocol Treasury Diversification Risk Assessment Matrix.

Calculates Sharpe ratio and Value at Risk (VaR) for proposed treasury portfolio distributions,
enforces rejection of proposals with 30-day VaR exceeding the 15% threshold, and exports
quantitative risk breakdown reports for governance proposals.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import structlog

log = structlog.get_logger(__name__)

#: Maximum allowed 30-day Value at Risk (VaR) threshold (15%)
MAX_ALLOWED_VAR_30D = Decimal("0.15")


class TreasuryRiskAssessmentError(RuntimeError):
    """Raised when a treasury diversification proposal violates risk thresholds or validation rules."""
    pass


@dataclass
class PortfolioProposalItem:
    """Represents an asset or strategy allocation within a treasury proposal."""
    strategy_id: str
    weight: Decimal
    expected_apy: Decimal
    volatility_30d: Decimal  # 30-day volatility (annualized or standard deviation)


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
