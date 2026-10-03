#!/usr/bin/env python3
"""
Automated PostgreSQL Database Index De-fragmentation Worker
===========================================================
Identifies database indexes with fragmentation levels > 30% and executes
REINDEX INDEX CONCURRENTLY during low-traffic maintenance windows.
Logs reindexing results and disk space savings.
"""

import os
import sys
import logging
from datetime import datetime, time as datetime_time
from typing import Dict, List, Any
import psycopg2
from psycopg2 import Error
from psycopg2.extras import DictCursor

LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO').upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('database_reindex.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

class DatabaseReindexWorker:
    def __init__(self, database_url: str):
        self.database_url = database_url
        self.connection = None

    def connect(self) -> bool:
        try:
            self.connection = psycopg2.connect(self.database_url)
            self.connection.autocommit = True
            logger.info("Successfully connected to database for reindex worker")
            return True
        except Error as e:
            logger.error(f"Failed to connect to database: {e}")
            return False

    def disconnect(self):
        if self.connection:
            self.connection.close()
            logger.info("Database connection closed")

    def ensure_pgstattuple(self) -> bool:
        try:
            with self.connection.cursor() as cursor:
                cursor.execute("CREATE EXTENSION IF NOT EXISTS pgstattuple;")
            return True
        except Error as e:
            logger.error(f"Failed to create pgstattuple extension: {e}")
            return False

    def get_index_size(self, index_name: str) -> int:
        try:
            with self.connection.cursor() as cursor:
                cursor.execute("SELECT pg_relation_size(%s);", (index_name,))
                row = cursor.fetchone()
                return row[0] if row and row[0] is not None else 0
        except Error as e:
            logger.debug(f"Could not fetch size for index {index_name}: {e}")
            return 0

    def find_fragmented_indexes(self, threshold_pct: float = 30.0) -> List[str]:
        # Using pgstattuple to find index fragmentation (leaf density < 100 - threshold)
        fragmented = []
        try:
            with self.connection.cursor(cursor_factory=DictCursor) as cursor:
                # Get all btree indexes (pgstatindex only works on btree)
                cursor.execute("""
                    SELECT n.nspname AS schemaname, c.relname AS indexname, c.oid AS indexrelid
                    FROM pg_class c
                    JOIN pg_index i ON c.oid = i.indexrelid
                    JOIN pg_namespace n ON c.relnamespace = n.oid
                    JOIN pg_am a ON c.relam = a.oid
                    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                      AND a.amname = 'btree'
                      AND c.relkind = 'i';
                """)
                indexes = cursor.fetchall()

                for idx in indexes:
                    idx_full_name = f'"{idx["schemaname"]}"."{idx["indexname"]}"'
                    try:
                        cursor.execute(f"SELECT avg_leaf_density FROM pgstatindex('{idx_full_name}')")
                        res = cursor.fetchone()
                        if res:
                            avg_leaf_density = res[0]
                            fragmentation = 100.0 - avg_leaf_density
                            if fragmentation > threshold_pct:
                                logger.info(f"Found fragmented index {idx_full_name}: {fragmentation:.2f}% fragmented")
                                fragmented.append(idx_full_name)
                    except Error as e:
                        logger.debug(f"Could not analyze index {idx_full_name}: {e}")

        except Error as e:
            logger.error(f"Failed to find fragmented indexes: {e}")

        return fragmented

    def is_maintenance_window(self) -> bool:
        # Assuming maintenance window is 01:00 to 04:00 server time
        now = datetime.now().time()
        start = datetime_time(1, 0)
        end = datetime_time(4, 0)
        return start <= now <= end

    def run_reindex_concurrently(self, index_name: str) -> Dict[str, Any]:
        initial_size = self.get_index_size(index_name)
        logger.info(f"Starting REINDEX INDEX CONCURRENTLY on '{index_name}' (Initial size: {initial_size} bytes)...")

        start_time = datetime.now()
        success = True
        error_msg = None

        try:
            with self.connection.cursor() as cursor:
                cursor.execute(f"REINDEX INDEX CONCURRENTLY {index_name};")
        except Error as e:
            success = False
            error_msg = str(e)
            logger.error(f"Error reindexing {index_name}: {e}")

        final_size = self.get_index_size(index_name) if success else initial_size
        reclaimed_bytes = max(0, initial_size - final_size)
        duration = (datetime.now() - start_time).total_seconds()

        if success:
            logger.info(
                f"Completed REINDEX on '{index_name}': "
                f"duration={duration:.2f}s, initial_size={initial_size}, "
                f"final_size={final_size}, reclaimed_bytes={reclaimed_bytes}"
            )

        return {
            "index_name": index_name,
            "success": success,
            "initial_size": initial_size,
            "final_size": final_size,
            "reclaimed_bytes": reclaimed_bytes,
            "duration_seconds": duration,
            "error": error_msg
        }

    def execute_defrag_cycle(self, enforce_window: bool = True) -> Dict[str, Any]:
        if enforce_window and not self.is_maintenance_window():
            logger.info("Not in maintenance window. Skipping de-fragmentation.")
            return {"status": "skipped", "reason": "outside maintenance window"}

        if not self.connection and not self.connect():
            return {"status": "error", "reason": "database connection unavailable"}

        if not self.ensure_pgstattuple():
            return {"status": "error", "reason": "failed to ensure pgstattuple extension"}

        logger.info("Scanning for fragmented indexes (> 30% fragmentation)...")
        fragmented_indexes = self.find_fragmented_indexes(threshold_pct=30.0)

        results = []
        total_reclaimed = 0

        for idx_name in fragmented_indexes:
            res = self.run_reindex_concurrently(idx_name)
            results.append(res)
            if res.get("success"):
                total_reclaimed += res.get("reclaimed_bytes", 0)

        logger.info(f"De-fragmentation cycle complete. Total disk space reclaimed: {total_reclaimed} bytes.")

        return {
            "status": "completed",
            "timestamp": datetime.now().isoformat(),
            "total_reclaimed_bytes": total_reclaimed,
            "reindex_results": results
        }

if __name__ == "__main__":
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        logger.error("DATABASE_URL environment variable is required.")
        sys.exit(1)

    # Optional flag to ignore maintenance window for testing/manual runs
    enforce_window = os.getenv("ENFORCE_MAINTENANCE_WINDOW", "true").lower() == "true"

    worker = DatabaseReindexWorker(db_url)
    try:
        outcome = worker.execute_defrag_cycle(enforce_window=enforce_window)
        print(outcome)
    finally:
        worker.disconnect()
