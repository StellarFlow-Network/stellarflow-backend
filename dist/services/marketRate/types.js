/**
 * Circuit Breaker State
 * Represents the state of a circuit breaker
 */
export var CircuitBreakerState;
(function (CircuitBreakerState) {
    CircuitBreakerState["CLOSED"] = "CLOSED";
    CircuitBreakerState["OPEN"] = "OPEN";
    CircuitBreakerState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitBreakerState || (CircuitBreakerState = {}));
/**
 * Calculate the median of an array of numbers
 * This helps prevent a single bad API from ruining the data
 * @param values - Array of price numbers from different sources
 * @returns The median value
 */
export function calculateMedian(values) {
    if (values.length === 0)
        return 0;
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
export function calculateAverage(prices) {
    if (prices.length === 0)
        return 0;
    const sum = prices.reduce((acc, price) => acc + price, 0);
    return sum / prices.length;
}
//# sourceMappingURL=types.js.map