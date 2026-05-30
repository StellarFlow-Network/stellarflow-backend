# High-Precision Nanosecond Event Logging

## Overview

This document describes the nanosecond-precision event logging system implemented for StellarFlow to support high-frequency data pipelines requiring quantum-level timing accuracy.

## Technical Implementation

### Architecture

The high-precision logging system consists of three main components:

1. **Winston Logger Enhancement** (`src/utils/winstonLogger.ts`)
   - Enhanced with `process.hrtime.bigint()` for nanosecond-level timestamps
   - Outputs nanosecond precision to all log transports
   - Maintains backward compatibility with existing logging

2. **High-Precision Event Logger** (`src/services/highPrecisionEventLogger.ts`)
   - Provides a dedicated service for nanosecond-level event tracking
   - Uses batching for efficient database writes
   - Supports auto-flush with configurable intervals
   - Graceful shutdown handlers for signal handling

3. **Database Schema** (`prisma/schema.prisma`)
   - New `EventLog` model with BIGINT support for nanosecond timestamps
   - Optimized indexes for high-frequency querying
   - Metadata support for contextual information

### Nanosecond Precision Details

- **Method**: `process.hrtime.bigint()` returns nanoseconds as a BigInt
- **Reference Point**: Each HighPrecisionEventLogger instance captures a reference time
- **Relative Timestamps**: Events logged within the same session are relative to the reference
- **Absolute Timestamps**: Static method `getAbsoluteNanoseconds()` provides absolute nanosecond precision

## Usage

### Using the High-Precision Event Logger

```typescript
import { highPrecisionEventLogger } from "./utils/logger";

// Log events with nanosecond precision
await highPrecisionEventLogger.info("PriceService", "Price update completed", {
  currency: "NGN",
  rate: 412.5,
});

// Log warnings
await highPrecisionEventLogger.warn(
  "CacheService",
  "Cache hit rate below threshold",
  { hitRate: 0.65, threshold: 0.75 },
);

// Log errors
await highPrecisionEventLogger.error("APIGateway", "Request timeout", {
  endpoint: "/prices",
  timeout: 5000,
});

// Get current timestamp
const now = highPrecisionEventLogger.getRelativeNanoseconds();
console.log(`Current time in nanoseconds: ${now}`);
```

### Using Winston Logger with Nanosecond Precision

```typescript
import { logger } from "./utils/logger";

// Winston logger now includes nanosecond timestamps
logger.info("Server started", { port: 3000 });
logger.warn("Cache invalidated", { cacheKey: "prices:NGN" });
logger.error("Database connection failed", { error: err.message });
```

### Database Query Examples

```typescript
import prisma from "./lib/prisma";

// Query events by timestamp range (nanoseconds)
const events = await prisma.eventLog.findMany({
  where: {
    timestampNs: {
      gte: startTimeNs,
      lte: endTimeNs,
    },
  },
  orderBy: { timestampNs: "asc" },
});

// Find high-latency events
const slowEvents = await prisma.eventLog.findMany({
  where: {
    source: "APIGateway",
    metadata: {
      search: '"latencyNs":"[5-9][0-9]{6,}"', // > 5 milliseconds in nanoseconds
    },
  },
});

// Aggregate events by type
const eventStats = await prisma.eventLog.groupBy({
  by: ["eventType", "level"],
  _count: {
    id: true,
  },
  orderBy: [{ eventType: "asc" }, { _count: { id: "desc" } }],
});
```

## Configuration

### High-Precision Event Logger

The logger can be configured during instantiation:

```typescript
const logger = new HighPrecisionEventLogger(
  100, // batchSize: Flush when 100 events are queued
  1000, // flushIntervalMs: Auto-flush every 1000ms
);
```

### Default Configuration

- **Batch Size**: 100 events
- **Flush Interval**: 1000ms (1 second)
- **Retry on Failure**: Yes (re-queues failed events)

## Performance Characteristics

- **Overhead**: ~50-100 nanoseconds per log call for timestamp capture
- **Database Writes**: Batched for efficiency (default 100 events per batch)
- **Queue Management**: In-memory queue with automatic flushing
- **Graceful Degradation**: Logging failures don't break application flow

## Best Practices

1. **Use Batching**: Don't flush after every event; let batching work
2. **Minimize Metadata**: Keep metadata objects small for faster serialization
3. **Cleanup**: Ensure `shutdown()` is called during application shutdown
4. **Error Handling**: Always wrap high-frequency logging in try-catch blocks
5. **Index Strategy**: Use composite indexes for time-range + dimension queries

## Migration Guide

### From Millisecond to Nanosecond Precision

If you have existing code using `Date.now()` for timing:

**Before:**

```typescript
const startMs = Date.now();
// ... some operation ...
const durationMs = Date.now() - startMs;
```

**After:**

```typescript
const startNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();
// ... some operation ...
const durationNs = HighPrecisionEventLogger.getAbsoluteNanoseconds() - startNs;
const durationMs = Number(durationNs) / 1_000_000;
```

## Schema Changes

### New EventLog Table

```
┌─────────────────────────────────────────┐
│ EventLog                                │
├────────────┬───────────┬─────────────────┤
│ id         │ Int       │ PK, autoincr    │
│ eventType  │ VarChar   │ Indexed         │
│ source     │ VarChar   │ Indexed         │
│ level      │ VarChar   │ Indexed         │
│ message    │ Text      │                 │
│ metadata   │ Text      │ JSON            │
│ timestampNs│ BigInt    │ Indexed         │
│ createdAt  │ DateTime  │ Indexed         │
└────────────┴───────────┴─────────────────┘
```

## Troubleshooting

### High Memory Usage

If the event log queue is growing too large:

- Increase `flushIntervalMs` (check for DB performance issues)
- Reduce `batchSize` for more frequent writes
- Review logging volume in high-frequency services

### Missing Events

If events aren't appearing in the database:

- Check that `flush()` or `shutdown()` is being called
- Verify database connectivity during flush
- Check application logs for flush errors

### Performance Impact

If logging is affecting application performance:

- Reduce logging frequency in high-throughput services
- Increase batch size to reduce DB writes
- Use background processing for non-critical events

## References

- [Node.js process.hrtime.bigint() Documentation](https://nodejs.org/api/process.html#process_process_hrtime_bigint)
- [Prisma BigInt Support](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#bigint)
- [High-Resolution Time](https://en.wikipedia.org/wiki/High-resolution_time)
