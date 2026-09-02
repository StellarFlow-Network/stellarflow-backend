import { jest } from "@jest/globals";
import {
  SystemHealthWatchdog,
  WATCHDOG_POLL_INTERVAL_MS,
} from "../src/services/systemHealthWatchdog";

describe("SystemHealthWatchdog", () => {
  it("polls Horizon, Soroban, and database probes and reports healthy state", async () => {
    const probes = {
      database: jest.fn().mockResolvedValue(true),
      horizon: jest.fn().mockResolvedValue(true),
      soroban: jest.fn().mockResolvedValue({ status: "healthy" }),
    };
    const sendAlert = jest.fn().mockResolvedValue(true);
    const watchdog = new SystemHealthWatchdog({
      probes,
      notifications: { sendAlert },
    });

    const snapshot = await watchdog.runOnce();

    expect(WATCHDOG_POLL_INTERVAL_MS).toBe(5_000);
    expect(snapshot.status).toBe("healthy");
    expect(Object.keys(snapshot.checks)).toEqual([
      "database",
      "horizon",
      "soroban",
    ]);
    expect(probes.database).toHaveBeenCalledTimes(1);
    expect(probes.horizon).toHaveBeenCalledTimes(1);
    expect(probes.soroban).toHaveBeenCalledTimes(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("marks deep queues degraded and alerts only on degradation transitions", async () => {
    let depth = 81;
    const sendAlert = jest.fn().mockResolvedValue(true);
    const watchdog = new SystemHealthWatchdog({
      probes: {},
      notifications: { sendAlert },
    });
    watchdog.registerQueue({
      name: "ingestion",
      getDepth: () => depth,
      maxHealthyDepth: 80,
    });

    const first = await watchdog.runOnce();
    const repeated = await watchdog.runOnce();
    depth = 20;
    const recovered = await watchdog.runOnce();
    depth = 90;
    await watchdog.runOnce();

    expect(first.status).toBe("degraded");
    expect(first.checks["queue:ingestion"]?.details).toEqual({
      depth: 81,
      maxHealthyDepth: 80,
    });
    expect(repeated.status).toBe("degraded");
    expect(recovered.status).toBe("healthy");
    expect(sendAlert).toHaveBeenCalledTimes(2);
    expect(sendAlert.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        service: "system-health-watchdog:queue:ingestion",
      }),
    );
  });

  it("restarts a stale worker and respects its restart cooldown", async () => {
    let now = 100_000;
    const restart = jest.fn().mockResolvedValue(undefined);
    const sendAlert = jest.fn().mockResolvedValue(true);
    const watchdog = new SystemHealthWatchdog({
      probes: {},
      notifications: { sendAlert },
      now: () => now,
    });
    watchdog.registerWorker({
      name: "prices",
      getLastHeartbeatAt: () => 80_000,
      heartbeatTimeoutMs: 10_000,
      restartCooldownMs: 30_000,
      restart,
    });

    const first = await watchdog.runOnce();
    now += 5_000;
    const second = await watchdog.runOnce();

    expect(first.checks["worker:prices"]?.status).toBe("degraded");
    expect(first.checks["worker:prices"]?.details?.restarted).toBe(true);
    expect(
      second.checks["worker:prices"]?.details?.restartSuppressedByCooldown,
    ).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it("times out an unresponsive connection probe", async () => {
    const watchdog = new SystemHealthWatchdog({
      probes: { horizon: () => new Promise(() => undefined) },
      notifications: { sendAlert: jest.fn().mockResolvedValue(true) },
      probeTimeoutMs: 5,
    });

    const snapshot = await watchdog.runOnce();

    expect(snapshot.status).toBe("degraded");
    expect(snapshot.checks.horizon?.message).toContain("timed out");
  });
});
