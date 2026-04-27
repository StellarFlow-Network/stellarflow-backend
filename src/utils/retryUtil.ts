import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { OUTGOING_HTTP_TIMEOUT_MS } from "./httpTimeout.js";

/**
 * Retry configuration options
 */
export interface RetryConfig {
  /**
   * Maximum number of retry attempts (default: 3)
   */
  maxRetries?: number;

  /**
   * Delay between retries in milliseconds (default: 1000)
   */
  retryDelay?: number;

  /**
   * Whether to use exponential backoff (default: false)
   */
  exponentialBackoff?: boolean;

  /**
   * HTTP status codes that should trigger a retry (default: [408, 429, 500, 502, 503, 504])
   */
  retryableStatusCodes?: number[];

  /**
   * Custom function to determine if an error should trigger a retry
   */
  shouldRetry?: (error: AxiosError) => boolean;

  /**
   * Callback function called before each retry attempt
   */
  onRetry?: (attempt: number, error: AxiosError, delay: number) => void;
}

/**
 * Default retryable HTTP status codes
 */
const DEFAULT_RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: Required<
  Omit<RetryConfig, "shouldRetry" | "onRetry">
> = {
  maxRetries: 3,
  retryDelay: 1000,
  exponentialBackoff: false,
  retryableStatusCodes: DEFAULT_RETRYABLE_STATUS_CODES,
};

/**
 * Determines if an error should trigger a retry
 */
function shouldRetryError(
  error: AxiosError,
  config: Required<Omit<RetryConfig, "shouldRetry" | "onRetry">>,
): boolean {
  // Network errors (no response received)
  if (!error.response) {
    return true;
  }

  // Check if status code is retryable
  const statusCode = error.response.status;
  return config.retryableStatusCodes.includes(statusCode);
}

/**
 * Calculates the delay before the next retry attempt
 */
function calculateDelay(
  attempt: number,
  baseDelay: number,
  exponentialBackoff: boolean,
): number {
  if (exponentialBackoff) {
    return baseDelay * Math.pow(2, attempt - 1);
  }
  return baseDelay;
}

/**
 * Waits for a specified duration
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps an axios request with automatic retry logic
 *
 * @param requestFn - Function that returns an axios request promise
 * @param config - Retry configuration options
 * @returns Promise that resolves with the axios response
 *
 * @example
 * ```typescript
 * const response = await withRetry(
 *   () => axios.get('https://api.example.com/data'),
 *   { maxRetries: 3, retryDelay: 1000 }
 * );
 * ```
 */
export async function withRetry<T>(
  requestFn: () => Promise<T>,
  config: RetryConfig = {},
): Promise<T> {
  const mergedConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  let lastError: AxiosError | Error;
  let attempt = 0;

  while (attempt <= mergedConfig.maxRetries) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error as AxiosError | Error;
      attempt++;

      // Check if we've exhausted all retries
      if (attempt > mergedConfig.maxRetries) {
        break;
      }

      // Check if error is retryable
      const isAxiosError = axios.isAxiosError(error);
      if (!isAxiosError) {
        // Non-axios errors are not retried
        throw error;
      }

      const axiosError = error as AxiosError;
      const shouldRetry = config.shouldRetry
        ? config.shouldRetry(axiosError)
        : shouldRetryError(axiosError, mergedConfig);

      if (!shouldRetry) {
        throw error;
      }

      // Calculate delay for this retry
      const retryDelay = calculateDelay(
        attempt,
        mergedConfig.retryDelay,
        mergedConfig.exponentialBackoff,
      );

      // Call onRetry callback if provided
      if (config.onRetry) {
        config.onRetry(attempt, axiosError, retryDelay);
      } else {
        console.debug(
          `Retry attempt ${attempt}/${mergedConfig.maxRetries} after ${retryDelay}ms delay. ` +
            `Error: ${axiosError.message}`,
        );
      }

      // Wait before retrying
      await delay(retryDelay);
    }
  }

  // All retries exhausted
  throw lastError!;
}

/**
 * Creates an axios instance with built-in retry logic
 *
 * @param axiosConfig - Axios configuration
 * @param retryConfig - Retry configuration
 * @returns Axios instance with retry interceptor
 *
 * @example
 * ```typescript
 * const client = createRetryableAxiosInstance(
 *   { timeout: 5000 },
 *   { maxRetries: 3, retryDelay: 1000 }
 * );
 *
 * const response = await client.get('https://api.example.com/data');
 * ```
 */
export function createRetryableAxiosInstance(
  axiosConfig: AxiosRequestConfig = {},
  retryConfig: RetryConfig = {},
) {
  const instance = axios.create({
    timeout: OUTGOING_HTTP_TIMEOUT_MS,
    ...axiosConfig,
  });

  // Add response interceptor for retry logic
  instance.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const config = error.config;
      if (!config) {
        return Promise.reject(error);
      }

      // Initialize retry count
      const retryCount = (config as any).__retryCount || 0;
      const mergedConfig = {
        ...DEFAULT_RETRY_CONFIG,
        ...retryConfig,
      };

      // Check if we should retry
      if (retryCount >= mergedConfig.maxRetries) {
        return Promise.reject(error);
      }

      const shouldRetry = retryConfig.shouldRetry
        ? retryConfig.shouldRetry(error)
        : shouldRetryError(error, mergedConfig);

      if (!shouldRetry) {
        return Promise.reject(error);
      }

      // Increment retry count
      (config as any).__retryCount = retryCount + 1;

      // Calculate delay
      const retryDelay = calculateDelay(
        retryCount + 1,
        mergedConfig.retryDelay,
        mergedConfig.exponentialBackoff,
      );

      // Call onRetry callback
      if (retryConfig.onRetry) {
        retryConfig.onRetry(retryCount + 1, error, retryDelay);
      } else {
        console.debug(
          `Retry attempt ${retryCount + 1}/${mergedConfig.maxRetries} after ${retryDelay}ms delay. ` +
            `Error: ${error.message}`,
        );
      }

      // Wait and retry
      await delay(retryDelay);
      return instance.request(config);
    },
  );

  return instance;
}
