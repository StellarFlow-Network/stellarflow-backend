import Tracing from '../lib/tracing';

/**
 * Graceful shutdown handler for tracing system
 */
export async function shutdownTracing(): Promise<void> {
  try {
    console.log('[Tracing] Shutting down OpenTelemetry tracing system...');
    
    const tracing = Tracing.getInstance();
    await tracing.shutdown();
    
    console.log('[Tracing] Tracing system shutdown complete');
  } catch (error) {
    console.error('[Tracing] Error during tracing shutdown:', error);
  }
}

/**
 * Register shutdown handlers for tracing
 */
export function registerTracingShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    console.log(`[Tracing] Received ${signal}, shutting down tracing...`);
    await shutdownTracing();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGUSR2', () => shutdown('SIGUSR2')); // For nodemon restarts
}
