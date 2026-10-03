from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from sqlalchemy import create_engine, text

from src.analytics.twap import (
    OutlierAuditRecord,
    PostgresAuditLogger,
    PriceSample,
    RollingPoolTWAPTracker,
    TradePoint,
    TWAPEngine,
)


@pytest.fixture
def audit_logger():
    return PostgresAuditLogger()


@pytest.fixture
def base_time():
    return datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)


class TestZScoreCalculation:
    """Test Z-score formula calculation: Z = (P_sample - mu) / sigma against rolling window."""

    def test_z_score_exact_calculation(self):
        """Z-score matches mathematical formula (P_sample - mu) / sigma."""
        # Prices: 100, 102, 98, 104, 96 -> mean = 100.0, variance = (0 + 4 + 4 + 16 + 16)/5 = 8.0, sigma = sqrt(8) = 2.828427
        window_prices = [100.0, 102.0, 98.0, 104.0, 96.0]
        mu = float(np.mean(window_prices))
        sigma = float(np.std(window_prices))

        sample_price = 105.0
        expected_z = (sample_price - mu) / sigma
        calculated_z = TWAPEngine.calculate_z_score(sample_price, window_prices)

        assert pytest.approx(calculated_z, rel=1e-5) == expected_z
        assert pytest.approx(calculated_z, rel=1e-5) == (105.0 - 100.0) / math.sqrt(8.0)

    def test_z_score_insufficient_history(self):
        """When fewer than 2 samples are in window, Z-score returns 0.0 (cannot establish variance)."""
        assert TWAPEngine.calculate_z_score(100.0, []) == 0.0
        assert TWAPEngine.calculate_z_score(100.0, [100.0]) == 0.0

    def test_z_score_zero_variance_identical_price(self):
        """When all window prices are identical and sample matches, Z-score is 0.0."""
        window_prices = [100.0, 100.0, 100.0, 100.0]
        z = TWAPEngine.calculate_z_score(100.0, window_prices)
        assert z == 0.0

    def test_z_score_zero_variance_deviating_price(self):
        """When all window prices are identical and sample deviates, Z-score is +/- infinity (infinite spike)."""
        window_prices = [100.0, 100.0, 100.0]
        z_high = TWAPEngine.calculate_z_score(150.0, window_prices)
        z_low = TWAPEngine.calculate_z_score(50.0, window_prices)
        assert z_high == float("inf")
        assert z_low == float("-inf")

    def test_is_outlier_threshold_boundary(self):
        """Threshold |Z| > 3.0: Z=3.0 is NOT an outlier, Z=3.01 IS an outlier."""
        # Mean = 100, sigma = 10
        # 10 values with mean=100 and sigma=10
        # We can construct window: 5 at 90, 5 at 110 -> mean = 100, sigma = 10
        window = [90.0] * 5 + [110.0] * 5
        assert np.mean(window) == 100.0
        assert np.std(window) == 10.0

        # P_sample = 130 -> Z = (130 - 100) / 10 = 3.0
        is_spike_30, z_30, _, _ = TWAPEngine.is_outlier(130.0, window, threshold=3.0)
        assert not is_spike_30
        assert pytest.approx(z_30, rel=1e-5) == 3.0

        # P_sample = 130.1 -> Z = 3.01 > 3.0 -> outlier!
        is_spike_31, z_31, _, _ = TWAPEngine.is_outlier(130.1, window, threshold=3.0)
        assert is_spike_31
        assert z_31 > 3.0

        # Negative spike: P_sample = 69.9 -> Z = -3.01 -> |Z| = 3.01 > 3.0 -> outlier!
        is_spike_neg, z_neg, _, _ = TWAPEngine.is_outlier(69.9, window, threshold=3.0)
        assert is_spike_neg
        assert abs(z_neg) > 3.0


