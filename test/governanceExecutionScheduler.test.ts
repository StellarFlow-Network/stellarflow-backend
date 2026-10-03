import { describe, expect, it } from "@jest/globals";
import {
  GovernanceExecutionScheduler,
  type MaintenanceWindow,
} from "../src/services/governanceExecutionScheduler";

describe("GovernanceExecutionScheduler", () => {
  it("moves an execution request outside a maintenance blackout window", () => {
    const scheduler = new GovernanceExecutionScheduler();
    const blackout: MaintenanceWindow[] = [
      {
        start: new Date("2026-09-30T02:00:00.000Z"),
        end: new Date("2026-09-30T04:00:00.000Z"),
        reason: "protocol-maintenance",
      },
    ];

    const slot = scheduler.findNextAvailableSlot(
      new Date("2026-09-30T03:15:00.000Z"),
      blackout,
      30,
    );

    expect(slot.start.toISOString()).toBe("2026-09-30T04:00:00.000Z");
    expect(slot.end.toISOString()).toBe("2026-09-30T04:30:00.000Z");
    expect(slot.blockedByMaintenance).toBe(true);
  });

  it("stores a scheduled proposal task in a Redis queue when a client is supplied", async () => {
    const entries: string[] = [];
    const fakeRedis = {
      lPush: async (key: string, value: string) => {
        entries.push(`${key}:${value}`);
        return 1;
      },
    } as any;

    const scheduler = new GovernanceExecutionScheduler(fakeRedis);
    const task = await scheduler.scheduleProposalExecution({
      proposalId: "prop-9001",
      scheduledFor: new Date("2026-09-30T05:00:00.000Z"),
      maintenanceWindows: [
        {
          start: new Date("2026-09-30T02:00:00.000Z"),
          end: new Date("2026-09-30T04:00:00.000Z"),
          reason: "protocol-maintenance",
        },
      ],
    });

    expect(task.proposalId).toBe("prop-9001");
    expect(task.scheduledFor.toISOString()).toBe("2026-09-30T05:00:00.000Z");
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain("governance:execution:queue");
  });
});
