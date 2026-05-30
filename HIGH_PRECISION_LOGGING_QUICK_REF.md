# High-Precision Logging - Quick Reference

## Installation/Setup

### 1. Apply Database Migration

```bash
npm run db:migrate
```

### 2. Import in Your Code

```typescript
import {
  highPrecisionEventLogger,
  logger,
  HighPrecisionEventLogger,
} from "./utils/logger";
```

## Common Usage Patterns

### Basic Logging

```typescript
// Winston logger (existing - now with nanosecond precision)
logger.info("Message", { key: "value" });

// High-precision event logger
await highPrecisionEventLogger.info("Service", "Message", { key: "value" });
```

### Performance Tracking

```typescript
const startNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();
// ... do work ...
const endNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();
const durationNs = endNs - startNs;
const durationMs = Number(durationNs) / 1_000_000;

await highPrecisionEventLogger.info("Service", "Operation completed", {
  durationNs: durationNs.toString(),
  durationMs,
});
```

### Latency Threshold Warnings

```typescript
if (durationNs > BigInt(50_000_000)) {
  // 50ms
  await highPrecisionEventLogger.warn("Service", "High latency detected", {
    durationMs: Number(durationNs) / 1_000_000,
  });
}
```

### Error Logging with Context

```typescript
try {
  // some operation
} catch (error) {
  await highPrecisionEventLogger.error("Service", "Operation failed", {
    error: error.message,
    stack: error.stack,
  });
}
```

## Database Queries

### Find Slow Operations (>5ms)

```typescript
const slowOps = await prisma.eventLog.findMany({
  where: {
    source: "APIGateway",
    timestampNs: { gte: BigInt(5_000_000) },
  },
  orderBy: { timestampNs: "desc" },
  take: 100,
});
```

### Event Statistics by Type

```typescript
const stats = await prisma.eventLog.groupBy({
  by: ["eventType", "level"],
  _count: { id: true },
  orderBy: [{ eventType: "asc" }],
});
```

### Recent Events for Debugging

```typescript
const recent = await prisma.eventLog.findMany({
  where: {
    source: "MyService",
    createdAt: { gte: new Date(Date.now() - 60000) }, // Last minute
  },
  orderBy: { createdAt: "desc" },
  take: 50,
});
```

### Time Range Query

```typescript
const startTime = new Date(Date.now() - 3600000); // 1 hour ago
const endTime = new Date();

const events = await prisma.eventLog.findMany({
  where: {
    createdAt: { gte: startTime, lte: endTime },
    eventType: "API_CALL",
  },
  orderBy: { createdAt: "asc" },
});
```

## API Reference

### High-Precision Event Logger

```typescript
class HighPrecisionEventLogger {
  // Logging methods
  async debug(
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
  );
  async info(
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
  );
  async warn(
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
  );
  async error(
    source: string,
    message: string,
    metadata?: Record<string, unknown>,
  );

  // Utility methods
  async flush(): Promise<void>;
  async shutdown(): Promise<void>;
  getRelativeNanoseconds(): bigint;
  getQueueSize(): number;

  // Static methods
  static getAbsoluteNanoseconds(): bigint;
}

// Singleton instance
export const highPrecisionEventLogger: HighPrecisionEventLogger;
```

## Environment Configuration

### Default Settings

- **Batch Size**: 100 events per flush
- **Flush Interval**: 1000ms (1 second)
- **Auto-Shutdown**: On SIGINT/SIGTERM signals

### Custom Configuration

```typescript
import { HighPrecisionEventLogger } from "./services/highPrecisionEventLogger";

// Create custom instance
const customLogger = new HighPrecisionEventLogger(
  50, // Batch size: 50 events
  5000, // Flush interval: 5 seconds
);

// Use and shutdown
await customLogger.info("Service", "Message");
await customLogger.shutdown();
```

## Best Practices

1. **Use Batching**: Don't call `flush()` after every event
2. **Metadata Size**: Keep metadata objects small for performance
3. **Error Handling**: Wrap logging in try-catch to avoid breaking applications
4. **Shutdown**: Always call `shutdown()` or rely on auto-shutdown handlers
5. **Querying**: Use indexes effectively with WHERE and ORDER BY clauses
6. **Archival**: Archive old EventLog entries periodically to manage storage

## Troubleshooting

### High Memory Usage

- Reduce `batchSize` for more frequent flushes
- Increase `flushIntervalMs` to batch more events (if DB can handle it)
- Check for high-frequency logging in tight loops

### Missing Events

- Ensure `shutdown()` is called or app gracefully exits
- Check database connectivity during flush
- Monitor application error logs

### Slow Queries

- Use appropriate indexes (already created)
- Filter by `createdAt` for time-range queries
- Use `_count` for aggregations
- Consider archiving old data

## Migration from Date.now() to process.hrtime.bigint()

### Before

```typescript
const start = Date.now();
// work
const duration = Date.now() - start; // milliseconds
```

### After

```typescript
const start = HighPrecisionEventLogger.getAbsoluteNanoseconds();
// work
const duration = HighPrecisionEventLogger.getAbsoluteNanoseconds() - start;
const durationMs = Number(duration) / 1_000_000;
```

## Example Service Integration

```typescript
import {
  highPrecisionEventLogger,
  HighPrecisionEventLogger,
} from "../utils/logger";

export class MyService {
  async processData(data: unknown) {
    const startNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();

    try {
      await highPrecisionEventLogger.info("MyService", "Processing started");

      // Process data
      const result = await this.doWork(data);

      const endNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();
      const duration = endNs - startNs;

      await highPrecisionEventLogger.info("MyService", "Processing completed", {
        durationNs: duration.toString(),
        resultSize: JSON.stringify(result).length,
      });

      return result;
    } catch (error) {
      await highPrecisionEventLogger.error("MyService", "Processing failed", {
        error: error.message,
      });
      throw error;
    }
  }

  private async doWork(data: unknown): Promise<unknown> {
    // Implementation
    return data;
  }
}
```

## Resources

- Full Documentation: [HIGH_PRECISION_LOGGING.md](HIGH_PRECISION_LOGGING.md)
- Implementation Details: [NANOSECOND_LOGGING_IMPLEMENTATION.md](NANOSECOND_LOGGING_IMPLEMENTATION.md)
- Examples: [src/services/examples/highPrecisionLoggingExample.ts](src/services/examples/highPrecisionLoggingExample.ts)
- Node.js API: https://nodejs.org/api/process.html#process_process_hrtime_bigint