class TestPriceSpikeSuppressionAndRollingWindow:
    """Test suppression of |Z| > 3.0 price samples against a rolling 1-hour window."""

    def test_suppresses_price_samples_exceeding_threshold(self, base_time, audit_logger):
        """Price samples with |Z| > 3.0 are suppressed and omitted from clean list."""
        samples = []
        # Create normal baseline samples every 2 minutes for 30 minutes (15 samples) around price 100.0 +/- 0.5
        for i in range(15):
            t = base_time + timedelta(minutes=i * 2)
            p = 100.0 + (0.5 if i % 2 == 0 else -0.5)
            samples.append(PriceSample(timestamp=t, price=p, volume=10.0, pool_id="xlm-usdc"))

        # Inject an extreme price spike at minute 32: price = 150.0 (Z will be > 50)
        spike_time = base_time + timedelta(minutes=32)
        spike_sample = PriceSample(timestamp=spike_time, price=150.0, volume=10.0, pool_id="xlm-usdc", feed_id="pyth")
        samples.append(spike_sample)

        # Inject a normal trade at minute 34: price = 100.2 (normal)
        normal_after_time = base_time + timedelta(minutes=34)
        normal_sample = PriceSample(timestamp=normal_after_time, price=100.2, volume=10.0, pool_id="xlm-usdc")
        samples.append(normal_sample)

        clean = TWAPEngine.filter_price_spikes(
            samples,
            window=timedelta(hours=1),
            threshold=3.0,
            audit_logger=audit_logger,
        )

        # Verify the spike was suppressed
        clean_prices = [s.price for s in clean]
        assert 150.0 not in clean_prices
        assert 100.2 in clean_prices
        assert len(clean) == len(samples) - 1

        # Verify audit log captured the suppressed sample
        records = audit_logger.get_logged_records("xlm-usdc")
        assert len(records) == 1
        assert records[0].sample_price == 150.0
        assert records[0].z_score > 3.0
        assert records[0].pool_id == "xlm-usdc"
        assert records[0].feed_id == "pyth"
        assert records[0].threshold == 3.0

    def test_rolling_1_hour_window_eviction(self, base_time, audit_logger):
        """Samples older than 1 hour do not contaminate the baseline for current sample."""
        samples = []
        # Hour 0: Price baseline was around 50.0 between minute 0 and 15
        for i in range(4):
            t = base_time + timedelta(minutes=i * 5)
            samples.append(PriceSample(timestamp=t, price=50.0, volume=1.0, pool_id="xlm-usdc"))

        # 75 minutes later (> 1 hour after minute 15): Price is now 100.0
        # Cutoff at minute 80 is 80 - 60 = 20 > 15, so minute 0-15 samples are fully evicted!
        for i in range(5):
            t = base_time + timedelta(minutes=80 + i * 2)
            samples.append(PriceSample(timestamp=t, price=100.0 + (0.2 if i % 2 == 0 else -0.2), volume=1.0, pool_id="xlm-usdc"))

        # Sample at minute 90 at 100.1 is normal compared to [30m, 90m) (only contains the 80m+ samples)
        t_current = base_time + timedelta(minutes=90)
        test_sample = PriceSample(timestamp=t_current, price=100.1, volume=1.0, pool_id="xlm-usdc")
        samples.append(test_sample)

        clean = TWAPEngine.filter_price_spikes(
            samples,
            window=timedelta(hours=1),
            threshold=3.0,
            audit_logger=audit_logger,
        )

        # The test sample at 100.1 is retained and clean
        assert any(s.price == 100.1 for s in clean)
        # Because the old 50.0 samples aged out, no false positive spikes occurred at 100.0
        assert len(audit_logger.get_logged_records()) == 0


