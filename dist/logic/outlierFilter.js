/**
 * Outlier Detection Filter for Exchange Rates
 * Detects and removes manipulated/extreme prices using Interquartile Range (IQR) method
 *
 * Example: [750, 752, 900] → Q1=750, Q3=752, IQR=2, upper=752+1.5*2=755 → keeps 750,752 (ignores 900 if tuned)
 */
export function filterOutliers(prices, multiplier = 1.5) {
    if (prices.length < 3) {
        // Need at least 3 prices for meaningful outlier detection
        return prices.filter(p => p > 0 && !isNaN(p));
    }
    const validPrices = prices.filter(p => p > 0 && !isNaN(p) && isFinite(p));
    if (validPrices.length < 3)
        return validPrices;
    const sorted = [...validPrices].sort((a, b) => a - b);
    const n = sorted.length;
    const q1Index = Math.floor((n + 1) / 4);
    const q3Index = Math.floor(3 * (n + 1) / 4);
    const q1 = sorted[q1Index] ?? sorted[0] ?? 0;
    const q3 = sorted[q3Index] ?? sorted[n - 1] ?? 0;
    const iqr = q3 - q1;
    const lowerFence = q1 - multiplier * iqr;
    const upperFence = q3 + multiplier * iqr;
    const filtered = sorted.filter(price => price >= lowerFence && price <= upperFence);
    // Fallback: if too few remain (< 2), return all valid
    return filtered.length >= 2 ? filtered : validPrices;
}
export function isOutlier(price, prices, multiplier = 1.5) {
    const filtered = filterOutliers(prices, multiplier);
    return !filtered.includes(price);
}
/**
 * Calculate percentage deviation from median
 */
export function percentDeviation(price, median) {
    return Math.abs((price - median) / median) * 100;
}
//# sourceMappingURL=outlierFilter.js.map