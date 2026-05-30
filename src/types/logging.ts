/**
 * High-Precision Logging Types
 */

export interface EventLogEntry {
  eventType: string;
  source: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
  timestampNs?: bigint;
}

export interface NanosecondTimestamp {
  ns: bigint;
  formattedTime: string;
}
