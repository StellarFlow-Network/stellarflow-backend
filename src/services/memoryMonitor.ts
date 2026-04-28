/**
 * Memory monitor — polls process.memoryUsage() and sends SIGTERM to the
 * current process when heap usage exceeds 85% of the container memory limit.
 *
 * Container limit is read from MEMORY_LIMIT_MB env var (default: 512 MB).
 * Poll interval is read from MEMORY_POLL_INTERVAL_MS env var (default: 30 000 ms).
 */

const THRESHOLD = 0.85;
const DEFAULT_LIMIT_MB = 512;
const DEFAULT_POLL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;

export function startMemoryMonitor(): void {
  if (timer) return;

  const limitMb =
    parseInt(process.env.MEMORY_LIMIT_MB ?? "", 10) || DEFAULT_LIMIT_MB;
  const limitBytes = limitMb * 1024 * 1024;
  const pollMs =
    parseInt(process.env.MEMORY_POLL_INTERVAL_MS ?? "", 10) || DEFAULT_POLL_MS;

  timer = setInterval(() => {
    const { heapUsed } = process.memoryUsage();
    const ratio = heapUsed / limitBytes;

    if (ratio >= THRESHOLD) {
      console.error(
        `[MemoryMonitor] Heap usage ${(ratio * 100).toFixed(1)}% exceeds ${THRESHOLD * 100}% of ${limitMb} MB limit. Triggering graceful restart.`,
      );
      process.kill(process.pid, "SIGTERM");
    }
  }, pollMs);

  // Don't keep the process alive solely for this timer
  timer.unref();

  console.info(
    `[MemoryMonitor] Started — limit: ${limitMb} MB, threshold: ${THRESHOLD * 100}%, poll: ${pollMs} ms`,
  );
}

export function stopMemoryMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
