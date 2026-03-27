/**
 * Market Rate Interface
 * Represents the fetched exchange rate data
 */
export interface MarketRate {
  currency: string;
  rate: number;
  timestamp: Date;
  source: string;
  manualReviewRequired?: boolean;
  reviewId?: number;
  reviewReason?: string;
  reviewChangePercent?: number;
  comparisonRate?: number;
  comparisonTimestamp?: Date;
  contractSubmissionSkipped?: boolean;
  // Multi-sig fields
  pendingMultiSig?: boolean;
  multiSigPriceId?: number;
}

/**
 * Market Rate Fetcher Interface
 * Contract for all currency rate fetcher implementations
 */
export interface MarketRateFetcher {
  /**
   * Get the currency code this fetcher handles
   */
  getCurrency(): string;

  /**
   * Fetch the current exchange rate
   * @throws Error if all rate sources fail
   */
  fetchRate(): Promise<MarketRate>;

  /**
   * Check if the fetcher is healthy and can reach its sources
   */
  isHealthy(): Promise<boolean>;
}

/**
 * Rate Source Configuration
 * Represents an external API source for exchange rates
 */
export interface RateSource {
  name: string;
  url: string;
  apiKey?: string;
}

/**
 * Fetcher Response Wrapper
 * Standardized response format for rate fetcher operations
 */
export interface FetcherResponse {
  success: boolean;
  data?: MarketRate;
  error?: string;
}

/**
 * Aggregated Response for multiple fetchers
 * Used when fetching rates from multiple currency sources
 */
export interface AggregatedFetcherResponse {
  success: boolean;
  data?: MarketRate[];
  error?: string;
  errors?: string[];
}

/**
 * Rate Fetch Error
 * Detailed error information for failed rate fetches
 */
export interface RateFetchError {
  source: string;
  message: string;
  timestamp: Date;
  retryable?: boolean;
}

/**
 * Circuit Breaker State
 * Represents the state of a circuit breaker
 */
export enum CircuitBreakerState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

/**
 * Health Check Response
 * Standardized health check response
 */
export interface HealthCheckResponse {
  healthy: boolean;
  lastChecked: Date;
  latencyMs?: number;
  error?: string;
}

/**
 * Source trust tier used when weighting multi-source rates.
 */
export type SourceTrustLevel = "trusted" | "standard" | "new";

/**
 * Calculate the median of an array of numbers
 * This helps prevent a single bad API from ruining the data
 * @param values - Array of price numbers from different sources
 * @returns The median value
 */
export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    const mid1 = sorted[middle - 1];
    const mid2 = sorted[middle];
    if (mid1 !== undefined && mid2 !== undefined) {
      return (mid1 + mid2) / 2;
    }
    return mid2 ?? mid1 ?? 0;
  }

  return sorted[middle] ?? 0;
}

/**
 * Calculate the simple average (arithmetic mean) of an array of numbers.
 * Used to produce one final price from multiple source prices (e.g. NGN).
 * @param prices - Array of price numbers from different sources
 * @returns The arithmetic mean, or 0 for an empty array
 */
export function calculateAverage(prices: number[]): number {
  if (prices.length === 0) return 0;

  const sum = prices.reduce((acc, price) => acc + price, 0);
  return sum / prices.length;
}

export interface WeightedPriceInput {
  value: number;
  trustLevel?: SourceTrustLevel;
  weight?: number;
}

const SOURCE_TRUST_WEIGHTS: Record<SourceTrustLevel, number> = {
  trusted: 3,
  standard: 2,
  new: 1,
};

/**
 * Calculate weighted average from source values.
 * Use explicit `weight` when provided, otherwise derive by trust level.
 */
export function calculateWeightedAverage(values: WeightedPriceInput[]): number {
  if (values.length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const value of values) {
    const trustWeight = SOURCE_TRUST_WEIGHTS[value.trustLevel ?? "standard"];
    const weight =
      typeof value.weight === "number" &&
      Number.isFinite(value.weight) &&
      value.weight > 0
        ? value.weight
        : trustWeight;

    weightedSum += value.value * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

/**
 * Rate Fetch Statistics
 * Performance and reliability metrics
 */
export {
  filterOutliers,
  isOutlier,
  percentDeviation,
} from "../../logic/outlierFilter";

export interface RateFetchStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatencyMs: number;
  lastSuccessfulFetch?: Date;
  lastFailedFetch?: Date;
}
