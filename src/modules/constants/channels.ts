export const CHANNELS = {
  PRICE_UPDATES: 'price_updates',
  CACHE_INVALIDATION: 'cache_invalidation',
  MARKET_STREAM: 'market_stream',
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];
