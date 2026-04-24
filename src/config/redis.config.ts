export const CACHE_CONFIG = {
  ttl: {
    marketRates: 300, // 5 minutes
    history: 1800, // 30 minutes
    stats: 600, // 10 minutes
    intelligence: 900, // 15 minutes
    assets: 1800, // 30 minutes
    derivedAssets: 300, // 5 minutes
    status: 60, // 1 minute
  },
  l1: {
    enabled: true,
    maxSize: 100,
    ttl: 30, // 30 seconds
  },
  redis: {
    keyPrefix: "stellarflow:",
    maxMemory: "256mb",
  },
} as const;

export const CACHE_KEYS = {
  marketRates: {
    all: () => "market-rates:all",
    single: (currency: string) => `market-rates:${currency}`,
    latest: () => "market-rates:latest",
    health: () => "market-rates:health",
    currencies: () => "market-rates:currencies",
    pendingReviews: () => "market-rates:reviews:pending",
  },
  history: {
    asset: (asset: string, range: string) => `history:${asset}:${range}`,
  },
  stats: {
    volume: (date: string) => `stats:volume:${date}`,
  },
  intelligence: {
    all: () => "intelligence:all",
    hourlyVolatility: () => "intelligence:hourly-volatility",
  },
  assets: {
    all: () => "assets:all",
  },
  derivedAssets: {
    crossRate: (base: string, quote: string) => `derived:${base}:${quote}`,
    ngnGhs: () => "derived:ngn-ghs",
  },
  status: {
    system: () => "status:system",
  },
} as const;