class TestTWAPCalculationWithSuppression:
    """Test pool TWAP calculation excluding suppressed outlier price spikes."""

    def test_calculate_twap_suppresses_spikes(self, base_time, audit_logger):
        """TWAP calculation without outliers yields accurate time-weighted price."""
        # 1-hour window from base_time to base_time + 1h
        # Steady price of 10.0 for 50 minutes, then a brief 1000.0 flash loan / oracle glitch spike for 5 minutes,
        # then back to 10.0 for 5 minutes.
        t0 = base_time
        t1 = base_time + timedelta(minutes=20)
        t2 = base_time + timedelta(minutes=40)
        t_spike = base_time + timedelta(minutes=50)
        t_end = base_time + timedelta(minutes=55)
        current_time = base_time + timedelta(minutes=60)

        trades = [
            TradePoint(timestamp=t0, price=10.0, volume=100.0, pool_id="pool-1"),
            TradePoint(timestamp=t1, price=10.0, volume=100.0, pool_id="pool-1"),
            TradePoint(timestamp=t2, price=10.0, volume=100.0, pool_id="pool-1"),
            TradePoint(timestamp=t_spike, price=1000.0, volume=100.0, pool_id="pool-1", feed_id="glitched-feed"),
            TradePoint(timestamp=t_end, price=10.0, volume=100.0, pool_id="pool-1"),
        ]

        twap_with_suppression = TWAPEngine.calculate_twap(
            trades=trades,
            window=timedelta(hours=1),
            current_time=current_time,
            use_zscore_filter=True,
            z_threshold=3.0,
            audit_logger=audit_logger,
            pool_id="pool-1",
        )

        # Without outlier suppression, the 1000.0 price for 5 minutes would distort the TWAP:
        # Expected TWAP with suppression: flat 10.0
        assert twap_with_suppression == 10.0

        # Verify audit log captured the 1000.0 spike
        records = audit_logger.get_logged_records("pool-1")
        assert len(records) == 1
        assert records[0].sample_price == 1000.0
        assert records[0].feed_id == "glitched-feed"

    def test_calculate_pool_twap_helper(self, base_time, audit_logger):
        """calculate_pool_twap handles pool-specific samples, outlier suppression, and audit logging."""
        samples = [
            PriceSample(timestamp=base_time + timedelta(minutes=0), price=2.0, pool_id="xlm-usdc"),
            PriceSample(timestamp=base_time + timedelta(minutes=15), price=2.0, pool_id="xlm-usdc"),
            PriceSample(timestamp=base_time + timedelta(minutes=30), price=2.0, pool_id="xlm-usdc"),
            PriceSample(timestamp=base_time + timedelta(minutes=40), price=200.0, pool_id="xlm-usdc", feed_id="bad-oracle"),
            PriceSample(timestamp=base_time + timedelta(minutes=45), price=2.0, pool_id="xlm-usdc"),
        ]

        pool_twap = TWAPEngine.calculate_pool_twap(
            pool_id="xlm-usdc",
            samples=samples,
            window=timedelta(hours=1),
            current_time=base_time + timedelta(hours=1),
            z_threshold=3.0,
            audit_logger=audit_logger,
        )

        assert pool_twap == 2.0
        assert len(audit_logger.get_logged_records("xlm-usdc")) == 1
        assert audit_logger.get_logged_records("xlm-usdc")[0].sample_price == 200.0

    def test_empty_trades_returns_zero(self):
        """Empty trades list returns 0.0."""
        assert TWAPEngine.calculate_twap([], timedelta(hours=1)) == 0.0
        assert TWAPEngine.calculate_pool_twap("any-pool", [], timedelta(hours=1)) == 0.0


