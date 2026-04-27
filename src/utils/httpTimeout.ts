export const OUTGOING_HTTP_TIMEOUT_MS = 5000;

export function createTimeoutSignal(timeoutMs = OUTGOING_HTTP_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
