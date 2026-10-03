"""Database and async pipeline integration for Fiat Settlement Latency Monitoring.

Coordinates reading historical settlements, evaluating SLA limits (T_settlement > 4h),
updating underperforming routes in "PaymentRoute", re-routing pending remittances
in "RemittanceTransaction", and publishing notifications.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Any, Awaitable, Callable, Dict, List, Optional

try:
    import asyncpg
except ImportError:
    asyncpg = None  # type: ignore

try:
    import redis.asyncio as aioredis
except ImportError:
    aioredis = None  # type: ignore

try:
    import structlog
    log = structlog.get_logger(__name__)
except ImportError:
    log = logging.getLogger(__name__)  # type: ignore

from src.analytics.fiat_settlement import (
    Corridor,
    DEFAULT_SLA_THRESHOLD_SECONDS,
    FiatSettlementLatencyMonitor,
    RerouteBatchReport,
    SLABreachAuditRecord,
    AnchorHealthStatus,
)


class DatabaseSettlementLatencyWorker:
    """Async worker that synchronizes with PostgreSQL database, evaluates anchor SLA,

    and performs automated failover re-routing.
    """

    def __init__(
        self,
        database_url: Optional[str] = None,
        redis_url: Optional[str] = None,
        sla_threshold_seconds: float = DEFAULT_SLA_THRESHOLD_SECONDS,
        min_samples: int = 1,
        pool_factory: Optional[Callable[..., Awaitable[Any]]] = None,
        redis_factory: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.database_url = database_url or os.getenv("DATABASE_URL") or os.getenv("DB_URL")
        self.redis_url = redis_url or os.getenv("REDIS_URL", "redis://localhost:6379")
        if pool_factory is not None:
            self.pool_factory = pool_factory
        elif asyncpg is not None:
            self.pool_factory = asyncpg.create_pool
        else:
            self.pool_factory = None

        if redis_factory is not None:
            self.redis_factory = redis_factory
        elif aioredis is not None:
            self.redis_factory = aioredis.from_url
        else:
            self.redis_factory = None
        self.monitor = FiatSettlementLatencyMonitor(
            sla_threshold_seconds=sla_threshold_seconds,
            min_samples_for_deactivation=min_samples,
        )

    async def run_evaluation_cycle(
        self,
        lookback_hours: int = 24,
    ) -> Dict[str, Any]:
        """Runs a complete evaluation cycle:

        1. Fetches settled and pending transactions from DB for the last `lookback_hours`.
        2. Populates monitor state and route configurations.
        3. Evaluates SLA breaches (T_settlement > 4h).
        4. Persists deactivated routes to "PaymentRoute".
        5. Persists re-routed transactions to "RemittanceTransaction".
        6. Emits notifications to Redis.
        """
        if not self.database_url:
            raise RuntimeError("DATABASE_URL or DB_URL must be configured")

        pool = await self.pool_factory(self.database_url, min_size=1, max_size=5)
        redis = self.redis_factory(self.redis_url, decode_responses=True)
        try:
            async with pool.acquire() as connection:
                # 1. Load active routes from PaymentRoute to know priorities and backup options
                await self._load_routes_from_db(connection)

                # 2. Ingest transaction records from RemittanceTransaction
                await self._load_transactions_from_db(connection, lookback_hours)

                # 3. Evaluate SLA breaches and trigger monitor-level re-routing
                eval_results = self.monitor.evaluate_all_anchors()

                # 4. If any anchors violated SLA, persist deactivations and re-routes
                if eval_results["violations_detected"] > 0:
                    for audit in self.monitor.get_audit_records():
                        await self._persist_deactivation_to_db(connection, audit)
                        if audit.reroute_report and audit.reroute_report.rerouted_count > 0:
                            await self._persist_reroutes_to_db(connection, audit.reroute_report)
                            await self._publish_reroute_events(redis, audit.reroute_report)

                return eval_results
        finally:
            await pool.close()
            await redis.close()

    async def _load_routes_from_db(self, connection: Any) -> None:
        """Loads available payment routes to register corridor partners and priorities."""
        try:
            rows = await connection.fetch(
                '''
                SELECT id, "senderCurrency", "receiverCurrency", provider, rate, fee, priority, status, "targetRail"
                FROM "PaymentRoute"
                '''
            )
            for row in rows:
                sender = str(row["senderCurrency"]).upper()
                receiver = str(row["receiverCurrency"]).upper()
                corridor = f"{sender} -> {receiver}"
                provider = str(row["provider"])
                priority = int(row["priority"] or 0)
                fee = float(row["fee"] or 0.0)
                rate = float(row["rate"] or 1.0)
                target_rail = str(row["targetRail"] or "DEFAULT")
                status_str = str(row["status"] or "ACTIVE").upper()

                health_status = (
                    AnchorHealthStatus.ACTIVE
                    if status_str == "ACTIVE"
                    else AnchorHealthStatus.DEACTIVATED
                )

                self.monitor.register_anchor_corridor(
                    anchor_id=provider,
                    corridor=corridor,
                    priority=priority,
                    fee=fee,
                    rate=rate,
                    target_rail=target_rail,
                    initial_status=health_status,
                )
        except Exception as exc:
            log.warning("fiat_settlement.load_routes_failed", error=str(exc))

    async def _load_transactions_from_db(self, connection: Any, lookback_hours: int) -> None:
        """Loads completed and pending remittance transactions from the database."""
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
            rows = await connection.fetch(
                '''
                SELECT id, "senderCurrency", "receiverCurrency", provider, amount, status,
                       "createdAt" as dispatched_at, "updatedAt" as settled_at
                FROM "RemittanceTransaction"
                WHERE "createdAt" >= $1 AND provider IS NOT NULL
                ORDER BY "createdAt" ASC
                ''',
                cutoff,
            )

            for row in rows:
                tx_id = str(row["id"])
                sender = str(row["senderCurrency"]).upper()
                receiver = str(row["receiverCurrency"]).upper()
                corridor = Corridor.from_pair(sender, receiver)
                provider = str(row["provider"])
                amount = float(row["amount"] or 0.0)
                status = str(row["status"]).upper()
                dispatched_at = row["dispatched_at"]
                settled_at = row["settled_at"]

                # Register in monitor
                rec = self.monitor.record_dispatch(
                    transaction_id=tx_id,
                    corridor=corridor,
                    anchor_id=provider,
                    amount=amount,
                    dispatched_at=dispatched_at,
                )

                if status in {"COMPLETED", "SETTLED", "SUCCESS", "DELIVERED"}:
                    self.monitor.record_settlement(tx_id, settled_at=settled_at, status=status)
        except Exception as exc:
            log.warning("fiat_settlement.load_transactions_failed", error=str(exc))

    async def _persist_deactivation_to_db(
        self,
        connection: Any,
        audit: SLABreachAuditRecord,
    ) -> None:
        """Updates the PaymentRoute status to PAUSED for the underperforming anchor."""
        try:
            corridor = Corridor.parse(audit.corridor)
            await connection.execute(
                '''
                UPDATE "PaymentRoute"
                SET status = 'PAUSED', "updatedAt" = CURRENT_TIMESTAMP
                WHERE provider = $1 AND "senderCurrency" = $2 AND "receiverCurrency" = $3
                ''',
                audit.anchor_id,
                corridor.sender_currency,
                corridor.receiver_currency,
            )
            log.info(
                "fiat_settlement.route_paused_in_db",
                provider=audit.anchor_id,
                corridor=audit.corridor,
                reason=audit.reason,
            )
        except Exception as exc:
            log.error("fiat_settlement.persist_deactivation_error", error=str(exc))

    async def _persist_reroutes_to_db(
        self,
        connection: Any,
        report: RerouteBatchReport,
    ) -> None:
        """Updates pending RemittanceTransaction records with the backup provider."""
        if not report.backup_partner_assigned:
            return

        for result in report.results:
            if not result.success or not result.new_anchor_id:
                continue

            try:
                await connection.execute(
                    '''
                    UPDATE "RemittanceTransaction"
                    SET provider = $1,
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE id = $2
                    ''',
                    result.new_anchor_id,
                    result.transaction_id,
                )
                log.info(
                    "fiat_settlement.tx_rerouted_in_db",
                    transaction_id=result.transaction_id,
                    from_anchor=result.previous_anchor_id,
                    to_anchor=result.new_anchor_id,
                )
            except Exception as exc:
                log.error(
                    "fiat_settlement.persist_reroute_error",
                    transaction_id=result.transaction_id,
                    error=str(exc),
                )

    async def _publish_reroute_events(
        self,
        redis: Any,
        report: RerouteBatchReport,
    ) -> None:
        """Publishes WebSocket updates for all re-routed remittances."""
        for result in report.results:
            if not result.success:
                continue
            try:
                channel = f"remittance_{result.transaction_id}"
                payload = {
                    "transaction_id": result.transaction_id,
                    "event": "PROVIDER_FAILOVER_REROUTED",
                    "previous_provider": result.previous_anchor_id,
                    "new_provider": result.new_anchor_id,
                    "corridor": result.corridor,
                    "timestamp": result.rerouted_at.isoformat(),
                }
                await redis.publish(channel, json.dumps(payload))
            except Exception as exc:
                log.warning("fiat_settlement.redis_publish_error", error=str(exc))
