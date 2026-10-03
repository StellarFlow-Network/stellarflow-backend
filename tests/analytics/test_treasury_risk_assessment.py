"""Tests for protocol treasury diversification risk assessment matrix."""

from decimal import Decimal
import pytest

from app.services.treasury_risk_assessment import (
    TreasuryRiskAssessmentMatrix,
    PortfolioProposalItem,
    TreasuryRiskAssessmentError,
    MAX_ALLOWED_VAR_30D,
)


def test_treasury_risk_assessment_approval():
    matrix = TreasuryRiskAssessmentMatrix(risk_free_rate=Decimal("0.02"))
    items = [
        PortfolioProposalItem(
            strategy_id="vault-usdc-low",
            weight=Decimal("0.70"),
            expected_apy=Decimal("0.05"),
            volatility_30d=Decimal("0.02"),
        ),
        PortfolioProposalItem(
            strategy_id="vault-eth-yield",
            weight=Decimal("0.30"),
            expected_apy=Decimal("0.08"),
            volatility_30d=Decimal("0.10"),
        ),
    ]

    report = matrix.assess_proposal(items)
    assert report.proposal_approved is True
    assert report.exceeds_var_threshold is False
    assert report.var_30d_95 <= MAX_ALLOWED_VAR_30D
    assert report.sharpe_ratio > 0

    exported = matrix.export_governance_report(report)
    assert "expected_portfolio_return" in exported
    assert "var_30d_95" in exported
    assert exported["proposal_approved"] is True


def test_treasury_risk_assessment_rejection_high_var():
    matrix = TreasuryRiskAssessmentMatrix()
    items = [
        PortfolioProposalItem(
            strategy_id="vault-high-risk-leveraged",
            weight=Decimal("1.0"),
            expected_apy=Decimal("0.25"),
            volatility_30d=Decimal("0.65"),  # Very high volatility
        ),
    ]

    report = matrix.assess_proposal(items)
    assert report.proposal_approved is False
    assert report.exceeds_var_threshold is True
    assert report.var_30d_95 > MAX_ALLOWED_VAR_30D


def test_invalid_weights_raises_error():
    matrix = TreasuryRiskAssessmentMatrix()
    items = [
        PortfolioProposalItem(
            strategy_id="vault-1",
            weight=Decimal("0.50"),
            expected_apy=Decimal("0.05"),
            volatility_30d=Decimal("0.05"),
        ),
    ]

    with pytest.raises(TreasuryRiskAssessmentError):
        matrix.assess_proposal(items)
