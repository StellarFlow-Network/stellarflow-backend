import { Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";
import { getMaxLatencyMs } from "../utils/envValidator";

/**
 * Latency validation middleware for relayer payloads.
 * 
 * Validates that incoming relayer payloads are not "stale" by checking
 * the timestamp difference between the payload and current time.
 * 
 * Expects payloads to have a `timestamp` field (ISO 8601 format).
 * If the timestamp_diff exceeds MAX_LATENCY_MS threshold, the request is rejected.
 * 
 * Latency violations are logged to the ComplianceMetadataStore for auditing.
 */
export const latencyValidationMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Skip validation if not a relayer request
  if (!req.relayer) {
    next();
    return;
  }

  const maxLatencyMs = getMaxLatencyMs();
  const payloadTimestamp = req.body.timestamp;

  // If no timestamp in payload, allow through but log a warning
  if (!payloadTimestamp) {
    console.warn(
      `[LatencyGuard] No timestamp in relayer payload. Relayer: ${req.relayer.name}. Allowing request but recommend adding timestamp.`,
    );
    next();
    return;
  }

  try {
    // Parse the payload timestamp
    const payloadTime = new Date(payloadTimestamp).getTime();
    
    if (isNaN(payloadTime)) {
      console.error(
        `[LatencyGuard] Invalid timestamp format in relayer payload: ${payloadTimestamp}`,
      );
      await logLatencyViolation(
        req.relayer.id,
        req.relayer.name,
        "INVALID_TIMESTAMP",
        payloadTimestamp,
        null,
        maxLatencyMs,
        { error: "Invalid timestamp format" },
      );
      
      res.status(400).json({
        success: false,
        error: "Invalid timestamp format in payload",
      });
      return;
    }

    // Calculate latency difference
    const now = Date.now();
    const latencyDiff = now - payloadTime;

    // Check if latency exceeds threshold
    if (latencyDiff > maxLatencyMs) {
      console.error(
        `[LatencyGuard] LATENCY VIOLATION: Relayer "${req.relayer.name}" payload is ${latencyDiff}ms old (max: ${maxLatencyMs}ms)`,
      );

      // Log the violation to ComplianceMetadataStore
      await logLatencyViolation(
        req.relayer.id,
        req.relayer.name,
        "LATENCY_VIOLATION",
        payloadTimestamp,
        latencyDiff,
        maxLatencyMs,
        {
          endpoint: req.path,
          method: req.method,
          bodyKeys: Object.keys(req.body).filter(k => k !== 'timestamp'),
        },
      );

      res.status(400).json({
        success: false,
        error: `Payload timestamp exceeds maximum latency threshold (${maxLatencyMs}ms)`,
        code: "LATENCY_VIOLATION",
        details: {
          payloadTimestamp,
          latencyDiffMs: latencyDiff,
          thresholdMs: maxLatencyMs,
        },
      });
      return;
    }

    // Log successful validation for monitoring
    console.debug(
      `[LatencyGuard] Relayer "${req.relayer.name}" payload validated: ${latencyDiff}ms latency (max: ${maxLatencyMs}ms)`,
    );

    next();
  } catch (error) {
    console.error("[LatencyGuard] Error during latency validation:", error);
    
    // Log the error as a violation for auditing
    await logLatencyViolation(
      req.relayer.id,
      req.relayer.name,
      "VALIDATION_ERROR",
      payloadTimestamp,
      null,
      maxLatencyMs,
      { error: String(error) },
    );

    res.status(500).json({
      success: false,
      error: "Latency validation failed",
    });
  }
};

/**
 * Logs a latency violation to the ComplianceMetadataStore for auditing.
 */
async function logLatencyViolation(
  relayerId: number | undefined,
  relayerName: string | undefined,
  eventType: string,
  payloadTimestamp: string | null,
  latencyDiffMs: number | null,
  thresholdMs: number,
  details: object,
): Promise<void> {
  try {
    await prisma.complianceMetadata.create({
      data: {
        relayerId: relayerId,
        relayerName: relayerName,
        eventType,
        payloadTimestamp: payloadTimestamp ? new Date(payloadTimestamp) : null,
        receivedAt: new Date(),
        latencyDiffMs,
        thresholdMs,
        details: JSON.stringify(details),
        resolved: false,
      },
    });
    
    console.info(`[LatencyGuard] Violation logged to ComplianceMetadataStore: ${eventType}`);
  } catch (error) {
    // Non-blocking: log error but don't fail the request
    console.error("[LatencyGuard] Failed to log violation to ComplianceMetadataStore:", error);
  }
}

/**
 * Get compliance metadata for a specific relayer.
 * Useful for auditing relayer performance.
 */
export async function getRelayerComplianceHistory(
  relayerName?: string,
  eventType?: string,
  limit: number = 100,
) {
  const where: any = {};
  
  if (relayerName) {
    where.relayerName = relayerName;
  }
  
  if (eventType) {
    where.eventType = eventType;
  }

  return prisma.complianceMetadata.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Get latency violation statistics for a relayer.
 */
export async function getRelayerLatencyStats(relayerName: string) {
  const totalViolations = await prisma.complianceMetadata.count({
    where: {
      relayerName,
      eventType: "LATENCY_VIOLATION",
    },
  });

  const recentViolations = await prisma.complianceMetadata.findMany({
    where: {
      relayerName,
      eventType: "LATENCY_VIOLATION",
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      latencyDiffMs: true,
      thresholdMs: true,
      createdAt: true,
    },
  });

  // Calculate average latency of violations
  const avgLatency = recentViolations.length > 0
    ? recentViolations.reduce((sum, v) => sum + (v.latencyDiffMs || 0), 0) / recentViolations.length
    : 0;

  return {
    relayerName,
    totalViolations,
    recentViolationCount: recentViolations.length,
    averageLatencyMs: Math.round(avgLatency),
    recentViolations,
  };
}