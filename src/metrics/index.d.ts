declare module "prom-client";

export interface Registry {
  contentType: string;
  metrics(): Promise<string>;
}

export interface Counter {
  inc(labels?: Record<string, string>): void;
}

export interface Histogram {
  startTimer(labels?: Record<string, string>): () => void;
  observe(labels?: Record<string, string>, value: number): void;
}

export const registry: Registry;
export const successfulSubmissions: Counter;
export const failedSubmissions: Counter;
export const gasUsagePerAsset: Histogram;
export const submissionDuration: Histogram;