class TestPostgresAuditLogger:
    """Test logging suppressed price samples in the PostgreSQL audit database."""

    def test_in_memory_audit_logging(self):
        """Audit logger records all details of suppressed samples."""
        logger = PostgresAuditLogger()
        now = datetime.now(timezone.utc)
        record = OutlierAuditRecord(
            pool_id="btc-usdc",
            sample_price=999999.0,
            z_score=15.42,
            mean=65000.0,
            std_dev=1200.0,
            timestamp=now,
            threshold=3.0,
            feed_id="oracle-primary",
            reason="Outlier price spike detected: |Z|=15.42 > 3.0",
        )

        logger.log_suppressed_sample(record)
        logs = logger.get_logged_records("btc-usdc")
        assert len(logs) == 1
        assert logs[0].sample_price == 999999.0
        assert logs[0].z_score == 15.42
        assert logs[0].pool_id == "btc-usdc"
        assert logs[0].threshold == 3.0
        assert "Outlier price spike" in logs[0].reason

    def test_database_persistence_sqlite_and_postgres_compatible(self):
        """Audit logger persists to SQL database table with valid audit schema."""
        # Test with an in-memory SQLite database via SQLAlchemy (validating SQL execution and table creation)
        engine = create_engine("sqlite:///:memory:")
        logger = PostgresAuditLogger(engine=engine, table_name="test_audit_logs", auto_create_table=False)

        # Create table manually to match PostgreSQL schema in sqlite-compatible syntax
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE test_audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    operation_type VARCHAR(100) NOT NULL,
                    actor VARCHAR(256) NOT NULL,
                    timestamp TIMESTAMP NOT NULL,
                    payload TEXT NOT NULL,
                    record_hash VARCHAR(64) NOT NULL,
                    signature VARCHAR(512) NOT NULL,
                    key_id VARCHAR(256) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """))

        now = datetime.now(timezone.utc)
        record = OutlierAuditRecord(
            pool_id="xlm-ngn",
            sample_price=5000.0,
            z_score=12.5,
            mean=185.0,
            std_dev=5.0,
            timestamp=now,
            feed_id="oracle-sec",
        )

        logger.log_suppressed_sample(record)

        # Verify record was inserted into the database
        with engine.begin() as conn:
            rows = conn.execute(text("SELECT operation_type, actor, payload, record_hash FROM test_audit_logs")).fetchall()

        assert len(rows) == 1
        row = rows[0]
        assert row[0] == "configuration_change"
        assert "oracle-sec" in row[1]
        assert "5000.0" in row[2]
        assert len(row[3]) == 64  # SHA-256 hex string

    def test_database_error_resilience(self):
        """If database insertion throws an exception, audit logger catches it without halting execution."""
        mock_engine = MagicMock()
        mock_engine.begin.side_effect = RuntimeError("Database connection timed out")

        logger = PostgresAuditLogger(engine=mock_engine)
        record = OutlierAuditRecord(
            pool_id="eth-usdc",
            sample_price=100000.0,
            z_score=20.0,
            mean=3000.0,
            std_dev=50.0,
            timestamp=datetime.now(timezone.utc),
        )

        # Should not raise exception
        logger.log_suppressed_sample(record)
        # Should still retain in in-memory trail
        assert len(logger.get_logged_records("eth-usdc")) == 1


class TestRollingPoolTWAPTracker:
    """Test streaming stateful tracker for oracle feeds."""

    def test_streaming_tracker_spike_suppression(self, base_time):
        """Tracker processes stream, suppresses spikes (|Z| > 3.0), and provides accurate TWAP."""
        logger = PostgresAuditLogger()
        tracker = RollingPoolTWAPTracker(
            pool_id="xlm-usdc",
            window=timedelta(hours=1),
            z_threshold=3.0,
            audit_logger=logger,
        )

        # Feed 10 normal samples
        for i in range(10):
            accepted = tracker.add_sample(
                price=0.12 + (0.001 if i % 2 == 0 else -0.001),
                timestamp=base_time + timedelta(minutes=i * 5),
                feed_id="binance",
            )
            assert accepted is True

        # Feed an extreme spike sample
        spike_accepted = tracker.add_sample(
            price=1.20,  # 10x spike
            timestamp=base_time + timedelta(minutes=52),
            feed_id="malicious-feed",
        )
        assert spike_accepted is False  # Suppressed!

        # Feed another normal sample
        next_accepted = tracker.add_sample(
            price=0.121,
            timestamp=base_time + timedelta(minutes=55),
            feed_id="binance",
        )
        assert next_accepted is True

        # Verify clean samples count: 11 (10 initial + 1 next, spike excluded)
        clean = tracker.get_clean_samples()
        assert len(clean) == 11
        assert all(s.price < 0.15 for s in clean)

        # Verify suppressed records
        suppressed = tracker.get_suppressed_records()
        assert len(suppressed) == 1
        assert suppressed[0].sample_price == 1.20

        # Verify TWAP is near 0.12, not 1.20
        twap = tracker.get_twap(current_time=base_time + timedelta(hours=1))
        assert pytest.approx(twap, rel=1e-2) == 0.12
