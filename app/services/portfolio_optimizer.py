"""app/services/portfolio_optimizer.py — Convex optimization for multi-vault yield strategies.

Implements mean-variance optimization using CVXPY to compute target allocation
vectors W_target that maximize aggregate APY subject to risk weight constraints
and vault capacity limits.  Two risk-weight constraints are enforced on top of
the mean-variance objective:

* ``max_strategy_risk`` — strategies whose ``risk_score`` exceeds this budget
  are excluded from the allocation entirely (a hard per-strategy risk gate).
* ``max_portfolio_risk`` — the capital-weighted risk score of the portfolio,
  ``risk_score · w``, must not exceed this budget.  When the budget binds, the
  target vector is scaled down and the residual capital is left undeployed
  rather than being forced into riskier vaults.

Both constraints default to ``1.0`` (no-op) so the engine is backwards
compatible, and are configurable via ``PORTFOLIO_MAX_STRATEGY_RISK`` and
``PORTFOLIO_MAX_PORTFOLIO_RISK``.
"""

from __future__ import annotations

import os
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

import numpy as np
import structlog

log = structlog.get_logger(__name__)

# Optional dependency: install with `pip install cvxpy`
try:
    import cvxpy as cp

    CVXPY_AVAILABLE = True
except ImportError:
    CVXPY_AVAILABLE = False
    log.warning(
        "portfolio_optimizer.cvxpy_unavailable",
        component="PortfolioOptimizer",
        message="cvxpy not installed; optimization will use fallback proportional allocation",
    )


class OptimizationError(RuntimeError):
    """Raised when portfolio optimization fails."""


