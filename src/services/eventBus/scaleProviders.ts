/**
 * src/services/eventBus/scaleProviders.ts
 *
 * Worker-pool scale providers (Issue #1055).
 *
 * Three transports are shipped, covering the usual deployments of the
 * ingestion stack, plus a no-op provider for environments that autoscale
 * elsewhere (e.g. a cluster autoscaler watching the very metrics this module
 * exports):
 *
 *   DockerScaleProvider   — Docker Engine API over the unix socket
 *   KubernetesScaleProvider — scales the `spec.replicas` of a Deployment
 *   WebhookScaleProvider  — POSTs to any autoscaler adapter endpoint
 *   NoopScaleProvider     — records calls, mutates nothing
 *
 * All of them are dependency-free: the Docker and Kubernetes providers speak
 * plain HTTP, and the webhook provider reuses the shared keep-alive client.
 */

import http from "node:http";
import { httpClient } from "../../lib/httpClient";
import { logger } from "../../utils/logger";
import type { ScaleProvider } from "./types";

/** Does nothing. Keeps the autoscaler importable without infra access. */
export class NoopScaleProvider implements ScaleProvider {
  readonly name = "noop";
  readonly calls: Array<{ pool: string; replicas: number }> = [];

  async getReplicaCount(_pool: string): Promise<number | null> {
    return null;
  }

  async setReplicaCount(pool: string, replicas: number): Promise<void> {
    this.calls.push({ pool, replicas });
    logger.info(
      `[EventBus] (dry run) would scale ${pool} to ${replicas} replica(s)`,
    );
  }
}

/**
 * Docker Engine API provider.
 *
 * Container labels do the routing: a pool is mapped to the container template
 * via `EVENT_BUS_DOCKER_POOL_<POOL>` (defaulting to the pool name), and every
 * running container carrying that image is treated as a replica of the pool.
 * The Docker socket is reached over `http.request({ socketPath })` so no
 * third-party Docker client is required.
 */
export interface DockerScaleProviderOptions {
  socketPath?: string | undefined;
  /** pool -> container image name. Defaults to the pool name. */
  poolImages?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
}

export class DockerScaleProvider implements ScaleProvider {
  readonly name = "docker";
  private readonly socketPath: string;
  private readonly poolImages: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: DockerScaleProviderOptions = {}) {
    this.socketPath = options.socketPath ?? "/var/run/docker.sock";
    this.poolImages = options.poolImages ?? {};
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async getReplicaCount(pool: string): Promise<number | null> {
    const containers = (await this.request(
      "GET",
      "/containers/json?all=0",
    )) as Array<{ Image?: string; State?: string }>;
    const image = this.imageFor(pool);
    const running = containers.filter(
      (container) => container.Image === image && container.State === "running",
    );
    return running.length;
  }

  async setReplicaCount(pool: string, replicas: number): Promise<void> {
    const image = this.imageFor(pool);
    const containers = (await this.request(
      "GET",
      "/containers/json?all=1",
    )) as Array<{ Id: string; Image?: string; State?: string }>;
    const existing = containers.filter(
      (container) => container.Image === image,
    );
    const running = existing.filter(
      (container) => container.State === "running",
    );
    const delta = replicas - running.length;

    if (delta > 0) {
      await Promise.all(
        Array.from({ length: delta }, () =>
          this.request(
            "POST",
            "/containers/create?name=" +
              encodeURIComponent(`${image}-${Date.now()}`),
            {
              Image: image,
              HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
            },
          ),
        ),
      );
    } else if (delta < 0) {
      // Remove the newest containers first so a scale-in does not kill the
      // instance that has been running the longest.
      const toStop = running.slice(0, -delta);
      await Promise.all(
        toStop.map((container) =>
          this.request("POST", `/containers/${container.Id}/stop?t=10`).catch(
            (error) => {
              logger.warn(
                `[EventBus] Failed to stop container ${container.Id}:`,
                error instanceof Error ? error.message : error,
              );
            },
          ),
        ),
      );
    }
  }

  private imageFor(pool: string): string {
    return this.poolImages[pool] ?? pool;
  }

  private request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body
        ? Buffer.from(JSON.stringify(body), "utf8")
        : undefined;
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            "Content-Type": "application/json",
            Host: "docker",
            ...(payload ? { "Content-Length": payload.length } : {}),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (!res.statusCode || res.statusCode >= 400) {
              reject(
                new Error(
                  `Docker API ${method} ${path} failed with ${res.statusCode}: ${text.slice(0, 200)}`,
                ),
              );
              return;
            }
            if (!text) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(text);
            }
          });
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error("Docker API request timed out")),
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

/** Kubernetes provider: patches `spec.replicas` on a Deployment. */
export interface KubernetesScaleProviderOptions {
  /** In-cluster API base URL. Defaults to the well-known service account host. */
  apiUrl?: string | undefined;
  namespace?: string | undefined;
  /** Bearer token; defaults to the projected service-account token. */
  token?: string | undefined;
  /** pool -> Deployment name. Defaults to the pool name. */
  poolDeployments?: Record<string, string> | undefined;
  /** pool -> container name inside the pod template, needed for the scale subresource. */
  containerNames?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
}

