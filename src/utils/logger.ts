import winstonLogger from "./winstonLogger";
import {
  highPrecisionEventLogger,
  HighPrecisionEventLogger,
} from "../services/highPrecisionEventLogger";

// Export the Winston logger as the default logger
export const logger = winstonLogger;

// For compatibility, export a createFetcherLogger that returns the same logger
export function createFetcherLogger(_fetcherName: string) {
  // Optionally, you can add child loggers or labels here
  return winstonLogger;
}

// Export the high-precision event logger for nanosecond-level tracking
export { highPrecisionEventLogger, HighPrecisionEventLogger };

// Export a helper to get nanosecond timestamps
export const getNanosecondTimestamp = () =>
  HighPrecisionEventLogger.getAbsoluteNanoseconds();
