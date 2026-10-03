import {
  computeEffectiveWeights,
  resolveDelegation,
  type DelegationResolution,
  type ResolveOptions,
} from "./governanceDelegation";

/**
 * Keeps the current delegation graph (delegator -> delegate) and resolves
 * voting weight with the depth limit and cycle detection from
 * governanceDelegation.ts.
 */
export class GovernanceDelegationIndexer {
  private readonly edges = new Map<string, string>();

  constructor(private readonly options: ResolveOptions = {}) {}

  /** Record or replace the delegate for a delegator. */
  setDelegation(delegator: string, delegate: string): void {
    this.edges.set(delegator, delegate);
  }

  /** Remove a delegation (undelegate). */
  removeDelegation(delegator: string): void {
    this.edges.delete(delegator);
  }

  size(): number {
    return this.edges.size;
  }

  resolve(account: string): DelegationResolution {
    return resolveDelegation(account, this.edges, this.options);
  }

  effectiveWeights(ownWeights: ReadonlyMap<string, number>): Map<string, number> {
    return computeEffectiveWeights(ownWeights, this.edges, this.options);
  }
}
