import { describe, it, expect } from "@jest/globals";
import {
  SorobanStateRootInspectorWorker,
  type SecurityAlert,
  type StateRootInspection,
} from "../src/services/sorobanStateRootInspectorWorker";

const NOW = new Date("2026-09-29T12:00:00.000Z");

function buildWorker(options: {
  networkRoot?: string;
  networkThrows?: boolean;
  localRoot?: string | null;
  alertSink?: (alert: SecurityAlert) => void;
}) {
  const inspections: StateRootInspection[] = [];
  const worker = new SorobanStateRootInspectorWorker({
    fetchNetworkStateRoot: async () => {
      if (options.networkThrows) throw new Error("rpc unavailable");
      return { stateRoot: options.networkRoot ?? "abc", ledgerSequence: 4242 };
    },
    getLocalStateRoot: async () => options.localRoot ?? null,
    ...(options.alertSink ? { alertSink: options.alertSink } : {}),
    intervalMs: 60_000,
    now: () => NOW,
  });
  return { worker, inspections };
}

describe("SorobanStateRootInspectorWorker (Issue #1067)", () => {
  it("reports a match when the local root equals the ledger root", async () => {
    const { worker } = buildWorker({ networkRoot: "abc123", localRoot: "abc123" });
    const result = await worker.inspectOnce();

    expect(result.matched).toBe(true);
    expect(result.reason).toBe("MATCH");
    expect(result.ledgerSequence).toBe(4242);
    expect(result.networkStateRoot).toBe("abc123");
    expect(result.localStateRoot).toBe("abc123");
  });

  it("normalizes hex prefixes and casing before comparing", async () => {
    const { worker } = buildWorker({ networkRoot: "0xABC123", localRoot: "abc123" });
    const result = await worker.inspectOnce();
    expect(result.matched).toBe(true);
  });

  it("raises a critical security alert on root mismatch", async () => {
    const alerts: SecurityAlert[] = [];
    const { worker } = buildWorker({
      networkRoot: "aaaa",
      localRoot: "bbbb",
      alertSink: (alert) => {
        alerts.push(alert);
      },
    });

    const result = await worker.inspectOnce();

    expect(result.matched).toBe(false);
    expect(result.reason).toBe("ROOT_MISMATCH");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.type).toBe("state_root_mismatch");
    expect(alerts[0]?.severity).toBe("critical");
    expect(alerts[0]?.networkStateRoot).toBe("aaaa");
    expect(alerts[0]?.localStateRoot).toBe("bbbb");
  });

  it("does not alert when the local state root is unavailable", async () => {
    const alerts: SecurityAlert[] = [];
    const { worker } = buildWorker({
      networkRoot: "aaaa",
      localRoot: null,
      alertSink: (alert) => {
        alerts.push(alert);
      },
    });

    const result = await worker.inspectOnce();
    expect(result.reason).toBe("LOCAL_STATE_UNAVAILABLE");
    expect(alerts).toHaveLength(0);
  });

  it("reports network unavailability without alerting", async () => {
    const alerts: SecurityAlert[] = [];
    const { worker } = buildWorker({
      networkThrows: true,
      alertSink: (alert) => {
        alerts.push(alert);
      },
    });

    const result = await worker.inspectOnce();
    expect(result.reason).toBe("NETWORK_STATE_UNAVAILABLE");
    expect(result.error).toContain("rpc unavailable");
    expect(alerts).toHaveLength(0);
  });

  it("tracks lifecycle and heartbeats", async () => {
    const { worker } = buildWorker({ networkRoot: "abc", localRoot: "abc" });
    expect(worker.isRunning()).toBe(false);
    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.stop();
    expect(worker.isRunning()).toBe(false);
    expect(worker.getHeartbeatTimeoutMs()).toBe(180_000);
  });

  it("stores the last inspection snapshot", async () => {
    const { worker } = buildWorker({ networkRoot: "abc", localRoot: "abc" });
    await worker.inspectOnce();
    expect(worker.getLastInspection()?.matched).toBe(true);
    expect(worker.getLastHeartbeatAt()).toBe(NOW.getTime());
  });
});
