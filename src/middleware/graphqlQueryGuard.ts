/**
 * GraphQL Query Guard Middleware  (Issue #924)
 *
 * Intercepts incoming GraphQL POST requests, parses the query AST, and
 * enforces depth / complexity limits before the request reaches any
 * downstream GraphQL execution layer.
 *
 * The middleware is schema-agnostic – it operates on raw query strings
 * and does not require a compiled schema, making it safe to mount early
 * in the Express stack.
 *
 * Usage:
 *   import { graphqlQueryGuard } from "../middleware/graphqlQueryGuard";
 *   app.use("/graphql", graphqlQueryGuard());
 *
 * Environment variables:
 *   GRAPHQL_MAX_DEPTH      – override default max depth (default: 5)
 *   GRAPHQL_MAX_COMPLEXITY – override default max complexity (default: 1000)
 */

import { Request, Response, type NextFunction } from "express";
import { analyzeQuery, type AnalyzerOptions } from "../lib/graphqlAnalyzer.js";
import { logger } from "../utils/logger.js";

// ─── Configuration ───────────────────────────────────────────────────

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Build the default options from environment variables. */
function defaultOptions(): AnalyzerOptions {
  return {
    maxDepth: envInt("GRAPHQL_MAX_DEPTH", 5),
    maxComplexity: envInt("GRAPHQL_MAX_COMPLEXITY", 1000),
  };
}

// ─── Middleware Factory ──────────────────────────────────────────────

/**
 * Creates Express middleware that guards a GraphQL endpoint against
 * excessively deep or complex queries.
 *
 * The middleware inspects:
 *   1. The Content-Type must be `application/json`
 *   2. The body must contain a `query` string field
 *   3. The parsed query must pass depth and complexity limits
 *
 * If any check fails, a GraphQL-compatible error response is returned
 * and the request short-circuits.
 */
export function graphqlQueryGuard(overrides: AnalyzerOptions = {}) {
  const options: AnalyzerOptions = { ...defaultOptions(), ...overrides };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Only intercept POST requests that look like GraphQL queries.
    if (req.method !== "POST") {
      next();
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;

    // If the body doesn't contain a `query` string, it's not a GraphQL
    // request – let downstream handlers decide.
    if (!body || typeof body.query !== "string") {
      next();
      return;
    }

    const query: string = body.query;
    const result = analyzeQuery(query, options);

    if (result.allowed) {
      // Attach metrics so downstream handlers or logging middleware can
      // inspect them without re-parsing.
      req.queryDepth = result.depth;
      req.queryComplexity = result.complexity;
      next();
      return;
    }

    // Rejection path – return a GraphQL-compliant error envelope.
    logger.warn("[GraphQLQueryGuard] Query rejected", {
      depth: result.depth,
      complexity: result.complexity,
      reason: result.reason,
      ip: req.ip,
      path: req.path,
    });

    // Per the GraphQL spec, errors are returned in the `errors` array with
    // a status of 200 (unless the server chooses 400). We use 400 to make
    // it clear the client sent an invalid query.
    res.status(400).json({
      errors: [
        {
          message: result.reason ?? "Query rejected by query guard.",
          extensions: {
            code: "QUERY_COMPLEXITY_EXCEEDED",
            depth: result.depth,
            complexity: result.complexity,
          },
        },
      ],
    });
  };
}

// ─── Type Augmentation ──────────────────────────────────────────────
// Allow downstream handlers to read the computed metrics without casting.

declare module "express" {
  interface Request {
    /** Depth of the GraphQL query analyzed by the guard middleware. */
    queryDepth?: number;
    /** Complexity score of the GraphQL query analyzed by the guard middleware. */
    queryComplexity?: number;
  }
}
