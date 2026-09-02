import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

import { createHealthRouter } from "../src/routes/health";
import type { ReadinessReport } from "../src/services/healthProbeService";

describe("health probe routes", () => {
  let server: Server;
  let baseUrl: string;
  let report: ReadinessReport;

  beforeEach(async () => {
    report = {
      ready: true,
      timestamp: "2026-08-26T00:00:00.000Z",
      checks: { database: true, redis: true, rpc: true },
      errors: {},
    };
    const app = express();
    app.use(
      "/health",
      createHealthRouter(async () => report),
    );
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 on liveness without probing dependencies", async () => {
    const res = await globalThis.fetch(`${baseUrl}/health/liveness`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; status: string };
    expect(body.success).toBe(true);
    expect(body.status).toBe("ok");
  });

  it("returns 200 when readiness probes pass", async () => {
    const res = await globalThis.fetch(`${baseUrl}/health/readiness`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      checks: Record<string, boolean>;
    };
    expect(body.success).toBe(true);
    expect(body.checks.database).toBe(true);
  });

  it("returns HTTP 530 when a core dependency fails", async () => {
    report = {
      ready: false,
      timestamp: "2026-08-26T00:00:00.000Z",
      checks: { database: true, redis: false, rpc: true },
      errors: { redis: "Redis client is not connected" },
    };

    const res = await globalThis.fetch(`${baseUrl}/health/readiness`);
    expect(res.status).toBe(530);
    const body = (await res.json()) as {
      success: boolean;
      error: { code: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
  });
});
