/**
 * src/services/eventBus/eventBusMetrics.ts
 *
 * Prometheus instrumentation for the internal event bus (Issue #1055).
 *
 * Exported series:
 *
 *   event_bus_queue_pending_messages      gauge  backlog per queue
 *   event_bus_queue_unacked_messages      gauge  delivered-but-unacked per queue
 *   event_bus_queue_consumers             gauge  live consumers per queue
 *   event_bus_queue_backlog_ratio         gauge  backlog / alert threshold
 *   event_bus_queue_oldest_message_age_seconds  gauge  head-of-line age
 *   event_bus_queue_total_pending_messages    gauge  aggregate backlog
 *   event_bus_queue_probes_total          counter probe outcomes
 *   event_bus_queue_probe_failures_total  counter probe failures
 *   event_bus_backpressure_alerts_total   counter notifications, by kind
 *   event_bus_autoscaler_actions_total    counter scale actions, by action
 *   event_bus_autoscaler_replicas         gauge  current/desired replicas per pool
 *   event_bus_backpressure_severity       gauge  0/1/2 level per scope
 *
 * Ratios and severities are included on purpose: they are the series an alert
 * rule should be written against, so a threshold change does not require
 * rewriting the recording rules.
 */

import { Counter, Gauge } from "prom-client";
import { register } from "../../middleware/metrics";
import { UNKNOWN_DEPTH } from "./queueDepthCollector";
import type {
  AutoscalerEvaluation,
  BackpressureAlert,
  BackpressureEvaluation,
  QueueDepthSample,
  ScaleAction,
} from "./types";

const QUEUE_LABELS = ["queue", "pool", "transport"] as const;
const SCOPE_LABELS = ["scope"] as const;

export const queuePendingMessages = new Gauge({
  name: "event_bus_queue_pending_messages",
  help: "Messages waiting in an event bus queue (backlog)",
  labelNames: QUEUE_LABELS,
  registers: [register],
});

export const queueUnackedMessages = new Gauge({
  name: "event_bus_queue_unacked_messages",
  help: "Messages delivered to a worker but not yet acknowledged",
  labelNames: QUEUE_LABELS,
  registers: [register],
});

export const queueConsumers = new Gauge({
  name: "event_bus_queue_consumers",
  help: "Consumers currently attached to an event bus queue",
  labelNames: QUEUE_LABELS,
  registers: [register],
});

export const queueBacklogRatio = new Gauge({
  name: "event_bus_queue_backlog_ratio",
  help: "Queue backlog divided by its backpressure alert threshold (>= 1 means alerting)",
  labelNames: QUEUE_LABELS,
  registers: [register],
});

export const queueOldestMessageAge = new Gauge({
  name: "event_bus_queue_oldest_message_age_seconds",
  help: "Age in seconds of the oldest message waiting in an event bus queue",
  labelNames: QUEUE_LABELS,
  registers: [register],
});

export const totalPendingMessages = new Gauge({
  name: "event_bus_queue_total_pending_messages",
  help: "Sum of the backlog across every watched event bus queue",
  labelNames: ["environment"],
  registers: [register],
});

export const queueProbesTotal = new Counter({
  name: "event_bus_queue_probes_total",
  help: "Queue depth probes executed, by transport and outcome",
  labelNames: ["transport", "outcome"],
  registers: [register],
});

export const queueProbeFailuresTotal = new Counter({
  name: "event_bus_queue_probe_failures_total",
  help: "Queue depth probes that failed, by queue",
  labelNames: ["queue", "transport"],
  registers: [register],
});

export const backpressureAlertsTotal = new Counter({
  name: "event_bus_backpressure_alerts_total",
  help: "Backpressure notifications emitted, by kind and level",
  labelNames: ["kind", "level"],
  registers: [register],
});

export const backpressureSeverity = new Gauge({
  name: "event_bus_backpressure_severity",
  help: "Backpressure level per scope: 0 = ok, 1 = warning, 2 = critical",
  labelNames: SCOPE_LABELS,
  registers: [register],
});

