/**
 * Outlier Detection Filter for Exchange Rates
 * Detects and removes manipulated/extreme prices using Interquartile Range (IQR) method
 *
 * Example: [750, 752, 900] → Q1=750, Q3=752, IQR=2, upper=752+1.5*2=755 → keeps 750,752 (ignores 900 if tuned)
 */
export declare function filterOutliers(prices: number[], multiplier?: number): number[];
export declare function isOutlier(price: number, prices: number[], multiplier?: number): boolean;
/**
 * Calculate percentage deviation from median
 */
export declare function percentDeviation(price: number, median: number): number;
//# sourceMappingURL=outlierFilter.d.ts.map