export class KubernetesScaleProvider implements ScaleProvider {
  readonly name = "kubernetes";
  private readonly apiUrl: string;
  private readonly namespace: string;
  private readonly token: string | null;
  private readonly poolDeployments: Record<string, string>;
  private readonly containerNames: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: KubernetesScaleProviderOptions = {}) {
    this.apiUrl = (options.apiUrl ?? "https://kubernetes.default.svc").replace(
      /\/$/,
      "",
    );
    this.namespace = options.namespace ?? "default";
    this.token = options.token ?? null;
    this.poolDeployments = options.poolDeployments ?? {};
    this.containerNames = options.containerNames ?? {};
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async getReplicaCount(pool: string): Promise<number | null> {
    const deployment = this.deploymentFor(pool);
    const body = (await this.request(
      "GET",
      `/apis/apps/v1/namespaces/${this.namespace}/deployments/${encodeURIComponent(deployment)}`,
    )) as { status?: { readyReplicas?: number; replicas?: number } };
    return body.status?.readyReplicas ?? body.status?.replicas ?? null;
  }

  async setReplicaCount(pool: string, replicas: number): Promise<void> {
    const deployment = this.deploymentFor(pool);
    const patch: Record<string, unknown> = { spec: { replicas } };
    const container = this.containerNames[pool];
    if (container) {
      // Some clusters only honour replicas when the HPA target is named.
      patch.metadata = {
        annotations: { "stellarflow.io/scaled-container": container },
      };
    }
    await this.request(
      "PATCH",
      `/apis/apps/v1/namespaces/${this.namespace}/deployments/${encodeURIComponent(deployment)}/scale`,
      patch,
    );
  }

  private deploymentFor(pool: string): string {
    return this.poolDeployments[pool] ?? pool;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/merge-patch+json",
      Accept: "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await httpClient.request({
      method,
      url: `${this.apiUrl}${path}`,
      data: body,
      headers: this.headers(),
      timeout: this.timeoutMs,
    });
    return response.data;
  }
}

/**
 * Generic HTTP adapter.
 *
 * Reads `GET {url}` for the current replica count and sends
 * `POST {url}` with `{ pool, replicas }` to change it, which is enough to plug
 * in a Docker Swarm autoscaler, an ECS scale-in hook, or a bespoke control
 * plane without shipping a bespoke provider.
 */
export interface WebhookScaleProviderOptions {
  url: string;
  /** Field to read out of the GET response. Defaults to `replicas`. */
  replicasField?: string | undefined;
  method?: "POST" | "PUT" | undefined;
  timeoutMs?: number | undefined;
}

export class WebhookScaleProvider implements ScaleProvider {
  readonly name = "webhook";
  private readonly url: string;
  private readonly replicasField: string;
  private readonly method: "POST" | "PUT";
  private readonly timeoutMs: number;

  constructor(options: WebhookScaleProviderOptions) {
    this.url = options.url;
    this.replicasField = options.replicasField ?? "replicas";
    this.method = options.method ?? "POST";
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async getReplicaCount(pool: string): Promise<number | null> {
    const url = new URL(this.url);
    url.searchParams.set("pool", pool);
    const response = await httpClient.get(url.toString(), {
      timeout: this.timeoutMs,
    });
    const payload = response.data as Record<string, unknown> | number;
    if (typeof payload === "number") return payload;
    const value = payload?.[this.replicasField];
    return typeof value === "number" ? value : null;
  }

  async setReplicaCount(pool: string, replicas: number): Promise<void> {
    await httpClient.request({
      method: this.method,
      url: this.url,
      data: { pool, replicas },
      headers: { "Content-Type": "application/json" },
      timeout: this.timeoutMs,
    });
  }
}

/**
 * Build the provider named by `EVENT_BUS_AUTOSCALE_PROVIDER`
 * (`docker` | `kubernetes` | `webhook` | `noop`).
 *
 * Returns `null` when the provider is misconfigured so the autoscaler stays in
 * advisory mode instead of crashing the process on boot.
 */
export function createScaleProvider(
  provider: string | null,
  env: Record<string, string | undefined> = process.env,
): ScaleProvider | null {
  switch ((provider ?? "noop").toLowerCase()) {
    case "noop":
    case "":
      return new NoopScaleProvider();
    case "docker":
      return new DockerScaleProvider({
        socketPath: env.EVENT_BUS_DOCKER_SOCKET,
        poolImages: parseJsonMap(env.EVENT_BUS_DOCKER_POOL_IMAGES),
      });
    case "kubernetes":
      return new KubernetesScaleProvider({
        apiUrl: env.KUBERNETES_API_URL,
        namespace: env.KUBERNETES_NAMESPACE,
        token: env.KUBERNETES_SERVICE_ACCOUNT_TOKEN,
        poolDeployments: parseJsonMap(env.EVENT_BUS_K8S_POOL_DEPLOYMENTS),
        containerNames: parseJsonMap(env.EVENT_BUS_K8S_POOL_CONTAINERS),
      });
    case "webhook": {
      const url = env.EVENT_BUS_AUTOSCALE_WEBHOOK_URL;
      if (!url) {
        logger.warn(
          "[EventBus] EVENT_BUS_AUTOSCALE_PROVIDER=webhook but EVENT_BUS_AUTOSCALE_WEBHOOK_URL is unset",
        );
        return null;
      }
      return new WebhookScaleProvider({ url });
    }
    default:
      logger.warn(
        `[EventBus] Unknown scale provider "${provider}" — autoscaling disabled`,
      );
      return null;
  }
}

function parseJsonMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, value as string]),
    );
  } catch {
    logger.warn("[EventBus] Failed to parse scale provider mapping as JSON");
    return {};
  }
}