class PortfolioOptimizer:
    """Convex optimizer for multi-vault yield strategies.

    Computes optimal capital allocation vectors W_target that maximize
    aggregate APY while respecting risk constraints and capacity limits.

    Parameters
    ----------
    risk_aversion : float
        Risk aversion parameter λ for mean-variance optimization.
        Higher values prefer lower volatility over higher returns.
    max_single_allocation : float
        Maximum weight for any single strategy (e.g., 0.4 = 40%).
    min_allocation : float
        Minimum allocation weight to avoid dust positions.
    max_strategy_risk : float
        Maximum ``risk_score`` (0.0-1.0) a strategy may have to be eligible
        for allocation.  Defaults to ``1.0`` (all strategies eligible).
    max_portfolio_risk : float
        Maximum capital-weighted portfolio risk score
        (``Σ risk_score_i · w_i``).  Defaults to ``1.0`` (unconstrained).
    """

    def __init__(
        self,
        risk_aversion: float = 0.5,
        max_single_allocation: float = 0.40,
        min_allocation: float = 0.01,
        max_strategy_risk: float = 1.0,
        max_portfolio_risk: float = 1.0,
    ) -> None:
        if not 0 <= risk_aversion <= 10:
            raise ValueError("risk_aversion must be in [0, 10]")
        if not 0 < max_single_allocation <= 1:
            raise ValueError("max_single_allocation must be in (0, 1]")
        if not 0 <= min_allocation < max_single_allocation:
            raise ValueError("min_allocation must be < max_single_allocation")
        if not 0 <= max_strategy_risk <= 1:
            raise ValueError("max_strategy_risk must be in [0, 1]")
        if not 0 <= max_portfolio_risk <= 1:
            raise ValueError("max_portfolio_risk must be in [0, 1]")

        self.risk_aversion = risk_aversion
        self.max_single_allocation = max_single_allocation
        self.min_allocation = min_allocation
        self.max_strategy_risk = max_strategy_risk
        self.max_portfolio_risk = max_portfolio_risk
        log.info(
            "portfolio_optimizer.initialized",
            component="PortfolioOptimizer",
            risk_aversion=risk_aversion,
            max_single_allocation=max_single_allocation,
            max_strategy_risk=max_strategy_risk,
            max_portfolio_risk=max_portfolio_risk,
        )

    def compute_target_allocations(
        self,
        strategies: List[Dict],
        total_capital: Decimal,
    ) -> Tuple[Dict[str, Decimal], Dict[str, any]]:
        """Compute optimal target allocation vector W_target.

        Parameters
        ----------
        strategies : List[Dict]
            List of strategy dictionaries with keys:
            - id: strategy identifier
            - current_apy: current APY (fractional)
            - historical_apy_std: APY standard deviation
            - tvl: total value locked
            - capacity: maximum capacity (None = unlimited)
            - risk_score: risk rating 0.0-1.0
            - enabled: whether strategy is active
        total_capital : Decimal
            Total capital to allocate across strategies.

        Returns
        -------
        Tuple[Dict[str, Decimal], Dict[str, any]]
            (allocations, metrics) where allocations maps strategy_id -> weight,
            and metrics contains optimization diagnostics.

        Raises
        ------
        OptimizationError
            If optimization problem is infeasible or fails to solve.
        """
        # Filter enabled strategies and apply the per-strategy risk gate.  A
        # strategy whose risk_score exceeds the budget must never receive
        # capital, regardless of how attractive its APY is.
        enabled_strategies = [
            s
            for s in strategies
            if s.get("enabled", True)
            and float(s.get("risk_score", 0.0)) <= self.max_strategy_risk
        ]
        if not enabled_strategies:
            raise OptimizationError(
                "No enabled strategies within the risk budget "
                f"(max_strategy_risk={self.max_strategy_risk})"
            )

        excluded_by_risk = [
            s["id"]
            for s in strategies
            if s.get("enabled", True)
            and float(s.get("risk_score", 0.0)) > self.max_strategy_risk
        ]
        if excluded_by_risk:
            log.info(
                "portfolio_optimizer.strategies_excluded_by_risk",
                component="PortfolioOptimizer",
                excluded=excluded_by_risk,
                max_strategy_risk=self.max_strategy_risk,
            )

        n = len(enabled_strategies)
        strategy_ids = [s["id"] for s in enabled_strategies]

        log.debug(
            "portfolio_optimizer.computing_allocations",
            component="PortfolioOptimizer",
            strategy_count=n,
            total_capital=float(total_capital),
        )

        # Use CVXPY if available, otherwise fallback to proportional
        if CVXPY_AVAILABLE:
            allocations, metrics = self._optimize_with_cvxpy(
                enabled_strategies, float(total_capital)
            )
        else:
            allocations, metrics = self._fallback_proportional_allocation(
                enabled_strategies, float(total_capital)
            )

        # Convert to Decimal for precision
        decimal_allocations = {
            strategy_id: Decimal(str(weight))
            for strategy_id, weight in allocations.items()
        }

        log.info(
            "portfolio_optimizer.allocations_computed",
            component="PortfolioOptimizer",
            strategy_count=n,
            expected_apy=metrics.get("expected_apy"),
            portfolio_risk=metrics.get("portfolio_risk"),
        )

        return decimal_allocations, metrics

    def _optimize_with_cvxpy(
        self,
        strategies: List[Dict],
        total_capital: float,
    ) -> Tuple[Dict[str, float], Dict[str, any]]:
        """Solve mean-variance optimization using CVXPY."""
        n = len(strategies)
        strategy_ids = [s["id"] for s in strategies]

        # Extract expected returns (APY), APY volatility and risk scores.
        expected_returns = np.array([float(s["current_apy"]) for s in strategies])
        volatilities = np.array(
            [float(s.get("historical_apy_std", 0.01)) for s in strategies]
        )
        risk_scores = np.array(
            [float(s.get("risk_score", 0.0)) for s in strategies]
        )

        # Build covariance matrix (simplified: diagonal with APY variance).
        # For production, use historical correlation matrix.
        covariance_matrix = np.diag(volatilities**2)

        # Decision variable: portfolio weights
        w = cp.Variable(n)

        # Objective: maximize return - λ * risk (mean-variance optimization)
        portfolio_return = expected_returns @ w
        portfolio_risk = cp.quad_form(w, covariance_matrix)
        objective = cp.Maximize(portfolio_return - self.risk_aversion * portfolio_risk)

        # Constraints.  ``sum(w) <= 1`` (rather than ``== 1``) lets the solver
        # leave capital undeployed when the sum of vault capacities is below
        # total capital, instead of declaring the problem infeasible.
        constraints = [
            cp.sum(w) <= 1,
            w >= self.min_allocation,  # minimum allocation
            w <= self.max_single_allocation,  # maximum single allocation
            risk_scores @ w <= self.max_portfolio_risk,  # risk weight budget
        ]

        # Capacity constraints: w_i * total_capital <= capacity_i
        for i, strategy in enumerate(strategies):
            capacity = strategy.get("capacity")
            if capacity is not None:
                capacity_fraction = float(capacity) / total_capital
                constraints.append(w[i] <= capacity_fraction)

        # Solve optimization problem
        problem = cp.Problem(objective, constraints)
        try:
            problem.solve(solver=cp.ECOS, verbose=False)
        except Exception as exc:
            log.exception(
                "portfolio_optimizer.cvxpy_solve_error",
                component="PortfolioOptimizer",
                error=str(exc),
            )
            raise OptimizationError(f"CVXPY optimization failed: {exc}") from exc

        if problem.status not in ["optimal", "optimal_inaccurate"]:
            raise OptimizationError(
                f"Optimization problem is {problem.status}; cannot compute allocations"
            )

        # Extract solution
        weights = w.value
        allocations = {strategy_ids[i]: float(weights[i]) for i in range(n)}

        # Compute metrics
        expected_apy = float(expected_returns @ weights)
        portfolio_variance = float(weights.T @ covariance_matrix @ weights)
        portfolio_std = np.sqrt(portfolio_variance)

        metrics = {
            "expected_apy": expected_apy,
            "portfolio_risk": portfolio_std,
            "portfolio_risk_score": float(risk_scores @ weights),
            "sharpe_ratio": (
                expected_apy / portfolio_std if portfolio_std > 0 else 0.0
            ),
            "capital_deployed_fraction": float(np.sum(weights)),
            "optimization_status": problem.status,
            "solver": "CVXPY/ECOS",
            "risk_budget": self.max_portfolio_risk,
        }

        return allocations, metrics

    def _capacity_caps(
        self, strategies: List[Dict], total_capital: float
    ) -> List[float]:
        """Per-strategy weight ceilings from capacity and diversification limits."""
        caps: List[float] = []
        for strategy in strategies:
            cap = float(self.max_single_allocation)
            capacity = strategy.get("capacity")
            if capacity is not None and total_capital > 0:
                cap = min(cap, float(capacity) / total_capital)
            caps.append(max(cap, 0.0))
        return caps

    def _cap_weights(
        self, weights: List[float], caps: List[float]
    ) -> List[float]:
        """Water-fill weights so no weight exceeds its cap.

        Naively clamping over-cap weights and renormalising (the previous
        behaviour) can push a *clamped* strategy back above its cap after the
        division.  Instead the overflow is redistributed only to strategies
        that still have headroom, iterating until every weight is within its
        cap.  When the caps cannot absorb all the capital the residual is left
        undeployed, so the returned weights always sum to at most 1.
        """
        n = len(weights)
        result = [float(w) for w in weights]
        capped = [False] * n

        for _ in range(n + 1):
            overflow = 0.0
            for i in range(n):
                if not capped[i] and result[i] > caps[i] + 1e-12:
                    overflow += result[i] - caps[i]
                    result[i] = caps[i]
                    capped[i] = True
            if overflow <= 1e-12:
                break

            free = [i for i in range(n) if not capped[i]]
            if not free:
                break

            headroom = sum(caps[i] - result[i] for i in free)
            if headroom <= 1e-12:
                break
            overflow = min(overflow, headroom)

            free_base = sum(result[i] for i in free)
            if free_base <= 1e-12:
                share = overflow / len(free)
                for i in free:
                    result[i] += share
            else:
                for i in free:
                    result[i] += overflow * (result[i] / free_base)

        return [max(0.0, min(result[i], caps[i])) for i in range(n)]

    def _apply_risk_budget(
        self, weights: List[float], risk_scores: List[float]
    ) -> Tuple[List[float], float]:
        """Scale weights down until the capital-weighted risk score fits budget.

        Returns ``(weights, portfolio_risk_score)``.  When the budget binds the
        residual capital stays undeployed, mirroring the CVXPY constraint.
        """
        exposure = float(
            sum(w * r for w, r in zip(weights, risk_scores))
        )
        if self.max_portfolio_risk >= 1.0 or exposure <= self.max_portfolio_risk:
            return weights, exposure
        if exposure <= 0:
            return weights, exposure

        scale = self.max_portfolio_risk / exposure
        scaled = [w * scale for w in weights]
        scaled_exposure = float(
            sum(w * r for w, r in zip(scaled, risk_scores))
        )
        return scaled, scaled_exposure

    def _fallback_proportional_allocation(
        self,
        strategies: List[Dict],
        total_capital: float,
    ) -> Tuple[Dict[str, float], Dict[str, any]]:
        """Fallback allocation proportional to APY when CVXPY unavailable."""
        strategy_ids = [s["id"] for s in strategies]
        apys = np.array([float(s["current_apy"]) for s in strategies])

        # Weight proportional to APY
        total_apy = apys.sum()
        if total_apy == 0:
            # Equal weight if all APYs are zero
            weights = np.ones(len(strategies)) / len(strategies)
        else:
            weights = apys / total_apy

        # Apply capacity AND diversification caps without breaking them through
        # renormalisation, then honour the portfolio risk-weight budget.
        caps = self._capacity_caps(strategies, total_capital)
        adjusted_weights = self._cap_weights(
            [float(w) for w in weights], caps
        )
        adjusted_weights, risk_exposure = self._apply_risk_budget(
            adjusted_weights, [float(s.get("risk_score", 0.0)) for s in strategies]
        )

        allocated = np.array(adjusted_weights)
        allocations = {strategy_ids[i]: float(allocated[i]) for i in range(len(strategies))}

        # Compute metrics
        expected_apy = float(apys @ allocated)
        metrics = {
            "expected_apy": expected_apy,
            "portfolio_risk": None,
            "portfolio_risk_score": risk_exposure,
            "sharpe_ratio": None,
            "capital_deployed_fraction": float(allocated.sum()),
            "optimization_status": "fallback_proportional",
            "solver": "proportional_apy",
            "risk_budget": self.max_portfolio_risk,
        }

        return allocations, metrics

    def check_drift(
        self,
        current_allocations: Dict[str, Decimal],
        target_allocations: Dict[str, Decimal],
    ) -> Tuple[Decimal, Dict[str, Decimal]]:
        """Compute allocation drift magnitude |W_current - W_target|.

        Parameters
        ----------
        current_allocations : Dict[str, Decimal]
            Current portfolio weights {strategy_id: weight}.
        target_allocations : Dict[str, Decimal]
            Target portfolio weights {strategy_id: weight}.

        Returns
        -------
        Tuple[Decimal, Dict[str, Decimal]]
            (max_drift, drift_per_strategy) where max_drift is the maximum
            absolute drift across all strategies.
        """
        all_strategies = set(current_allocations.keys()) | set(
            target_allocations.keys()
        )

        drifts = {}
        for strategy_id in all_strategies:
            current = current_allocations.get(strategy_id, Decimal("0"))
            target = target_allocations.get(strategy_id, Decimal("0"))
            drift = abs(current - target)
            drifts[strategy_id] = drift

        max_drift = max(drifts.values()) if drifts else Decimal("0")

        log.debug(
            "portfolio_optimizer.drift_computed",
            component="PortfolioOptimizer",
            max_drift=float(max_drift),
            strategy_count=len(all_strategies),
        )

        return max_drift, drifts


