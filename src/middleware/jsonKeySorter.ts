import { Request, Response, NextFunction } from "express";

/**
 * JSON Key Sorting Middleware
 *
 * Purpose:
 * - Ensures consistent JSON key ordering in API responses
 * - Improves readability in terminal and debug logs
 * - Provides visual hierarchy with id and timestamps first
 *
 * Key Ordering:
 * 1. 'id' field (if present) - always first
 * 2. Timestamp fields (createdAt, updatedAt, timestamp, etc.) - always second
 * 3. All other fields - sorted alphabetically
 */

/**
 * Common timestamp field names to prioritize
 */
const TIMESTAMP_FIELDS = [
  "createdAt",
  "updatedAt",
  "timestamp",
  "created_at",
  "updated_at",
  "issuedAt",
  "expiresAt",
  "issued_at",
  "expires_at",
];

/**
 * Recursively sort object keys according to the canonical ordering
 *
 * @param obj - The object to sort
 * @returns A new object with sorted keys
 */
function sortObjectKeys<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys) as T;
  }

  const keys = Object.keys(obj);
  const sortedObj: any = {};

  // Separate keys into categories
  const idKey = keys.find((k) => k === "id");
  const timestampKeys = keys.filter((k) =>
    TIMESTAMP_FIELDS.some((tf) => k.toLowerCase() === tf.toLowerCase()),
  );
  const otherKeys = keys.filter(
    (k) => k !== "id" && !TIMESTAMP_FIELDS.some((tf) => k.toLowerCase() === tf.toLowerCase()),
  );

  // Add id first if present
  if (idKey) {
    sortedObj[idKey] = sortObjectKeys((obj as any)[idKey]);
  }

  // Add timestamp keys second, sorted alphabetically
  timestampKeys.sort().forEach((key) => {
    sortedObj[key] = sortObjectKeys((obj as any)[key]);
  });

  // Add remaining keys sorted alphabetically
  otherKeys.sort().forEach((key) => {
    sortedObj[key] = sortObjectKeys((obj as any)[key]);
  });

  return sortedObj;
}

/**
 * Middleware to intercept JSON responses and sort keys
 *
 * This middleware overrides res.json to sort object keys before sending.
 * It handles nested objects and arrays recursively.
 */
export function jsonKeySorter(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);

  res.json = function (data: any): Response {
    try {
      const sortedData = sortObjectKeys(data);
      return originalJson(sortedData);
    } catch (error) {
      // If sorting fails, fall back to original behavior
      return originalJson(data);
    }
  };

  next();
}
