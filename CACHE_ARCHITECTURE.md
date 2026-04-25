# StellarFlow Caching Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client Applications                             │
│                    (Dashboard, Mobile Apps, APIs)                        │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ HTTP/HTTPS
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Express API Server                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    Cache Middleware Layer                         │  │
│  │  • Intercepts GET requests                                        │  │
│  │  • Generates cache keys                                           │  │
│  │  • Sets X-Cache: HIT/MISS headers                                 │  │
│  │  • Automatic response caching                                     │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│                              │                                           │
│                              ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    Route Handlers                                 │  │
│  │  /market-rates  /history  /stats  /assets  /derived-assets       │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
└────────────────────────────────┼───────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Cache Service Layer                              │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │              L1 Cache (In-Memory LRU)                            │  │
│  │  ┌────────────────────────────────────────────────────────────┐ │  │
│  │  │  • Max Size: 100 entries                                   │ │  │
│  │  │  • TTL: 30 seconds                                         │ │  │
│  │  │  • Instant access (microseconds)                           │ │  │
│  │  │  • Automatic eviction (LRU policy)                         │ │  │
│  │  │  • Process-local memory                                    │ │  │
│  │  └────────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────┬───────────────────────────────────────┘  │
│                              │ Cache Miss                               │
│                              ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │              L2 Cache (Redis)                                    │  │
│  │  ┌────────────────────────────────────────────────────────────┐ │  │
│  │  │  • Max Memory: 256MB                                       │ │  │
│  │  │  • TTL: 5-30 minutes (configurable)                        │ │  │
│  │  │  • Network access (milliseconds)                           │ │  │
│  │  │  • Distributed caching                                     │ │  │
│  │  │  • Persistence to disk                                     │ │  │
│  │  │  • Eviction: allkeys-lru                                   │ │  │
│  │  └────────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────┬───────────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────────────┘
                               │ Cache Miss
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Database Layer (PostgreSQL)                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  • Source of truth                                                │  │
│  │  • Prisma ORM                                                     │  │
│  │  • Tables: PriceHistory, OnChainPrice, Currency, etc.            │  │
│  │  • Result automatically cached on read                           │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Cache Flow Diagram

```
┌─────────────┐
│   Request   │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│  Cache Middleware   │
│  Generate Key       │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐      ┌──────────────┐
│   L1 Cache Check    │─────▶│  Cache HIT   │──┐
└──────┬──────────────┘      └──────────────┘  │
       │ Miss                                   │
       ▼                                        │
┌─────────────────────┐      ┌──────────────┐  │
│   L2 Cache Check    │─────▶│  Cache HIT   │──┤
│     (Redis)         │      │  Populate L1 │  │
└──────┬──────────────┘      └──────────────┘  │
       │ Miss                                   │
       ▼                                        │
┌─────────────────────┐                        │
│  Database Query     │                        │
└──────┬──────────────┘                        │
       │                                        │
       ▼                                        │
┌─────────────────────┐                        │
│  Cache Result       │                        │
│  • Store in L2      │                        │
│  • Store in L1      │                        │
└──────┬──────────────┘                        │
       │                                        │
       ▼                                        │
┌─────────────────────┐                        │
│  Return Response    │◀───────────────────────┘
│  X-Cache: HIT/MISS  │
└─────────────────────┘
```

## Cache Invalidation Flow

```
┌─────────────────────┐
│  Data Mutation      │
│  (POST/PUT/DELETE)  │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│  Update Database    │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│  Invalidate Cache   │
│  • Pattern match    │
│  • Delete L1        │
│  • Delete L2        │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│  Next Request       │
│  Fetches Fresh Data │
└─────────────────────┘
```

## Monitoring Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cache Metrics Service                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Metrics Tracked:                                      │ │
│  │  • Total Hits / Misses                                 │ │
│  │  • L1 Hits / L2 Hits                                   │ │
│  │  • Hit Rate Percentage                                 │ │
│  │  • Error Count                                         │ │
│  │  • L1 Cache Size                                       │ │
│  │  • Redis Connection Status                             │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  Endpoints:                                                  │
│  • GET  /api/v1/cache/metrics                               │
│  • GET  /api/v1/cache/health                                │
│  • POST /api/v1/cache/clear                                 │
└─────────────────────────────────────────────────────────────┘
```

## Docker Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Compose Stack                      │
│                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐  │
│  │   App Server   │  │   PostgreSQL   │  │    Redis     │  │
│  │   (Node.js)    │  │   (Database)   │  │   (Cache)    │  │
│  │                │  │                │  │              │  │
│  │  Port: 3000    │  │  Port: 5432    │  │  Port: 6379  │  │
│  │                │  │                │  │              │  │
│  │  Depends on:   │  │  Volume:       │  │  Volume:     │  │
│  │  • PostgreSQL  │  │  • pgdata      │  │  • redis_data│  │
│  │  • Redis       │  │                │  │              │  │
│  │                │  │  Health Check  │  │  Health Check│  │
│  │                │  │  ✓ pg_isready  │  │  ✓ ping      │  │
│  └────────────────┘  └────────────────┘  └──────────────┘  │
│                                                              │
│  Network: stellarflow-net (bridge)                           │
└─────────────────────────────────────────────────────────────┘
```

## Performance Comparison

```
Before Caching:
┌─────────┐     450ms      ┌──────────┐
│ Request │───────────────▶│ Database │
└─────────┘                └──────────┘

After Caching (Cache Hit):
┌─────────┐  <1ms   ┌──────────┐
│ Request │────────▶│ L1 Cache │
└─────────┘         └──────────┘

After Caching (L1 Miss, L2 Hit):
┌─────────┐  <5ms   ┌──────────┐
│ Request │────────▶│ L2 Cache │
└─────────┘         └──────────┘

After Caching (Full Miss):
┌─────────┐  <50ms  ┌──────────┐
│ Request │────────▶│ Database │
└─────────┘         │ + Cache  │
                    └──────────┘
```

## Key Components

### 1. Cache Service
- Manages L1 and L2 cache layers
- Tracks metrics
- Handles graceful degradation

### 2. Cache Middleware
- Automatic route caching
- Key generation
- Response interception

### 3. Cache Invalidation
- Event-based clearing
- Pattern matching
- Mutation hooks

### 4. Cache Metrics
- Performance monitoring
- Health checks
- Real-time statistics

### 5. Cache Warming
- Startup optimization
- Popular data pre-loading
- Scheduled updates
