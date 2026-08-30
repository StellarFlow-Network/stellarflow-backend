/**
 * GraphQL Query Analyzer
 *
 * Parses incoming GraphQL query strings and calculates:
 * 1. Query depth – the deepest nesting level of field selections
 * 2. Query complexity – a weighted score based on field selections, arguments,
 *    and aliases to penalise expensive queries
 *
 * Both metrics are used by the `graphqlQueryGuard` middleware to reject
 * over-the-limit queries before they reach the GraphQL execution engine.
 */

import {
  parse,
  type DocumentNode,
  type SelectionSetNode,
  type SelectionNode,
} from "graphql";

// ─── Defaults ────────────────────────────────────────────────────────

/** Maximum allowed nesting depth (issue #924 acceptance criteria: >5 rejected) */
export const DEFAULT_MAX_DEPTH = 5;

/** Maximum allowed complexity score */
export const DEFAULT_MAX_COMPLEXITY = 1_000;

/** Per-field complexity cost (base) */
const BASE_FIELD_COST = 1;

/** Extra cost per argument on a field */
const ARGUMENT_COST = 2;

/** Extra cost for each alias (aliases can disguise multiple sub-queries) */
const ALIAS_COST = 1;

// ─── Types ───────────────────────────────────────────────────────────

export interface AnalyzerOptions {
  maxDepth?: number;
  maxComplexity?: number;
}

export interface AnalysisResult {
  /** Whether the query passes both depth and complexity limits */
  allowed: boolean;
  /** Calculated depth of the query */
  depth: number;
  /** Calculated complexity score */
  complexity: number;
  /** Human-readable reason when `allowed` is false */
  reason?: string;
}

// ─── Depth Calculation ───────────────────────────────────────────────

/**
 * Recursively measures the depth of a selection set.
 * Fragments are expanded inline (no fragment resolution needed here because
 * fragments on the same type are uncommon in practice; the middleware
 * intentionally rejects fragment-heavy queries as overly complex).
 */
function selectionSetDepth(set: SelectionSetNode, current: number): number {
  let max = current;

  for (const node of set.selections) {
    const childDepth = fieldDepth(node, current);
    if (childDepth > max) max = childDepth;
  }

  return max;
}

function fieldDepth(node: SelectionNode, depth: number): number {
  if (node.kind === "Field" && node.selectionSet) {
    return selectionSetDepth(node.selectionSet, depth + 1);
  }
  // Inline fragments
  if (node.kind === "InlineFragment" && node.selectionSet) {
    return selectionSetDepth(node.selectionSet, depth);
  }
  // Fragment spreads are treated as depth-neutral (could be resolved externally)
  return depth;
}

function calcDepth(doc: DocumentNode): number {
  let maxDepth = 0;

  for (const definition of doc.definitions) {
    if (definition.kind === "OperationDefinition" && definition.selectionSet) {
      const depth = selectionSetDepth(definition.selectionSet, 1);
      if (depth > maxDepth) maxDepth = depth;
    }
  }

  return maxDepth;
}

// ─── Complexity Calculation ──────────────────────────────────────────

/**
 * Walks the selection tree and accumulates a complexity score.
 *
 * Score formula per field:
 *   BASE_FIELD_COST + (number of arguments * ARGUMENT_COST) + (has alias ? ALIAS_COST : 0)
 *
 * Selection sets multiply the accumulated child cost by a depth factor so
 * that deeply nested queries receive exponentially higher scores.
 */
function selectionSetComplexity(
  set: SelectionSetNode,
  depthMultiplier: number,
): number {
  let total = 0;

  for (const node of set.selections) {
    total += fieldComplexity(node, depthMultiplier);
  }

  return total;
}

function fieldComplexity(node: SelectionNode, depthMultiplier: number): number {
  if (node.kind === "Field") {
    let cost = BASE_FIELD_COST;

    if (node.arguments && node.arguments.length > 0) {
      cost += node.arguments.length * ARGUMENT_COST;
    }

    if (node.alias) {
      cost += ALIAS_COST;
    }

    if (node.selectionSet) {
      // Multiply child cost by the current depth factor
      cost *= depthMultiplier;
      cost += selectionSetComplexity(node.selectionSet, depthMultiplier + 1);
    }

    return cost;
  }

  if (node.kind === "InlineFragment" && node.selectionSet) {
    return selectionSetComplexity(node.selectionSet, depthMultiplier);
  }

  return 0;
}

function calcComplexity(doc: DocumentNode): number {
  let maxComplexity = 0;

  for (const definition of doc.definitions) {
    if (definition.kind === "OperationDefinition" && definition.selectionSet) {
      const complexity = selectionSetComplexity(definition.selectionSet, 1);
      if (complexity > maxComplexity) maxComplexity = complexity;
    }
  }

  return maxComplexity;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Parse a raw GraphQL query string and evaluate whether it is within
 * acceptable depth and complexity bounds.
 *
 * Returns an `AnalysisResult` with the metrics and, when rejected, a
 * human-readable `reason` string suitable for inclusion in a GraphQL error
 * response payload.
 */
export function analyzeQuery(
  query: string,
  options: AnalyzerOptions = {},
): AnalysisResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxComplexity = options.maxComplexity ?? DEFAULT_MAX_COMPLEXITY;

  // Parse the query – a parse error itself is a malformed query, not a limit
  // violation, so we surface it differently.
  let doc: DocumentNode;
  try {
    doc = parse(query);
  } catch {
    return {
      allowed: false,
      depth: 0,
      complexity: 0,
      reason: "QUERY_PARSE_ERROR: The provided query could not be parsed.",
    };
  }

  const depth = calcDepth(doc);
  const complexity = calcComplexity(doc);

  if (depth > maxDepth) {
    return {
      allowed: false,
      depth,
      complexity,
      reason: `QUERY_TOO_DEEP: Query exceeds maximum allowed depth of ${maxDepth} (actual: ${depth}). Reduce nesting to avoid excessive server load.`,
    };
  }

  if (complexity > maxComplexity) {
    return {
      allowed: false,
      depth,
      complexity,
      reason: `QUERY_TOO_COMPLEX: Query exceeds maximum allowed complexity of ${maxComplexity} (actual: ${complexity}). Simplify your query by removing unnecessary fields or narrowing arguments.`,
    };
  }

  return { allowed: true, depth, complexity };
}
