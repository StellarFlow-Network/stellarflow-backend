/**
 * Utility to validate required environment variables on startup.
 * Prevents the server from crashing mysteriously if a setting is missing.
 */
export declare function validateEnv(): void;
/**
 * Get the MAX_LATENCY_MS value from environment variables.
 * @returns The latency threshold in milliseconds, or default 30000ms (30 seconds)
 */
export declare function getMaxLatencyMs(): number;
//# sourceMappingURL=envValidator.d.ts.map