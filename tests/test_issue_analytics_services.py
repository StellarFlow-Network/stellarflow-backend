from __future__ import annotations

import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from src.services import pool_market_metrics
from src.services import portfolio_balance_sync
from src.services.sandwich_attack_detector import SandwichAttackDetector


class PoolMarketMetricsTests(unittest.TestCase):
    def test_heatmap_returns_five_increasing_impact_tiers(self) -> None:
        result = pool_market_metrics.build_price_impact_heatmap(
            {
                "pool_id": "xlm-usdc",
                "asset_pair": "XLM/USDC",
                "total_liquidity_usd": 1_450_230.5,
                "current_price": 0.1245,
            }
        )

        self.assertEqual(len(result["tiers"]), 5)
        impacts = [tier["price_impact_percent"] for tier in result["tiers"]]
        outputs = [tier["estimated_output"] for tier in result["tiers"]]
        self.assertEqual(impacts, sorted(impacts))
        self.assertTrue(all(output > 0 for output in outputs))
        self.assertTrue(result["tiers"][-1]["liquidity_exhausted"])


class PoolApyTests(unittest.IsolatedAsyncioTestCase):
    async def test_fee_and_reward_apy_are_separated(self) -> None:
        now = datetime.now(timezone.utc)
        fee_rows = [
            {
                "timestamp": now - timedelta(days=6 - day),
                "fees24h": 70,
                "tvl": 10_000,
            }
            for day in range(7)
        ]
        reward_rows = [
            {
                "tokenCode": "RWD",
                "amountPerSecond": 0.000001,
                "tokenPriceUsd": 2,
                "startsAt": now - timedelta(days=1),
                "endsAt": None,
            }
        ]

        class Connection:
            async def fetch(self, query, *args):
                if '"PoolVolumeAnalytics"' in query:
                    return fee_rows
                return reward_rows

        class Acquire:
            async def __aenter__(self):
                return Connection()

            async def __aexit__(self, *_args):
                return None

        class DatabasePool:
            def acquire(self):
                return Acquire()

        with patch.object(
            pool_market_metrics,
            "_get_database_pool",
            AsyncMock(return_value=DatabasePool()),
        ):
            result = await pool_market_metrics.get_pool_apy_breakdown("xlm-usdc")

        self.assertEqual(result["fees_7d_usd"], 490)
        self.assertAlmostEqual(result["trading_fee_apy_percent"], 255.5)
        self.assertGreater(result["reward_emission_apy_percent"], 0)
        self.assertAlmostEqual(
            result["total_apy_percent"],
            result["trading_fee_apy_percent"] + result["reward_emission_apy_percent"],
        )


class PortfolioBalanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_identity_uses_linked_address_per_network(self) -> None:
        observed_addresses = {}

        async def provider(network):
            async def fetch(address):
                observed_addresses[network] = address
                return [{"network": network, "address": address, "amount": "1"}]

            return fetch

        with (
            patch.dict(
                os.environ,
                {
                    "PORTFOLIO_ADDRESS_MAP": json.dumps(
                        {
                            "identity": {
                                "stellar": "GACCOUNT",
                                "ethereum": "0x" + "1" * 40,
                            }
                        }
                    )
                },
            ),
            patch.object(
                portfolio_balance_sync,
                "_network_configs",
                return_value=[
                    ("stellar", await provider("stellar")),
                    ("ethereum", await provider("ethereum")),
                ],
            ),
            patch.object(portfolio_balance_sync.redis_cache, "set", AsyncMock()),
        ):
            snapshot = await portfolio_balance_sync.refresh_portfolio_balances("identity")

        self.assertEqual(observed_addresses["stellar"], "GACCOUNT")
        self.assertEqual(observed_addresses["ethereum"], "0x" + "1" * 40)
        self.assertEqual(len(snapshot["balances"]), 2)


class SandwichDetectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_correlates_front_victim_and_reverse_back_run(self) -> None:
        detector = SandwichAttackDetector()
        attacker = "GATTACKER"
        pool = "CPOOL"
        await detector.observe(
            {
                "phase": "front_run",
                "tx_hash": "front",
                "pool_address": pool,
                "attacker_address": attacker,
                "side": "buy",
            }
        )
        await detector.observe(
            {
                "phase": "victim",
                "tx_hash": "victim",
                "pool_address": pool,
                "user_address": "GUSER",
                "side": "buy",
                "expected_output": 100,
                "actual_output": 95,
                "slippage_tolerance_percent": 1,
            }
        )

        alert = await detector.observe(
            {
                "phase": "back_run",
                "tx_hash": "back",
                "pool_address": pool,
                "attacker_address": attacker,
                "side": "sell",
            }
        )

        self.assertIsNotNone(alert)
        self.assertEqual(alert["target_tx_hash"], "victim")
        self.assertEqual(alert["delta_s_percent"], 5)

    async def test_victim_uses_nearest_matching_front_run(self) -> None:
        detector = SandwichAttackDetector()
        for attacker, tx_hash in (("GOLDER", "front-old"), ("GNEWER", "front-new")):
            await detector.observe(
                {
                    "phase": "front_run",
                    "tx_hash": tx_hash,
                    "pool_address": "CPOOL",
                    "attacker_address": attacker,
                    "side": "buy",
                }
            )
        await detector.observe(
            {
                "phase": "victim",
                "tx_hash": "victim",
                "pool_address": "CPOOL",
                "side": "buy",
                "expected_output": 100,
                "actual_output": 95,
                "slippage_tolerance_percent": 1,
            }
        )

        old_attacker_back_run = await detector.observe(
            {
                "phase": "back_run",
                "tx_hash": "back-old",
                "pool_address": "CPOOL",
                "attacker_address": "GOLDER",
                "side": "sell",
            }
        )
        new_attacker_back_run = await detector.observe(
            {
                "phase": "back_run",
                "tx_hash": "back-new",
                "pool_address": "CPOOL",
                "attacker_address": "GNEWER",
                "side": "sell",
            }
        )

        self.assertIsNone(old_attacker_back_run)
        self.assertEqual(new_attacker_back_run["front_run_tx_hash"], "front-new")


if __name__ == "__main__":
    unittest.main()
