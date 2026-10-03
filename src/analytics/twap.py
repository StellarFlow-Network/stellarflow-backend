import math
import numpy as np
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class PriceSample:
    """Represents a price sample from an oracle feed for a pool.

    Attributes:
        timestamp: Time at which the price was observed.
        price: Observed price sample value (P_sample).
        volume: Volume associated with the sample (default: 0.0).
        pool_id: Unique identifier of the pool (e.g. 'xlm-usdc').
        feed_id: Identifier of the oracle feed or source (e.g. 'binance', 'coingecko').
        source: Additional source metadata.
    """
    timestamp: datetime
    price: float
    volume: float = 0.0
    pool_id: Optional[str] = None
    feed_id: Optional[str] = None
    source: Optional[str] = None


@dataclass
class TradePoint:
    """Point representing a trade or price sample. Retained for backwards compatibility."""
    timestamp: datetime
    price: float
    volume: float = 0.0
    pool_id: Optional[str] = None
    feed_id: Optional[str] = None
    source: Optional[str] = None


@dataclass
class OutlierAuditRecord:
    """Audit log entry recorded when an outlier price spike is suppressed."""
    pool_id: str
    sample_price: float
    z_score: float
    mean: float
    std_dev: float
    timestamp: datetime
    threshold: float = 3.0
    feed_id: Optional[str] = None
    source: Optional[str] = None
    window_seconds: float = 3600.0
    reason: str = "Outlier price spike detected: |Z| > 3.0"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pool_id": self.pool_id,
            "sample_price": self.sample_price,
            "z_score": self.z_score,
            "mean": self.mean,
            "std_dev": self.std_dev,
            "timestamp": self.timestamp.isoformat(),
            "threshold": self.threshold,
            "feed_id": self.feed_id,
            "source": self.source,
            "window_seconds": self.window_seconds,
            "reason": self.reason,
            "created_at": self.created_at.isoformat(),
        }


