/**
 * Governance delegation resolver with depth limit and cycle detection.
 *
 * Voting weight is forwarded along delegation chains (A -> B -> C ...).
 * To keep the indexer safe from circular or very deep chains this module:
 *   - walks each chain iteratively (no recursion, so no stack exhaustion)
 *   - stops forwarding after MAX_DELEGATION_DEPTH hops
 *   - detects cycles (A -> B -> C -> A), halts forwarding, and logs
 *     GovernanceDelegationCycleDetected
 */

export const MAX_DELEGATION_DEPTH = 5;

/** delegator address -> delegate address (one delegate per delegator). */
export type DelegationEdges = ReadonlyMap<string, string>;

export interface DelegationLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export type DelegationStatus = "ok" | "cycle" | "depth_exceeded";

export interface DelegationResolution {
  /** Account that finally holds the forwarded weight. */
  holder: string;
  /** Number of hops actually followed. */
  hops: number;
  status: DelegationStatus;
  /** Accounts visited, starting with the delegator. */
  path: string[];
}

export interface ResolveOptions {
  maxDepth?: number;
  logger?: DelegationLogger;
}

const defaultLogger: DelegationLogger = {
  warn: (message, meta) => console.warn(message, meta ?? {}),
};

/**
 * Follow the delegation chain starting at `start`.
 *
 * - Cycle: forwarding is halted and the weight stays with `start`.
 * - Depth limit: forwarding stops after `maxDepth` hops; the weight lands on
 *   the account reached at that depth.
 */
export function resolveDelegation(
  start: string,
  edges: DelegationEdges,
  options: ResolveOptions = {},
): DelegationResolution {
  const maxDepth = options.maxDepth ?? MAX_DELEGATION_DEPTH;
  const logger = options.logger ?? defaultLogger;

  const path: string[] = [start];
  const visited = new Set<string>([start]);
  let current = start;
  let hops = 0;

  while (edges.has(current)) {
    if (hops >= maxDepth) {
      logger.warn("GovernanceDelegationDepthExceeded", {
        start,
        maxDepth,
        path,
      });
      return { holder: current, hops, status: "depth_exceeded", path };
    }

    const next = edges.get(current) as string;

    if (visited.has(next)) {
      logger.warn("GovernanceDelegationCycleDetected", {
        start,
        path: [...path, next],
      });
      return { holder: start, hops, status: "cycle", path: [...path, next] };
    }

    visited.add(next);
    path.push(next);
    current = next;
    hops += 1;
  }

  return { holder: current, hops, status: "ok", path };
}

/**
 * Compute effective voting weight per account after forwarding every
 * delegator's own weight along its chain (bounded and cycle safe).
 */
export function computeEffectiveWeights(
  ownWeights: ReadonlyMap<string, number>,
  edges: DelegationEdges,
  options: ResolveOptions = {},
): Map<string, number> {
  const result = new Map<string, number>();

  for (const [account, weight] of ownWeights) {
    const { holder } = resolveDelegation(account, edges, options);
    result.set(holder, (result.get(holder) ?? 0) + weight);
  }

  return result;
}
