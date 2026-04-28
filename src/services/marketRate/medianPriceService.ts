export class MedianPriceService {
  calculateMedian(values: number[]): number {
    if (values.length < 3) {
      throw new Error("At least 3 values are required to calculate median");
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);

    return sorted[middleIndex] ?? 0;
  }
}
