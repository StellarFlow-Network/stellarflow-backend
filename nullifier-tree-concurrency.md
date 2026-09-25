# Nullifier Tree Concurrency

## Lock key

Use one stable key per logical tree:

`stellarflow:nullifier-tree:spent-nullifiers`

If the system supports multiple networks, contracts, or tree partitions, include those
identifiers in the key. All workers that mutate the same logical tree must use the
same key.

## Lock requirements

- Acquire with Redis `SET key token NX PX lease_ms`.
- Use a cryptographically random token per owner.
- Release with a Lua script that deletes the key only when its value matches the token.
- Keep the lease longer than the normal critical-section duration.
- Add lock renewal only if the operation can exceed the lease; otherwise fail safely
  and retry instead of allowing two owners to write concurrently.
- Do not use `DEL key` without checking ownership.

## Transaction boundary

The callback supplied to `NullifierTreeWriter.write_atomically()` must include:

1. Duplicate/nullifier existence check.
2. Nullifier insertion.
3. Leaf index assignment.
4. Merkle-root/frontier update.
5. Root checkpoint persistence.

The callback must use the provided SQLAlchemy session and must not commit separately.
The transaction should commit only after all related writes succeed.

## Retry behavior

Lock contention should be retried with bounded exponential backoff and jitter.
After the maximum retry count, route the message to the existing dead-letter queue
with the tree identifier, nullifier/event identifier, retry count, and failure reason.

## Verification checklist

- [ ] Two-worker contention test.
- [ ] Lock owner cannot release another owner's lock.
- [ ] Timeout causes retry.
- [ ] Transaction rollback leaves no partial nullifier/root state.
- [ ] Duplicate nullifier is idempotent or rejected according to the domain contract.
- [ ] Root and leaf count remain consistent after concurrent ingestion.
- [ ] Metrics/logging expose lock wait, timeout, retry, and failure counts.
