import axios from "axios";

type FailoverRegion = "PRIMARY" | "SECONDARY";

type RegionStatus = {
  url: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
};

const DEFAULT_FAILOVER_THRESHOLD = 3;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5000;
const DEFAULT_HEARTBEAT_PATH = "/health";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeHeartbeatPath(path: string): string {
  if (!path || path.trim().length === 0) {
    return DEFAULT_HEARTBEAT_PATH;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function buildHeartbeatUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export interface RegionalHealthState {
  activeRegion: FailoverRegion;
  activeUrl: string;
  manualOverrideRegion: FailoverRegion | null;
  primary: RegionStatus;
  secondary: RegionStatus;
  failoverThreshold: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export class RegionalHealthService {
  private readonly primaryUrl: string;
  private readonly secondaryUrl: string;
  private readonly heartbeatPath: string;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly failoverThreshold: number;
  private activeRegion: FailoverRegion = "PRIMARY";
  private manualOverrideRegion: FailoverRegion | null = null;
  private monitoringTimer: NodeJS.Timeout | null = null;

  private status: {
    primary: RegionStatus;
    secondary: RegionStatus;
  };

  constructor() {
    this.primaryUrl =
      process.env.PRIMARY_CLUSTER_HEALTH_URL ||
      process.env.LAGOS_CLUSTER_HEALTH_URL ||
      "https://lagos-backend.example.com";

    this.secondaryUrl =
      process.env.SECONDARY_CLUSTER_HEALTH_URL ||
      process.env.FRANKFURT_CLUSTER_HEALTH_URL ||
      "https://frankfurt-backend.example.com";

    this.heartbeatPath = normalizeHeartbeatPath(
      process.env.REGIONAL_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH,
    );
    this.heartbeatIntervalMs = parsePositiveInt(
      process.env.REGIONAL_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.heartbeatTimeoutMs = parsePositiveInt(
      process.env.REGIONAL_HEARTBEAT_TIMEOUT_MS,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
    );
    this.failoverThreshold = parsePositiveInt(
      process.env.FAILOVER_THRESHOLD,
      DEFAULT_FAILOVER_THRESHOLD,
    );

    this.status = {
      primary: {
        url: this.primaryUrl,
        healthy: true,
        consecutiveFailures: 0,
        lastCheckedAt: null,
      },
      secondary: {
        url: this.secondaryUrl,
        healthy: true,
        consecutiveFailures: 0,
        lastCheckedAt: null,
      },
    };
  }

  getState(): RegionalHealthState {
    return {
      activeRegion: this.activeRegion,
      activeUrl: this.getActiveUrl(),
      manualOverrideRegion: this.manualOverrideRegion,
      primary: { ...this.status.primary },
      secondary: { ...this.status.secondary },
      failoverThreshold: this.failoverThreshold,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    };
  }

  getActiveUrl(): string {
    return this.activeRegion === "PRIMARY"
      ? this.primaryUrl
      : this.secondaryUrl;
  }

  getActiveRegion(): FailoverRegion {
    return this.activeRegion;
  }

  async startMonitoring(): Promise<void> {
    if (this.monitoringTimer) {
      return;
    }

    await this.performHealthCheck();

    this.monitoringTimer = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        console.error("[RegionalHealthService] Health check failed:", error);
      }
    }, this.heartbeatIntervalMs);
  }

  stopMonitoring(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }
  }

  async forceFailover(region: FailoverRegion): Promise<RegionalHealthState> {
    if (region !== "PRIMARY" && region !== "SECONDARY") {
      throw new Error("Invalid failover region");
    }

    this.manualOverrideRegion = region;
    this.setActiveRegion(region, "manual override");
    return this.getState();
  }

  async resetManualOverride(): Promise<RegionalHealthState> {
    this.manualOverrideRegion = null;
    return this.getState();
  }

  private async performHealthCheck(): Promise<void> {
    const primaryHealthy = await this.pingRegion("PRIMARY");
    const secondaryHealthy = await this.pingRegion("SECONDARY");

    this.status.primary.healthy = primaryHealthy;
    this.status.secondary.healthy = secondaryHealthy;

    if (!this.manualOverrideRegion) {
      this.evaluateAutomaticFailover();
    }
  }

  private async pingRegion(region: FailoverRegion): Promise<boolean> {
    const url = region === "PRIMARY" ? this.primaryUrl : this.secondaryUrl;
    const heartbeatUrl = buildHeartbeatUrl(url, this.heartbeatPath);
    const result = {
      region,
      healthy: false,
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await axios.get(heartbeatUrl, {
        timeout: this.heartbeatTimeoutMs,
      });

      result.healthy = response.status >= 200 && response.status < 400;
    } catch (error) {
      result.healthy = false;
    }

    const statusSlot =
      region === "PRIMARY" ? this.status.primary : this.status.secondary;

    statusSlot.lastCheckedAt = result.timestamp;
    statusSlot.consecutiveFailures = result.healthy
      ? 0
      : statusSlot.consecutiveFailures + 1;

    return result.healthy;
  }

  private evaluateAutomaticFailover(): void {
    const primary = this.status.primary;
    const secondary = this.status.secondary;

    if (this.activeRegion === "PRIMARY") {
      if (
        !primary.healthy &&
        primary.consecutiveFailures >= this.failoverThreshold &&
        secondary.healthy
      ) {
        this.setActiveRegion("SECONDARY", "automatic failover");
      }
    } else {
      if (primary.healthy && primary.consecutiveFailures === 0) {
        this.setActiveRegion("PRIMARY", "automatic failback");
        return;
      }

      if (
        !secondary.healthy &&
        secondary.consecutiveFailures >= this.failoverThreshold &&
        primary.healthy
      ) {
        this.setActiveRegion("PRIMARY", "automatic failback due to secondary outage");
      }
    }
  }

  private setActiveRegion(region: FailoverRegion, reason: string): void {
    if (this.activeRegion === region) {
      return;
    }

    this.activeRegion = region;
    console.info(
      `[RegionalHealthService] Active region changed to ${region} (${this.getActiveUrl()}) via ${reason}`,
    );
  }
}

let singleton: RegionalHealthService | null = null;

export function getRegionalHealthService(): RegionalHealthService {
  if (!singleton) {
    singleton = new RegionalHealthService();
  }
  return singleton;
}
