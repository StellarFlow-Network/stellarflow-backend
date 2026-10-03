/**
 * Active WebSocket session connection registry (Issue #1054).
 *
 * Tracks which authenticated user sessions (JWT `sid`) currently own a live
 * WebSocket connection in this process. The stale session purge worker consults
 * this registry so abandoned sessions are removed while sessions with an active
 * connection are retained.
 *
 * Connections are reference counted: a session stays "active" until every
 * socket that claimed it has disconnected.
 */

const connectionCounts = new Map<string, number>();

/**
 * Mark a session as owning a live WebSocket connection.
 */
export function registerSessionConnection(sid: string): void {
  connectionCounts.set(sid, (connectionCounts.get(sid) ?? 0) + 1);
}

/**
 * Release one WebSocket connection claim for a session.
 */
export function unregisterSessionConnection(sid: string): void {
  const current = connectionCounts.get(sid);
  if (current === undefined) return;

  if (current <= 1) {
    connectionCounts.delete(sid);
    return;
  }

  connectionCounts.set(sid, current - 1);
}

/**
 * Whether the session currently owns at least one active WebSocket connection.
 */
export function hasActiveSessionConnection(sid: string): boolean {
  return (connectionCounts.get(sid) ?? 0) > 0;
}

/**
 * Claim the session identified by an authenticated WebSocket handshake token
 * and mark it as having an active connection.
 *
 * The session token verifier is loaded lazily so this registry stays free of
 * heavyweight dependencies for consumers that only query connection state.
 *
 * @returns the claimed session id, or `null` when the token is absent or invalid.
 */
export async function claimSessionConnectionForToken(
  token: string,
): Promise<string | null> {
  try {
    const { verifyToken } = await import("../utils/jwt");
    const payload = verifyToken(token);
    const sid = payload?.sid ?? payload?.sessionId ?? null;
    if (!sid) return null;

    registerSessionConnection(sid);
    return sid;
  } catch {
    return null;
  }
}

/**
 * Number of distinct sessions with an active WebSocket connection.
 */
export function getActiveSessionConnectionCount(): number {
  return connectionCounts.size;
}

/**
 * Drop every tracked connection (used by tests and shutdown).
 */
export function resetSessionConnectionRegistry(): void {
  connectionCounts.clear();
}
