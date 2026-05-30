/**
 * Example Usage of High-Precision Event Logger
 *
 * This example demonstrates how to integrate nanosecond-precision event logging
 * into a service for high-frequency data pipeline monitoring.
 */

import {
  highPrecisionEventLogger,
  HighPrecisionEventLogger,
} from "../../utils/logger";

/**
 * Example: Price Service with High-Precision Event Logging
 */
export class PriceServiceWithLogging {
  async fetchPrices(currencies: string[]): Promise<Record<string, number>> {
    const operationStartNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();

    try {
      await highPrecisionEventLogger.info(
        "PriceService",
        "Price fetch started",
        {
          currencies,
          timestamp: operationStartNs.toString(),
        },
      );

      // Simulate price fetching
      const prices = await this.simulatePriceFetch(currencies);

      const operationEndNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();
      const operationDurationNs = operationEndNs - operationStartNs;

      await highPrecisionEventLogger.info(
        "PriceService",
        "Price fetch completed",
        {
          currencies,
          durationNs: operationDurationNs.toString(),
          durationMs: Number(operationDurationNs) / 1_000_000,
          resultCount: currencies.length,
        },
      );

      return prices;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      await highPrecisionEventLogger.error(
        "PriceService",
        "Price fetch failed",
        {
          currencies,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
      );

      throw error;
    }
  }

  private async simulatePriceFetch(
    currencies: string[],
  ): Promise<Record<string, number>> {
    return currencies.reduce(
      (acc, curr) => {
        acc[curr] = Math.random() * 1000;
        return acc;
      },
      {} as Record<string, number>,
    );
  }
}

/**
 * Example: Cache Service with High-Precision Event Logging
 */
export class CacheServiceWithLogging {
  private cache = new Map<string, { value: unknown; timestamp: bigint }>();

  async get(key: string): Promise<unknown | undefined> {
    const readStartNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();

    const entry = this.cache.get(key);

    if (entry) {
      const readEndNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();
      const readDurationNs = readEndNs - readStartNs;

      await highPrecisionEventLogger.debug("CacheService", "Cache hit", {
        key,
        readDurationNs: readDurationNs.toString(),
        ageNs: (readStartNs - entry.timestamp).toString(),
      });

      return entry.value;
    }

    const readEndNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();
    const readDurationNs = readEndNs - readStartNs;

    await highPrecisionEventLogger.debug("CacheService", "Cache miss", {
      key,
      readDurationNs: readDurationNs.toString(),
    });

    return undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const writeStartNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();

    this.cache.set(key, {
      value,
      timestamp: writeStartNs,
    });

    const writeEndNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();
    const writeDurationNs = writeEndNs - writeStartNs;

    await highPrecisionEventLogger.debug("CacheService", "Cache write", {
      key,
      writeDurationNs: writeDurationNs.toString(),
      valueSize: JSON.stringify(value).length,
    });
  }
}

/**
 * Example: API Gateway with High-Precision Event Logging
 */
export class APIGatewayWithLogging {
  async handleRequest(
    method: string,
    path: string,
    requestBody?: unknown,
  ): Promise<unknown> {
    const requestStartNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();

    try {
      await highPrecisionEventLogger.debug("APIGateway", "Request received", {
        method,
        path,
        timestamp: requestStartNs.toString(),
        bodySize: requestBody ? JSON.stringify(requestBody).length : 0,
      });

      // Simulate request processing
      const result = await this.processRequest(method, path, requestBody);

      const requestEndNs = HighPrecisionEventLogger.getAbsoluteNanoseconds();
      const requestDurationNs = requestEndNs - requestStartNs;

      // Warn if latency exceeds threshold
      if (requestDurationNs > BigInt(50_000_000)) {
        // 50ms threshold in nanoseconds
        await highPrecisionEventLogger.warn(
          "APIGateway",
          "High latency detected",
          {
            method,
            path,
            durationNs: requestDurationNs.toString(),
            durationMs: Number(requestDurationNs) / 1_000_000,
            threshold: 50,
          },
        );
      }

      await highPrecisionEventLogger.info("APIGateway", "Request completed", {
        method,
        path,
        durationNs: requestDurationNs.toString(),
        durationMs: Number(requestDurationNs) / 1_000_000,
        status: 200,
      });

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      await highPrecisionEventLogger.error("APIGateway", "Request failed", {
        method,
        path,
        error: errorMessage,
      });

      throw error;
    }
  }

  private async processRequest(
    method: string,
    path: string,
    _requestBody?: unknown,
  ): Promise<unknown> {
    // Simulate processing
    return { method, path, processed: true };
  }
}

/**
 * Example usage
 */
export async function demonstrateHighPrecisionLogging(): Promise<void> {
  // Create service instances
  const priceService = new PriceServiceWithLogging();
  const cacheService = new CacheServiceWithLogging();
  const apiGateway = new APIGatewayWithLogging();

  // Use services with high-precision logging
  try {
    // Price service example
    const prices = await priceService.fetchPrices(["NGN", "GHS", "KES"]);
    console.log("Fetched prices:", prices);

    // Cache service example
    await cacheService.set("ngn-price", prices["NGN"]);
    const cachedPrice = await cacheService.get("ngn-price");
    console.log("Cached price:", cachedPrice);

    // API Gateway example
    const apiResponse = await apiGateway.handleRequest("POST", "/prices", {
      currencies: ["NGN", "GHS", "KES"],
    });
    console.log("API response:", apiResponse);

    // Gracefully shutdown the high-precision event logger
    await highPrecisionEventLogger.shutdown();
  } catch (error) {
    console.error("Error in demonstration:", error);
  }
}