def create_portfolio_optimizer() -> PortfolioOptimizer:
    """Factory that builds a PortfolioOptimizer from environment variables.

    Environment variables:
    * PORTFOLIO_RISK_AVERSION — risk aversion parameter (default: 0.5)
    * PORTFOLIO_MAX_SINGLE_ALLOCATION — max single strategy weight (default: 0.4)
    * PORTFOLIO_MIN_ALLOCATION — min allocation weight (default: 0.01)
    * PORTFOLIO_MAX_STRATEGY_RISK — max risk_score eligible for allocation
      (default: 1.0, i.e. every strategy is eligible)
    * PORTFOLIO_MAX_PORTFOLIO_RISK — max capital-weighted portfolio risk score
      (default: 1.0, i.e. unconstrained)

    Returns
    -------
    PortfolioOptimizer
        Configured optimizer instance.
    """
    risk_aversion = float(os.getenv("PORTFOLIO_RISK_AVERSION", "0.5"))
    max_single = float(os.getenv("PORTFOLIO_MAX_SINGLE_ALLOCATION", "0.4"))
    min_alloc = float(os.getenv("PORTFOLIO_MIN_ALLOCATION", "0.01"))
    max_strategy_risk = float(os.getenv("PORTFOLIO_MAX_STRATEGY_RISK", "1.0"))
    max_portfolio_risk = float(os.getenv("PORTFOLIO_MAX_PORTFOLIO_RISK", "1.0"))

    return PortfolioOptimizer(
        risk_aversion=risk_aversion,
        max_single_allocation=max_single,
        min_allocation=min_alloc,
        max_strategy_risk=max_strategy_risk,
        max_portfolio_risk=max_portfolio_risk,
    )
