import { AxiosError, AxiosRequestConfig } from "axios";
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
export declare function withRetry<T>(requestFn: () => Promise<T>, config?: RetryConfig): Promise<T>;
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
export declare function createRetryableAxiosInstance(axiosConfig?: AxiosRequestConfig, retryConfig?: RetryConfig): import("axios").AxiosInstance;
//# sourceMappingURL=retryUtil.d.ts.map