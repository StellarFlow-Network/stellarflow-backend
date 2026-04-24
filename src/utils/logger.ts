import { webhookReporter } from "./webhookReporter";

export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
  CRITICAL = "critical",
}

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  fetcherName?: string | undefined;
  error?: Error | undefined;
  metadata?: Record<string, any> | undefined;
}

class Logger {
  private serviceName: string;

  constructor(serviceName = "StellarFlow") {
    this.serviceName = serviceName;
  }

  private formatLogEntry(entry: LogEntry): string {
    const { level, message, timestamp, fetcherName, error, metadata } = entry;
    const timestampStr = timestamp.toISOString();
    const fetcherStr = fetcherName ? ` [${fetcherName}]` : "";
    const metadataStr = metadata ? ` ${JSON.stringify(metadata)}` : "";
    const errorStr = error ? ` Error: ${error.message}` : "";

    return `[${timestampStr}] ${level.toUpperCase()}${fetcherStr} ${message}${metadataStr}${errorStr}`;
  }

  private log(
    level: LogLevel,
    message: string,
    fetcherName?: string,
    error?: Error,
    metadata?: Record<string, any>,
  ): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      fetcherName,
      error,
      metadata,
    };

    const formattedMessage = this.formatLogEntry(entry);

    // Output to console
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(formattedMessage);
        break;
      case LogLevel.INFO:
        console.info(formattedMessage);
        break;
      case LogLevel.WARN:
        console.warn(formattedMessage);
        break;
      case LogLevel.ERROR:
        console.error(formattedMessage);
        break;
      case LogLevel.CRITICAL:
        console.error(formattedMessage);
        break;
    }

    // Send webhook alert for critical logs
    if (level === LogLevel.CRITICAL && (fetcherName || error)) {
      const errorToSend = error || message;
      const fetcherToSend = fetcherName || "Unknown";

      // Send webhook asynchronously without blocking
      webhookReporter
        .sendCriticalAlert(errorToSend, fetcherToSend)
        .catch((webhookError) => {
          console.error(
            "Failed to send webhook alert:",
            webhookError instanceof Error ? webhookError.message : webhookError,
          );
        });
    }
  }

  public debug(
    message: string,
    fetcherName?: string,
    metadata?: Record<string, any>,
  ): void {
    this.log(LogLevel.DEBUG, message, fetcherName, undefined, metadata);
  }

  public info(
    message: string,
    fetcherName?: string,
    metadata?: Record<string, any>,
  ): void {
    this.log(LogLevel.INFO, message, fetcherName, undefined, metadata);
  }

  public warn(
    message: string,
    fetcherName?: string,
    metadata?: Record<string, any>,
  ): void {
    this.log(LogLevel.WARN, message, fetcherName, undefined, metadata);
  }

  public error(
    message: string,
    fetcherName?: string,
    error?: Error,
    metadata?: Record<string, any>,
  ): void {
    this.log(LogLevel.ERROR, message, fetcherName, error, metadata);
  }

  public critical(
    message: string,
    fetcherName?: string,
    error?: Error,
    metadata?: Record<string, any>,
  ): void {
    this.log(LogLevel.CRITICAL, message, fetcherName, error, metadata);
  }

  // Convenience method for fetcher failures
  public fetcherError(
    fetcherName: string,
    error: Error,
    context?: string,
    metadata?: Record<string, any>,
  ): void {
    const message = context || `Fetcher ${fetcherName} encountered an error`;
    this.critical(message, fetcherName, error, metadata);
  }

  // Create a logger instance specific to a fetcher
  public createFetcherLogger(fetcherName: string): FetcherLogger {
    return new FetcherLogger(this, fetcherName);
  }
}

// Specialized logger for fetchers
class FetcherLogger {
  private parentLogger: Logger;
  private fetcherName: string;

  constructor(parentLogger: Logger, fetcherName: string) {
    this.parentLogger = parentLogger;
    this.fetcherName = fetcherName;
  }

  public debug(message: string, metadata?: Record<string, any>): void {
    this.parentLogger.debug(message, this.fetcherName, metadata);
  }

  public info(message: string, metadata?: Record<string, any>): void {
    this.parentLogger.info(message, this.fetcherName, metadata);
  }

  public warn(message: string, metadata?: Record<string, any>): void {
    this.parentLogger.warn(message, this.fetcherName, metadata);
  }

  public error(
    message: string,
    error?: Error,
    metadata?: Record<string, any>,
  ): void {
    this.parentLogger.error(message, this.fetcherName, error, metadata);
  }

  public critical(
    message: string,
    error?: Error,
    metadata?: Record<string, any>,
  ): void {
    this.parentLogger.critical(message, this.fetcherName, error, metadata);
  }

  public fetcherError(
    error: Error,
    context?: string,
    metadata?: Record<string, any>,
  ): void {
    this.parentLogger.fetcherError(this.fetcherName, error, context, metadata);
  }

  public getFetcherName(): string {
    return this.fetcherName;
  }
}

// Default logger instance
export const logger = new Logger();

// Export classes for creating custom loggers
export { Logger, FetcherLogger };

// Convenience function to create fetcher loggers
export function createFetcherLogger(fetcherName: string): FetcherLogger {
  return logger.createFetcherLogger(fetcherName);
}
