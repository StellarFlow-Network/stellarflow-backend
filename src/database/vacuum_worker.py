#!/usr/bin/env python3
"""
Automated Database Bloat Cleanup & Vacuum Worker
================================================
Runs scheduled VACUUM ANALYZE operations on core event and metrics tables
during off-peak hours, logs table size reductions and reclaimed disk space,
and inspects system statistics to alert if the autovacuum daemon is falling
behind write rates.

Environment Variables Required:
  - DATABASE_URL: PostgreSQL connection string
  - LOG_LEVEL: (optional) Logging level - DEBUG, INFO, WARNING, ERROR (default: INFO)
"""

import os
import sys
import logging
import time
from datetime import datetime
from typing import Dict, List, Any, Optional
import psycopg2
from psycopg2 import Error

# Configure logging
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO').upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('database_vacuum.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)


class DatabaseVacuumWorker:
    """Manages scheduled VACUUM ANALYZE, bloat tracking, and autovacuum lag alerts."""

    CORE_TABLES = [
        "ledger_events",
        "PriceHistory",
        "error_logs",
        "multisig_proposals"
    ]

    def __init__(self, database_url: str):
        self.database_url = database_url
        self.connection = None

    def connect(self) -> bool:
        """Establish database connection."""
        try:
            self.connection = psycopg2.connect(self.database_url)
            # VACUUM cannot be executed inside a transaction block, set autocommit
            self.connection.autocommit = True
            logger.info("Successfully connected to database for vacuum worker")
            return True
        except Error as e:
            logger.error(f"Failed to connect to database: {e}")
            return False

    def disconnect(self):
        """Close database connection."""
        if self.connection:
            self.connection.close()
            logger.info("Database connection closed")

    def get_table_size(self, table_name: str) -> int:
        """Return the disk size of a table in bytes."""
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_total_relation_size(%s);",
                    (table_name,)
                )
                row = cursor.fetchone()
                return row[0] if row and row[0] is not None else 0
        except Error as e:
            logger.debug(f"Could not fetch size for table {table_name}: {e}")
            return 0

    def run_vacuum_analyze(self, table_name: str) -> Dict[str, Any]:
        """
        Run VACUUM ANALYZE on a given table and measure size reduction.
        
        Returns:
            Dict with table name, initial size, final size, and bytes reclaimed.
        """
        initial_size = self.get_table_size(table_name)
        logger.info(f"Starting VACUUM ANALYZE on table '{table_name}' (Initial size: {initial_size} bytes)...")

        start_time = datetime.now()
        try:
            with self.connection.cursor() as cursor:
                # Quote identifier safely
                cursor.execute(f'VACUUM ANALYZE "{table_name}";')
            success = True
            error_msg = None
        except Error as e:
            success = False
            error_msg = str(e)
            logger.error(f"Error running VACUUM ANALYZE on {table_name}: {e}")

        final_size = self.get_table_size(table_name) if success else initial_size
        reclaimed_bytes = max(0, initial_size - final_size)
        duration = (datetime.now() - start_time).total_seconds()

        logger.info(
            f"Completed VACUUM ANALYZE on '{table_name}': "
            f"duration={duration:.2f}s, initial_size={initial_size}, "
            f"final_size={final_size}, reclaimed_bytes={reclaimed_bytes}"
        )

        return {
            "table_name": table_name,
            "success": success,
            "initial_size": initial_size,
            "final_size": final_size,
            "reclaimed_bytes": reclaimed_bytes,
            "duration_seconds": duration,
            "error": error_msg
        }

    def check_autovacuum_lag(self) -> List[Dict[str, Any]]:
        """
        Inspect pg_stat_user_tables to check if tables have accumulated high dead tuples
        or if autovacuum daemon is falling behind write rates.
        
        Alerts team if dead tuple ratio or absolute dead tuple count exceeds thresholds.
        """
        alerts = []
        query = """
            SELECT
                schemaname,
                relname,
                n_dead_tup,
                n_live_tup,
                last_vacuum,
                last_autovacuum
            FROM pg_stat_user_tables
            WHERE n_dead_tup > 10000
        """

        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query)
                rows = cursor.fetchall()
                for row in rows:
                    schema, relname, dead_tup, live_tup, last_vacuum, last_autovacuum = row
                    total_tup = (live_tup or 0) + (dead_tup or 0)
                    dead_ratio = (dead_tup / total_tup) if total_tup > 0 else 0

                    logger.warning(
                        f"ALERT: Table {schema}.{relname} has high dead tuples: "
                        f"n_dead_tup={dead_tup}, dead_ratio={dead_ratio:.2%}, "
                        f"last_autovacuum={last_autovacuum}, last_vacuum={last_vacuum}"
                    )
                    alerts.append({
                        "table": f"{schema}.{relname}",
                        "n_dead_tup": dead_tup,
                        "dead_ratio": dead_ratio,
                        "last_autovacuum": str(last_autovacuum),
                        "last_vacuum": str(last_vacuum)
                    })
        except Error as e:
            logger.error(f"Failed to check autovacuum lag statistics: {e}")

        return alerts

    def execute_maintenance_cycle(self) -> Dict[str, Any]:
        """Run full vacuum maintenance and lag check across core tables."""
        if not self.connection and not self.connect():
            return {"success": False, "error": "Database connection unavailable"}

        results = []
        for table in self.CORE_TABLES:
            res = self.run_vacuum_analyze(table)
            results.append(res)

        lag_alerts = self.check_autovacuum_lag()

        return {
            "timestamp": datetime.now().isoformat(),
            "vacuum_results": results,
            "autovacuum_alerts": lag_alerts
        }


if __name__ == "__main__":
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        logger.error("DATABASE_URL environment variable is required.")
        sys.exit(1)

    worker = DatabaseVacuumWorker(db_url)
    try:
        outcome = worker.execute_maintenance_cycle()
        print(outcome)
    finally:
        worker.disconnect()
