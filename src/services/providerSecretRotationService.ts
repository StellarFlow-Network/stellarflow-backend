import axios from "axios";
import { logger } from "../utils/logger";

type RotationTrigger = "startup" | "scheduled";

const DEFAULT_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SECRET_KEYS = [
  "BINANCE_API_KEY",
  "BINANCE_SECRET_KEY",
  "VTPASS_API_KEY",
  "VTPASS_PUBLIC_KEY",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSecretKeys(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_SECRET_KEYS];
  const keys = raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  return keys.length > 0 ? keys : [...DEFAULT_SECRET_KEYS];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ProviderSecretRotationServiceOptions = {
  secretManagerUrl?: string;
  secretManagerToken?: string;
  secretKeys?: string[];
  rotationIntervalMs?: number;
  requestTimeoutMs?: number;
};

export class ProviderSecretRotationService {
  private readonly secretManagerUrl: string | undefined;
  private readonly secretManagerToken: string | undefined;
  private readonly secretKeys: string[];
  private readonly rotationIntervalMs: number;
  private readonly requestTimeoutMs: number;

  private isRunning = false;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ProviderSecretRotationServiceOptions = {}) {
    this.secretManagerUrl =
      options.secretManagerUrl ??
      process.env.API_PROVIDER_SECRET_MANAGER_URL?.trim();
    this.secretManagerToken =
      options.secretManagerToken ??
      process.env.API_PROVIDER_SECRET_MANAGER_TOKEN?.trim();
    this.secretKeys =
      options.secretKeys ?? parseSecretKeys(process.env.API_PROVIDER_SECRET_KEYS);
    this.rotationIntervalMs =
      options.rotationIntervalMs ?? DEFAULT_ROTATION_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private extractSecrets(payload: unknown): Record<string, unknown> {
    if (!isRecord(payload)) {
      throw new Error("Secret manager response must be a JSON object");
    }

    if (Array.isArray(payload.secrets)) {
      const mappedSecrets: Record<string, string> = {};

      for (const secretEntry of payload.secrets) {
        if (!isRecord(secretEntry)) {
          continue;
        }

        const keyName =
          typeof secretEntry.name === "string" ? secretEntry.name.trim() : "";
        if (!keyName) {
          continue;
        }

        const resolvedValueCandidates = [
          secretEntry.computed,
          secretEntry.value,
          secretEntry.raw,
        ];

        const resolvedValue = resolvedValueCandidates.find(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        );

        if (resolvedValue) {
          mappedSecrets[keyName] = resolvedValue.trim();
        }
      }

      if (Object.keys(mappedSecrets).length > 0) {
        return mappedSecrets;
      }
    }

    if (isRecord(payload.secrets)) {
      return payload.secrets;
    }

    if (isRecord(payload.data)) {
      const nestedData = payload.data;
      if (isRecord(nestedData.data)) {
        return nestedData.data;
      }
      return nestedData;
    }

    return payload;
  }

  private async fetchLatestSecrets(): Promise<Record<string, string>> {
    if (!this.secretManagerUrl) {
      throw new Error("API provider secret manager URL is not configured");
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.secretManagerToken) {
      headers.Authorization = `Bearer ${this.secretManagerToken}`;
      headers["X-Vault-Token"] = this.secretManagerToken;
    }

    const response = await axios.get(this.secretManagerUrl, {
      headers,
      timeout: this.requestTimeoutMs,
    });

    const source = this.extractSecrets(response.data);
    const fetched: Record<string, string> = {};

    for (const key of this.secretKeys) {
      const value = source[key];
      if (typeof value === "string" && value.trim().length > 0) {
        fetched[key] = value.trim();
      }
    }

    return fetched;
  }

  private applySecrets(secrets: Record<string, string>): {
    updated: number;
    unchanged: number;
    missing: number;
  } {
    let updated = 0;
    let unchanged = 0;
    let missing = 0;

    for (const key of this.secretKeys) {
      const nextValue = secrets[key];
      if (!nextValue) {
        missing += 1;
        continue;
      }

      if (process.env[key] === nextValue) {
        unchanged += 1;
        continue;
      }

      process.env[key] = nextValue;
      updated += 1;
    }

    return { updated, unchanged, missing };
  }

  async rotateOnce(trigger: RotationTrigger): Promise<void> {
    if (!this.secretManagerUrl) {
      return;
    }

    try {
      const latestSecrets = await this.fetchLatestSecrets();
      const result = this.applySecrets(latestSecrets);

      logger.info(
        "[ProviderSecretRotationService] Provider key rotation completed.",
        "ProviderSecretRotationService",
        {
          trigger,
          checkedKeys: this.secretKeys.length,
          updated: result.updated,
          unchanged: result.unchanged,
          missing: result.missing,
          timestamp: new Date().toISOString(),
        },
      );
    } catch (error) {
      logger.warn(
        "[ProviderSecretRotationService] Provider key rotation failed.",
        "ProviderSecretRotationService",
        {
          trigger,
          reason: toErrorMessage(error),
          timestamp: new Date().toISOString(),
        },
      );
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn(
        "[ProviderSecretRotationService] Service is already running.",
        "ProviderSecretRotationService",
      );
      return;
    }

    if (!this.secretManagerUrl) {
      logger.warn(
        "[ProviderSecretRotationService] API_PROVIDER_SECRET_MANAGER_URL not set. Rotation disabled.",
        "ProviderSecretRotationService",
      );
      return;
    }

    this.isRunning = true;
    logger.info(
      "[ProviderSecretRotationService] Service started.",
      "ProviderSecretRotationService",
      {
        rotationIntervalMs: this.rotationIntervalMs,
        checkedKeys: this.secretKeys.length,
      },
    );

    await this.rotateOnce("startup");

    this.rotationTimer = setInterval(() => {
      this.rotateOnce("scheduled").catch(() => undefined);
    }, this.rotationIntervalMs);
  }

  stop(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }

    this.isRunning = false;
  }

  getStatus(): { isRunning: boolean; rotationIntervalMs: number } {
    return {
      isRunning: this.isRunning,
      rotationIntervalMs: this.rotationIntervalMs,
    };
  }
}

export const providerSecretRotationService =
  new ProviderSecretRotationService();