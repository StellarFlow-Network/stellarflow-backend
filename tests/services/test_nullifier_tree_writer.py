"""Integration-test outline.

Use testcontainers or the repository's integration fixtures to verify:

1. Two workers writing the same tree cannot enter the critical section together.
2. A failed callback rolls back the DB transaction.
3. The Redis lock is released after success and failure.
4. A lock timeout is routed to the retry queue.
5. Duplicate nullifiers remain rejected by the database unique constraint.
6. The persisted Merkle root corresponds to the committed tree state.
"""