export const autoscalerActionsTotal = new Counter({
  name: "event_bus_autoscaler_actions_total",
  help: "Autoscaler scale actions taken, by action",
  labelNames: ["action"],
  registers: [register],
});

export const autoscalerReplicas = new Gauge({
  name: "event_bus_autoscaler_replicas",
  help: "Worker replicas per pool, labelled by role (current/desired)",
  labelNames: ["pool", "role"],
  registers: [register],
});

export const autoscalerDesiredReplicas = new Gauge({
  name: "event_bus_autoscaler_desired_replicas",
  help: "Worker replicas the autoscaler wants for a pool, regardless of cooldown",
  labelNames: ["pool"],
  registers: [register],
});

function labelSet(sample: QueueDepthSample) {
  return { queue: sample.name, pool: sample.pool, transport: sample.transport };
}

/** Publish one collection cycle worth of queue samples. */
export function recordQueueSamples(
  samples: QueueDepthSample[],
  totalPending: number,
  thresholds: Map<string, number>,
  environment = process.env.NODE_ENV || "development",
): void {
  for (const sample of samples) {
    const labels = labelSet(sample);
    const failed = sample.pending === UNKNOWN_DEPTH;

    queueProbesTotal.inc({
      transport: sample.transport,
      outcome: failed ? "failure" : "success",
    });

    if (failed) {
      queueProbeFailuresTotal.inc({
        queue: sample.name,
        transport: sample.transport,
      });
      // Keep the backlog gauge at 0 rather than -1 so absent data is not
      // mistaken for a real negative backlog by alerting rules.
      queuePendingMessages.set(labels, 0);
      queueBacklogRatio.set(labels, 0);
      continue;
    }

    queuePendingMessages.set(labels, sample.pending);
    if (sample.unacked !== null)
      queueUnackedMessages.set(labels, sample.unacked);
    if (sample.consumers !== null) queueConsumers.set(labels, sample.consumers);
    if (sample.oldestPendingAgeSeconds !== null) {
      queueOldestMessageAge.set(labels, sample.oldestPendingAgeSeconds);
    }

    const threshold = thresholds.get(sample.name);
    if (threshold && threshold > 0) {
      queueBacklogRatio.set(labels, sample.pending / threshold);
    }
  }

  totalPendingMessages.set({ environment }, totalPending);
}

const SEVERITY_VALUE = { ok: 0, warning: 1, critical: 2 } as const;

/** Publish the bot's verdict for one cycle. */
export function recordBackpressureEvaluation(
  evaluation: BackpressureEvaluation,
): void {
  for (const [scope, level] of Object.entries(evaluation.levels)) {
    backpressureSeverity.set({ scope }, SEVERITY_VALUE[level]);
  }
  for (const alert of evaluation.alerts) {
    recordBackpressureAlert(alert);
  }
}

export function recordBackpressureAlert(alert: BackpressureAlert): void {
  backpressureAlertsTotal.inc({ kind: alert.kind, level: alert.level });
}

/** Publish the autoscaler's verdict for one cycle. */
export function recordAutoscalerEvaluation(
  evaluation: AutoscalerEvaluation,
): void {
  for (const [pool, replicas] of Object.entries(evaluation.desired)) {
    autoscalerDesiredReplicas.set({ pool }, replicas);
  }
  for (const decision of evaluation.decisions) {
    autoscalerReplicas.set(
      { pool: decision.pool, role: "current" },
      decision.from ?? 0,
    );
    autoscalerReplicas.set(
      { pool: decision.pool, role: "target" },
      decision.to,
    );
    if (decision.action !== "none") {
      autoscalerActionsTotal.inc({
        action: decision.action satisfies ScaleAction,
      });
    }
  }
}

/** Forget every series for a queue that is no longer watched. */
export function clearQueueSeries(queueName: string): void {
  queuePendingMessages.remove({ queue: queueName });
  queueUnackedMessages.remove({ queue: queueName });
  queueConsumers.remove({ queue: queueName });
  queueBacklogRatio.remove({ queue: queueName });
  queueOldestMessageAge.remove({ queue: queueName });
}