class PostgresAuditLogger:
    """Audit logger that records suppressed price samples in a PostgreSQL audit database.

    Supports writing to PostgreSQL via SQLAlchemy or raw connections, with an
    in-memory audit trail buffer for fast inspection and testing.
    """

    def __init__(
        self,
        db_url: Optional[str] = None,
        table_name: str = "audit_logs",
        auto_create_table: bool = True,
        engine: Optional[Any] = None,
    ) -> None:
        self.db_url = db_url
        self.table_name = table_name
        self.auto_create_table = auto_create_table
        self._engine = engine
        self._logged_records: List[OutlierAuditRecord] = []
        self._lock = threading.Lock()

        if self._engine is None and self.db_url:
            try:
                from sqlalchemy import create_engine
                self._engine = create_engine(self.db_url)
                if self.auto_create_table:
                    self._ensure_table_exists()
            except Exception as exc:
                logger.warning("Could not initialize database engine for audit logging: %s", exc)

    def _ensure_table_exists(self) -> None:
        """Create the audit table if it does not already exist."""
        if not self._engine:
            return
        try:
            from sqlalchemy import text
            create_sql = text(f"""
                CREATE TABLE IF NOT EXISTS {self.table_name} (
                    id SERIAL PRIMARY KEY,
                    operation_type VARCHAR(100) NOT NULL,
                    actor VARCHAR(256) NOT NULL,
                    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    payload JSONB NOT NULL,
                    record_hash VARCHAR(64) NOT NULL,
                    signature VARCHAR(512) NOT NULL,
                    key_id VARCHAR(256) NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)
            with self._engine.begin() as conn:
                conn.execute(create_sql)
        except Exception as exc:
            logger.debug("Table check/creation skipped or failed: %s", exc)

    def log_suppressed_sample(self, record: OutlierAuditRecord) -> None:
        """Log a suppressed price sample to memory and the PostgreSQL audit database."""
        with self._lock:
            self._logged_records.append(record)

        if self._engine:
            try:
                from sqlalchemy import text
                payload_json = json.dumps(record.to_dict())
                canonical = f"price_spike_suppressed:{record.pool_id}:{record.timestamp.isoformat()}:{payload_json}"
                record_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

                insert_sql = text(f"""
                    INSERT INTO {self.table_name} 
                    (operation_type, actor, timestamp, payload, record_hash, signature, key_id)
                    VALUES 
                    (:op_type, :actor, :timestamp, :payload, :record_hash, :signature, :key_id)
                """)
                with self._engine.begin() as conn:
                    conn.execute(insert_sql, {
                        "op_type": "configuration_change",
                        "actor": f"oracle_feed_monitor:{record.feed_id or 'default'}",
                        "timestamp": record.created_at,
                        "payload": payload_json,
                        "record_hash": record_hash,
                        "signature": f"sig-{record_hash[:16]}",
                        "key_id": "oracle-twap-system",
                    })
                logger.info(
                    "Logged suppressed price spike to PostgreSQL audit database: pool=%s, price=%s, z=%s",
                    record.pool_id, record.sample_price, record.z_score
                )
            except Exception as exc:
                logger.warning("Failed to persist audit log record to PostgreSQL: %s", exc)

    def get_logged_records(self, pool_id: Optional[str] = None) -> List[OutlierAuditRecord]:
        """Return a copy of logged audit records, optionally filtered by pool_id."""
        with self._lock:
            if pool_id is None:
                return list(self._logged_records)
            return [r for r in self._logged_records if r.pool_id == pool_id]

    def clear(self) -> None:
        """Clear the in-memory log buffer."""
        with self._lock:
            self._logged_records.clear()


# Default singleton instance
default_audit_logger = PostgresAuditLogger()


@dataclass
class SwapLeg:
    """A single child order in a Twap execution schedule."""
    index: int
    timestamp: datetime
    asset_in: str
    asset_out: str
    amount_in: float
    expected_price: float
    expected_out: float
    market_impact: float
    gas_cost_eth: float


@dataclass
class DiversificationPlan:
    """Result of simulating a treasury diversification swap route."""
    legs: List[SwapLeg]
    total_amount_in: float
    total_expected_out: float
    average_market_impact: float
    max_market_impact: float
    total_gas_eth: float
    total_gas_usd: float
    gas_breakdown: Dict[str, float]
    schedule_start: datetime
    schedule_end: datetime


class TWAPENgine:
    """Calculates Time-Weighted Average Price (TWAP) with outlier filtering."""

    @staticmethod
    def calculate_z_score(
        sample_price: float,
        window_prices: Sequence[float],
    ) -> float:
        """Calculate the price Z-score: Z = (P_sample - mu) / sigma against a rolling window.

        Args:
            sample_price: Current price sample under evaluation (P_sample).
            window_prices: Sequence of historical prices within the rolling window.

        Returns:
            The calculated Z-score.
            Returns 0.0 if fewer than 2 samples exist in the window (insufficient data).
            If sigma == 0 (all historical prices identical):
                - returns 0.0 if sample_price == mu (no deviation)
                - returns +inf or -inf if sample_price != mu (infinite deviation / spike)
        """
        if len(window_prices) < 2:
            return 0.0

        prices_array = np.array(window_prices, dtype=np.float64)
        mu = float(np.mean(prices_array))
        sigma = float(np.std(prices_array))

        if sigma == 0.0:
            if sample_price == mu:
                return 0.0
            return float("inf") if sample_price > mu else float("-inf")

        return (sample_price - mu) / sigma

    @classmethod
    def is_outlier(
        cls,
        sample_price: float,
        window_prices: Sequence[float],
        threshold: float = 3.0,
    ) -> Tuple[bool, float, float, float]:
        """Determine whether sample_price is an outlier given window_prices.

        Returns:
            Tuple of (is_outlier, z_score, mean, std_dev)
        """
        if len(window_prices) < 2:
            return False, 0.0, float(sample_price), 0.0

        prices_array = np.array(window_prices, dtype=np.float64)
        mu = float(np.mean(prices_array))
        sigma = float(np.std(prices_array))

        if sigma == 0.0:
            if sample_price == mu:
                return False, 0.0, mu, 0.0
            z_score = float("inf") if sample_price > mu else float("-inf")
            return True, z_score, mu, 0.0

        z_score = (sample_price - mu) / sigma
        is_spike = abs(z_score) > threshold
        return is_spike, z_score, mu, sigma

    @classmethod
    def filter_price_spikes(
        cls,
        samples: Sequence[Union[PriceSample, TradePoint]],
        window: timedelta = ROLLING_WINDOW_DEFAULT,
        threshold: float = Z_SCORE_THRESHOLD_DEFAULT,
        pool_id: Optional[str] = None,
        audit_logger: Optional[PostgresAuditLogger] = None,
    ) -> List[Union[PriceSample, TradePoint]]:
        """Detect and suppress outlier price spikes where |Z| > threshold against a rolling window.

        Suppressed price samples are excluded from TWAP calculations and logged to the
        PostgreSQL audit database.

        Args:
            samples: Time series of price samples or trade points.
            window: Rolling window duration (default: 1 hour).
            threshold: Z-score threshold for outlier suppression (|Z| > threshold, default: 3.0).
            pool_id: Liquidity pool identifier.
            audit_logger: Audit logger for recording suppressed samples.

        Returns:
            List of clean (non-suppressed) price samples.
        """
        if not samples:
            return []

        logger_to_use = audit_logger or default_audit_logger

        # Sort chronologically
        sorted_samples = sorted(samples, key=lambda s: s.timestamp)
        clean_samples: List[Union[PriceSample, TradePoint]] = []

        for sample in sorted_samples:
            # Baseline prices from clean samples in the rolling window [sample.timestamp - window, sample.timestamp)
            cutoff = sample.timestamp - window
            window_prices = [
                prev.price for prev in clean_samples
                if cutoff <= prev.timestamp < sample.timestamp
            ]

            is_spike, z, mu, sigma = cls.is_outlier(sample.price, window_prices, threshold=threshold)

            if is_spike:
                # Suppress outlier price spike
                target_pool = pool_id or getattr(sample, "pool_id", None) or "unknown-pool"
                feed_id = getattr(sample, "feed_id", None)
                source = getattr(sample, "source", None)

                record = OutlierAuditRecord(
                    pool_id=target_pool,
                    sample_price=sample.price,
                    z_score=z,
                    mean=mu,
                    std_dev=sigma,
                    timestamp=sample.timestamp,
                    threshold=threshold,
                    feed_id=feed_id,
                    source=source,
                    window_seconds=window.total_seconds(),
                    reason=f"Outlier price spike detected: |Z|={abs(z):.4f} > {threshold}",
                )
                logger_to_use.log_suppressed_sample(record)
                logger.warning(
                    "Price sample suppressed from TWAP calculation: pool=%s, price=%.4f, Z=%.2f, mean=%.4f, sigma=%.4f",
                    target_pool, sample.price, z, mu, sigma
                )
            else:
                clean_samples.append(sample)

        return clean_samples

    @staticmethod
    def filter_outliers(
        trades: List[TradePoint],
        variance_threshold: float = 0.50,
    ) -> List[TradePoint]:
        """Legacy filter: removes trades exceeding variance_threshold from moving median."""
        if not trades:
            return []

        prices = [t.price for t in trades]
        median_price = float(np.median(prices))

        if median_price == 0:
            return trades

        filtered_trades = []
        for trade in trades:
            variance = abs(trade.price - median_price) / median_price
            if variance <= variance_threshold:
                filtered_trades.append(trade)

        return filtered_trades

    @classmethod
    def calculate_twap(
        cls,
        trades: List[TradePoint],
        window: timedelta,
        current_time: Optional[datetime] = None,
        use_zscore_filter: bool = True,
        z_threshold: float = Z_SCORE_THRESHOLD_DEFAULT,
        audit_logger: Optional[PostgresAuditLogger] = None,
        pool_id: Optional[str] = None,
    ) -> float:
        """Calculate time-weighted average price over a time window with outlier spike suppression.

        Args:
            trades: List of TradePoint or PriceSample instances.
            window: TWAP integration window duration.
            current_time: Current reference time (defaults to timezone.utc now).
            use_zscore_filter: Whether to apply Z-score spike suppression (|Z| > 3.0 against 1-hour window).
            z_threshold: Z-score cutoff threshold (default: 3.0).
            audit_logger: Optional audit logger for recording suppressed samples.
            pool_id: Pool identifier for audit logging context.

        Returns:
            Time-weighted average price rounded to 6 decimal places.
        """
        if not trades:
            return 0.0

        if current_time is None:
            current_time = datetime.now(timezone.utc)

        start_time = current_time - window

        # Sort trades by timestamp ascending
        sorted_trades = sorted(trades, key=lambda t: t.timestamp)

        # Filter trades within the requested TWAP window
        window_trades = [t for t in sorted_trades if t.timestamp >= start_time]

        # Filter price outliers using Z-score or legacy median variance
        if use_zscore_filter:
            clean_trades = cls.filter_price_spikes(
                window_trades,
                window=cls.ROLLING_WINDOW_DEFAULT,
                threshold=z_threshold,
                pool_id=pool_id,
                audit_logger=audit_logger,
            )
        else:
            clean_trades = cls.filter_outliers(window_trades)

        if not clean_trades:
            return 0.0

        # Compute time-weighted average price using linear interval integration
        total_time_weighted_price = 0.0
        total_time_delta = 0.0

        for i in range(len(clean_trades)):
            current = clean_trades[i]
            # Determine interval duration to the next trade or current_time
            if i < len(clean_trades) - 1:
                next_time = clean_trades[i + 1].timestamp
            else:
                next_time = current_time

            duration = (next_time - current.timestamp).total_seconds()
            if duration > 0:
                total_time_weighted_price += current.price * duration
                total_time_delta += duration

        if total_time_delta == 0:
            return clean_trades[-1].price

        return round(total_time_weighted_price / total_time_delta, 6)


class TreasuryDiversificationSimulator:
    """Simulates market impact of multi-asset treasury diversification swaps.

    Splits large diversification swaps into Twap orders to minimize market impact
    and outputs an execution schedule with an estimated gas cost breakdown.
    """

    # Default liquidity depth factors (in USD) for common treasury assets.
    DEFAULT_LIQUIDITY_DEPTH: Dict[str, float] = {
        "USDT": 500_000_000.0,
        "USDC": 200_000_000.0,
        "DAI": 100_000_000.0,
        "WBTC": 50_000_000.0,
        "WETH": 50_000_000.0,
        "STOSE": 5_000_000.0,
        "ARB": 2_000_000.0,
        "OP": 2_000_000.0,
        "MATIC": 1_000_000.0,
        "LARGE": 1_000_000.0,
    }

    # Default gas cost estimates (ETH) per swap leg by protocol.
    DEFAULT_GAS_PER_LEG: Dict[str, float] = {
        "uniswap_v2": 0.0015,
        "uniswap_v3": 0.0025,
        "curve": 0.0020,
        "balancer": 0.0030,
    }

    # Default gas price in USD per ETH.
    DEFAULT_GAS_PRICE_USD: float = 3000.0

    def __init__(
        self,
        liquidity_depth: Optional[Dict[str, float]] = None,
        gas_per_leg: Optional[Dict[str, float]] = None,
        gas_price_usd: float = DEFAULT_GAS_PRICE_USD,
        max_impact: float = 0.005,
    ) -> None:
        """
        Args:
            liquidity_depth: Map of asset symbol -> available liquidity depth in USD.
            gas_per_leg: Map of protocol -> gas cost in ETH per swap leg.
            gas_price_usd: Price of one ETH in USD.
            max_impact: Maximum acceptable market impact per leg (0.5% default).
        """
        self.liquidity_depth = dict(self.DEFAULT_LIQUIDITY_DEPTH)
        if liquidity_depth:
            self.liquidity_depth.update(liquidity_depth)

        self.gas_per_leg = dict(self.DEFAULT_GAS_PER_LEG)
        if gas_per_leg:
            self.gas_per_leg.update(gas_per_leg)

        self.gas_price_usd = gas_price_usd
        self.max_impact = max_impact

    def _estimate_market_impact(self, amount_usd: float, asset: str, liquidity_depth_usd: Optional[float] = None) -> float:
        """Estimates price impact for a swap using a constant-product like model."""
        if amount_usd <= 0:
            return 0.0

        depth = liquidity_depth_usd
        if depth is None:
            depth = self.liquidity_depth.get(asset, 1_000_000.0)

        if depth <= 0:
            return 1.0

        # Constant-product impact approximation: dx / (depth + dx)
        impact = amount_usd / (depth + amount_usd)
        return min(impact, 1.0)

    def _choose_slice_count(
        self,
        total_amount_usd: float,
        asset: str,
        liquidity_depth_usd: Optional float = None,
    ) -> int:
        """Determines the minimum number of Twap slices to keep impact <= max_impact."""
        if total_amount_usd <= 0:
            return 1

        depth = liquidity_depth_usd
        if depth is None:
            depth = self.liquidity_depth.get(asset, 1_000_000.0)

        if depth <= 0:
            return 1

        # For constant-product, impact = x / (depth + x) <= max_impact
        # x <= max_impact * depth / (1 - max_impact)
        max_slice_usd = self.max_impact * depth / (1.0 - self.max_impact)
        if max_slice_usd <= 0:
            return 1

        slices = int(math.ceil(total_amount_usd / max_slice_usd))
        return max(slices, 1)

    def simulate_diversification(
        self,
        amount_in: float,
        asset_in: str,
        target_allocations: Dict[str, float],
        asset_prices: Dict[str, float],
        duration_hours: float = 24.0,
        num_slices: Optional[int] = None,
        protocol: str = "uniswap_v3",
        start_time: Optional[datetime] = None,
        liquidity_depth_usd: Optional float = None,
    ) -> DiversificationPlan:
        """Simulates a multi-asset treasury diversification swap via Twap.

        Args:
            amount_in: Total amount of the input asset to swap.
            asset_in: Symbol of the input asset.
            target_allocations: Map of output asset -> fraction of total value (1.0).
            asset_prices: Map of asset symbol -> USD price.
            duration_hours: Duration of the Twap execution in hours.
            num_slices: Explicit number of Twap slices. Auto-computed if None.
            protocol: DEX/AGM protocol used for gas estimation.
            start_time: Schedule start time. Defaults to now (UTC).
            liquidity_depth_usd: Optional override for the input asset liquidity depth.

        Returns:
            DiversificationPlan with execution schedule and gas cost breakdown.
        """
        if amount_in <= 0:
            raise ValueError("amount_in must be positive")
        if not target_allocations:
            raise ValueError("target_allocations must not be empty")
        if asset_in not in asset_prices:
            raise ValueError(f"missing price for input asset {asset_in}")

        alloc_sum = sum(target_allocations.values())
        if alloc_sum <= 0:
            raise ValueError("target_allocations must sum to a positive value")

        normalized_allocs = {k: v / alloc_sum for k, v in target_allocations.items()}

        for asset in normalized_allocs:
            if asset not in asset_prices:
                raise ValueError(f"missing price for output asset {asset}")

        if start_time is None:
            start_time = datetime.now(timezone.utc)
        elif start_time.tzinfo is None:
            start_time = start_time.replace(tzinfo=timezone.utc)

        if duration_hours <= 0:
            raise ValueError("duration_hours must be positive")

        price_in = asset_prices[asset_in]
        total_value_usd = amount_in * price_in
        depth_in = liquidity_depth_usd if liquidity_depth_usd is not None else self.liquidity_depth.get(asset_in, 1_000_000.0)

        # Determine the number of Twap slices required to keep impact <= max_impact.
        if num_slices is None:
            num_slices = self._choose_slice_count(total_value_usd, asset_in, depth_in)
        else:
            num_slices = max(int(num_slices), 1)

        slice_value_usd = total_value_usd / num_slices if num_slices else total_value_usd
        slice_amount_in = amount_in / num_slices if num_slices else amount_in

        gas_per_leg_eth = self.gas_per_leg.get(protocol, self.gas_per_leg["uniswap_v3"])
        gas_price_usd = self.gas_price_usd

        interval = timedelta(hours=duration_hours / num_slices)
        legs: List[SwapLeg] = []
        gas_breakdown: Dict[str, float] = {}
        total_out = 0.0
        total_impact = 0.0
        max_impact = 0.0
        leg_idx = 0

        for slice_idx in range(num_slices):
            slice_time = start_time + timedelta(hours=slice_idx * duration_hours / num_slices)
            for asset_out, alloc in normalized_allocs.items():
                if alloc <= 0:
                    continue

                amount_out_usd = slice_value_usd * alloc
                if amount_out_usd <= 0:
                    continue

                price_out = asset_prices[asset_out]
                if price_out <= 0:
                    continue

                depth_out = self.liquidity_depth.get(asset_out, 1_000_000.0)
                impact_in = self._estimate_market_impact(amount_out_usd, asset_in, depth_in)
                impact_out = self._estimate_market_impact(amount_out_usd, asset_out, depth_out)
                leg_impact = min(impact_in + impact_out, 1.0)

                amount_out = (amount_out_usd / price_out) * (1.0 - leg_impact)
                amount_in_leg = slice_amount_in * alloc
                gas_eth = gas_per_leg_eth

                legs.append(
                    SwapLeg(
                        index=leg_idx,
                        timestamp=slice_time,
                        asset_in=asset_in,
                        asset_out=asset_out,
                        amount_in=amount_in_leg,
                        expected_price=price_out,
                        expected_out=amount_out,
                        market_impact=leg_impact,
                        gas_cost_eth=gas_eth,
                    )
                )
                leg_idx += 1
                total_out += amount_out
                total_impact += leg_impact
                max_impact = max(max_impact, leg_impact)
                gas_breakdown[asset_out] = gas_breakdown.get(asset_out, 0.0) + gas_eth

        total_gas_eth = sum(gas_breakdown.values())
        total_gas_usd = total_gas_eth * gas_price_usd
        avg_impact = total_impact / len_legs if (len_legs := len(legs)) else 0.0
        schedule_end = start_time + timedelta(hours=duration_hours)

        return DiversificationPlan(
            legs=legs,
            total_amount_in=amount_in,
            total_expected_out=total_out,
            average_market_impact=avg_impact,
            max_market_impact=max_impact,
            total_gas_eth=total_gas_eth,
            total_gas_usd=total_gas_usd,
            gas_breakdown=gas_breakdown,
            schedule_start=start_time,
            schedule_end=schedule_end,
        )
