export interface RpcEndpointState {
  url: string;
  weight: number;
  healthy: boolean;
  latencyMs?: number;
  lastFailureAt?: number;
}

export interface RpcEndpointConfig {
  url: string;
  weight?: number;
}

/**
 * Selects healthy RPC endpoints with weighted round-robin scheduling.
 * Failed endpoints are quarantined for a short cooldown and re-enter the
 * pool automatically, so a transient provider outage does not become a
 * permanent routing decision.
 */
export class RpcLoadBalancer {
  private readonly endpoints: RpcEndpointState[];
  private cursor = 0;
  private readonly cooldownMs: number;
  private readonly latencyThresholdMs: number;

  constructor(
    configs: readonly RpcEndpointConfig[],
    options: { cooldownMs?: number; latencyThresholdMs?: number } = {},
  ) {
    this.endpoints = configs.map(({ url, weight = 1 }) => ({
      url,
      weight: Math.max(1, Math.floor(weight)),
      healthy: true,
    }));
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.latencyThresholdMs = options.latencyThresholdMs ?? 2_000;
  }

  /** Returns the next endpoint, preferring healthy endpoints. */
  next(now = Date.now()): RpcEndpointState | undefined {
    const healthy = this.endpoints.filter((endpoint) => this.isAvailable(endpoint, now));
    const candidates = healthy.length > 0 ? healthy : this.endpoints;
    if (candidates.length === 0) return undefined;

    const totalWeight = candidates.reduce((sum, endpoint) => sum + endpoint.weight, 0);
    let ticket = this.cursor++ % totalWeight;
    for (const endpoint of candidates) {
      if (ticket < endpoint.weight) return endpoint;
      ticket -= endpoint.weight;
    }
    return candidates[candidates.length - 1];
  }

  /** Records a successful request and updates the endpoint latency sample. */
  recordSuccess(url: string, latencyMs: number): void {
    const endpoint = this.find(url);
    if (!endpoint) return;
    endpoint.healthy = true;
    endpoint.lastFailureAt = undefined;
    endpoint.latencyMs = latencyMs;
  }

  /** Quarantines an endpoint after transport failure or a latency spike. */
  recordFailure(url: string, latencyMs?: number, now = Date.now()): void {
    const endpoint = this.find(url);
    if (!endpoint) return;
    endpoint.healthy = false;
    endpoint.lastFailureAt = now;
    endpoint.latencyMs = latencyMs;
  }

  /** Returns a read-only health snapshot for diagnostics and metrics. */
  snapshot(): readonly RpcEndpointState[] {
    return this.endpoints.map((endpoint) => ({ ...endpoint }));
  }

  private find(url: string): RpcEndpointState | undefined {
    return this.endpoints.find((endpoint) => endpoint.url === url);
  }

  private isAvailable(endpoint: RpcEndpointState, now: number): boolean {
    if (endpoint.healthy) return true;
    if (endpoint.lastFailureAt === undefined) return true;
    return now - endpoint.lastFailureAt >= this.cooldownMs;
  }

  /** True when a latency sample exceeds the configured abuse threshold. */
  isLatencySpike(latencyMs: number): boolean {
    return latencyMs >= this.latencyThresholdMs;
  }
}
