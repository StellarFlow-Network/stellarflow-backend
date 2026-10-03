import threading

from typing import Dict, Any, Optional, List, Tuple

from dataclasses import dataclass, field

from decimal import Decimal, ROUND_HALF_UP


@dataclass(frozen=True)
class AssetLiquidity:
    """
    Liquidity metadata for an asset, used to compute market impact of a swap.
    """
    daily_volume_usd: Decimal
    spread_b_ps: Decimal  # basis points, 1 bp = 0.01%
    gas_per_swap_usd: Decimal = Decimal("0.01")


@dataclass
 class SwapLeg:
    """A leg of a diversification swap."""
    from_asset: str
    to_asset: str
    amount_usd: Decimal


@dataclass(frozen=True)
 class TWAPPlan:
    """
    Execution schedule for a single swap leg, split into TWAP slices.
    """
    from_asset: str
    to_asset: str
    total_usd: Decimal
    slices: int
    slice_usd: Decimal
    estimated_impact_percent: Decimal
    estimated_gas_usd: Decimal


@dataclass(frozen=True)
 class SwapSimulationResult:
    """Full result of a multi-asset diversification swap simulation."""
    plans: List[TWAPPlan]
    total_impact_percent: Decimal
    total_gas_usd: Decimal
    max_impact_percent: Decimal


class AssetRegistry:
    """
    Thread-safe global registry for asset mapping configurations.
    Protects reads and mutations to prevent data race conditions in concurrent environments.
    Also holds liquidity metadata used by the treasury diversification swap simulator.
    """
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._assets: Dict[str, Any] = {
            "USD": "US Dollar",
            "EUR": "Euro",
            "GBP": "British Pound",
            "NGN": "Nigerian Naira",
            "GHS": "Ghanaian Cedi",
            "KES": "Kenyan Shilling",
            "XLM": "Stellar Lumens",
        }
        self._liquidity: Dict[str, AssetLiquidity] = {
            "USD": AssetLiquidity(Decimal("1000000000"), Decimal("1"), Decimal("0.01")),
            "EUR": AssetLiquidity(Decimal("500000000"), Decimal("2"), Decimal("0.01")),
            "GBP": AssetLiquidity(Decimal("200000000"), Decimal("3"), Decimal("0.01")),
            "NGN": AssetLiquidity(Decimal("50000000"), Decimal("10"), Decimal("0.01")),
            "GHS": AssetLiquidity(Decimal("30000000"), Decimal("15"), Decimal("0.01")),
            "KES": AssetLiquidity(Decimal("20000000"), Decimal("20"), Decimal("0.01")),
            "XLM": AssetLiquidity(Decimal("100000000"), Decimal("5"), Decimal("0.01")),
        }

    def get_asset_name(self, asset_code: str) -> Optional[str]:
        """
        Thread-safe lookup of an asset's name by its code.
        """
        with self._lock:
            return self._assets.get(asset_code)

    def register_asset(self, asset_code: str, name: str, liquidity: Optional[AssetLiquidity] = None) -> None:
        """
        Thread-safe registration of a new asset or update of an existing one.
        Optionally attaches liquidity metadata for swap simulation.
        """
        with self._lock:
            self._assets[asset_code] = name
            if liquidity is not None:
                self._liquidity[asset_code] = liquidity

    def remove_asset(self, asset_code: str) -> None:
        """
        Thread-safe removal of an asset.
        """
        with self._lock:
            if asset_code in self._assets:
                del self._assets[asset_code]
            self._liquidity.pop(asset_code, None)

    def get_all_assets(self) -> Dict[str, str]:
        """
        Thread-safe retrieval of a copy of all global asset configurations.
        """
        with self._lock:
            return self._assets.copy()

    def get_liquidity(self, asset_code: str) -> Optional[AssetLiquidity]:
        """Thread-safe lookup of an asset's liquidity metadata."""
        with self._lock:
            return self._liquidity.get(asset_code)

    def set_liquidity(self, asset_code: str, liquidity: AssetLiquidity) -> None:
        """Thread-safe update of an asset's liquidity metadata."""
        with self._lock:
            self._liquidity[asset_code] = liquidity

    def get_all_liquidity(self) -> Dict[str, AssetLiquidity]:
        """Thread-safe retrieval of a copy of all liquidity metadata."""
        with self._lock:
            return dict(self._liquidity)


class TreasurySwapSimulator:
    """
    Simulates market impact of executing multi-asset treasury diversification swaps.
    Splits large diversification swaps into TWAP orders to minimize market impact below 0.5%.
    Outputs execution schedule and estimated gas cost breakdown.
    """

    MAX_IMPACT_PERCENT = Decimal("0.5")
    MIN_SLICE_USD = Decimal("1000")
    MAX_SONTH_SLICES = 1000

    def __init__(self, registry: Optional[AssetRegistry] = None) -> None:
        self.registry = registry or global_assets

    def _impact_percent(self, asset_code: str, amount_usd: Decimal) -> Decimal:
        """
        Estimate market impact for a single slice using a square-root liquidity model.
        impact = spread + k * sqrt(amount / daily_volume)
        """
        liq = self.registry.get_liquidity(asset_code.split("/")[-1])
        if liq is None or liq.daily_volume_usd <= Decimal(0):
            return Decimal("100")
        ratio = amount_usd / liq.daily_volume_usd
        sqrt_ratio = ratio.sqrt()
        k = Decimal("10")
        impact = liq.spread_b_ps / Decimal("10000") * Decimal("100") + k * sqrt_ratio * Decimal("100")
        return impact.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

    def _slices_for_leg(self, leg: SwapLeg) -> int:
        """
        Determine the number of TWAP slices required so that each slice's
        estimated impact stays at or below MAX_IMPACT_PERCENT.
        """
        total = leg.amount_usd
        if total <= self.MIN_SLICE_USD:
            return 1
        slices = 1
        while slices < self.MAX_MONTH_SLICES:
            slice_amount = total / Decimal(slices)
            if self._impact_percent(leg.to_asset, slice_amount) <= self.MAX_IMPACT_PERCENT:
                break
            slices += 1
        return slices

    def simulate(self, legs: List[SwapLeg]) -> SwapSimulationResult:
        """
        Simulate a set of diversification swap legs, returning a TWAP
        execution schedule and gas cost breakdown.
        """
        plans: List[TWAPPlan] = []
        total_impact = Decimal(0)
        total_gas = Decimal(0)
        max_impact = Decimal(0)

        for leg in legs:
            if leg.amount_usd <= Decimal(0):
                continue
            slices = self._slices_for_leg(leg)
            slice_amount = (leg.amount_usd / Decimal(slices)).quantize(Decimal("0.01"))
            impact = self._impact_percent(leg.to_asset, slice_amount)
            liq = self.registry.get_liquidity(leg.to_asset.split("/")[-1])
            gas_per = liq.gas_per_swap_usd if liq else Decimal("0.01")
            gas = gas_per * Decimal(slices)
            plans.append(
                TWAPPlan(
                    from_asset=leg.from_asset,
                    to_asset=leg.to_asset,
                    total_usd=leg.amount_usd,
                    slices=slices,
                    slice_usd=slice_amount,
                    estimated_impact_percent=impact,
                    estimated_gas_usd=gas,
                )
            )
            total_impact += impact
            total_gas += gas
            max_impact = max(max_impact, impact)

        return SwapSimulationResult(
            plans=plans,
            total_impact_percent=total_impact,
            total_gas_usd=total_gas,
            max_impact_percent=max_impact,
        )


# Global config instance to be used across the application.
global_assets: AssetRegistry = AssetRegistry()
