export interface MaintenanceWindow {
  start: Date;
  end: Date;
  reason?: string;
}

export interface ExecutionAvailabilityWindow {
  start: Date;
  end: Date;
  blockedByMaintenance: boolean;
  reason?: string;
  maintenanceWindow?: MaintenanceWindow;
}

export interface ScheduledProposalExecution {
  proposalId: string;
  scheduledFor: Date;
  executionWindow: ExecutionAvailabilityWindow;
  maintenanceWindows: MaintenanceWindow[];
  queueKey: string;
  createdAt: Date;
}

export interface RedisQueueClient {
  lPush(key: string, value: string): Promise<unknown> | unknown;
}

export interface ScheduleProposalExecutionInput {
  proposalId: string;
  scheduledFor: Date;
  maintenanceWindows?: MaintenanceWindow[];
  durationMinutes?: number;
  queueKey?: string;
  redisClient?: RedisQueueClient | null;
}

export class GovernanceExecutionScheduler {
  constructor(private readonly redisClient?: RedisQueueClient | null) {}

  findNextAvailableSlot(
    requestedAt: Date,
    maintenanceWindows: MaintenanceWindow[],
    durationMinutes = 30,
  ): ExecutionAvailabilityWindow {
    const normalizedWindows = [...maintenanceWindows]
      .filter(
        (window) =>
          window && window.start instanceof Date && window.end instanceof Date,
      )
      .sort((left, right) => left.start.getTime() - right.start.getTime());

    const durationMs = durationMinutes * 60 * 1000;
    let candidateStart = new Date(requestedAt);
    let candidateEnd = new Date(candidateStart.getTime() + durationMs);
    let blockedByMaintenance = false;
    let matchedWindow: MaintenanceWindow | undefined;

    while (true) {
      const window = normalizedWindows.find(
        (maintenanceWindow) =>
          candidateStart.getTime() < maintenanceWindow.end.getTime() &&
          candidateEnd.getTime() > maintenanceWindow.start.getTime(),
      );

      if (!window) {
        return {
          start: candidateStart,
          end: candidateEnd,
          blockedByMaintenance,
          reason: matchedWindow?.reason,
          maintenanceWindow: matchedWindow,
        };
      }

      blockedByMaintenance = true;
      matchedWindow = window;
      const nextStart = new Date(Math.max(candidateStart.getTime(), window.end.getTime()));
      candidateStart = nextStart;
      candidateEnd = new Date(candidateStart.getTime() + durationMs);
    }
  }

  async scheduleProposalExecution(
    input: ScheduleProposalExecutionInput,
  ): Promise<ScheduledProposalExecution> {
    const maintenanceWindows = input.maintenanceWindows ?? [];
    const durationMinutes = input.durationMinutes ?? 30;
    const queueKey = input.queueKey ?? "governance:execution:queue";
    const executionWindow = this.findNextAvailableSlot(
      input.scheduledFor,
      maintenanceWindows,
      durationMinutes,
    );

    const task: ScheduledProposalExecution = {
      proposalId: input.proposalId,
      scheduledFor: executionWindow.start,
      executionWindow,
      maintenanceWindows,
      queueKey,
      createdAt: new Date(),
    };

    if (this.redisClient && typeof this.redisClient.lPush === "function") {
      await this.redisClient.lPush(queueKey, JSON.stringify(task));
    }

    return task;
  }
}

export default GovernanceExecutionScheduler;
