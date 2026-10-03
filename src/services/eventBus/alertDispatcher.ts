/**
 * src/services/eventBus/alertDispatcher.ts
 *
 * Slack + PagerDuty delivery for the queue backpressure bot (Issue #1055).
 *
 * Routing:
 *
 *   warning  → Slack only
 *   critical → Slack **and** a PagerDuty Events API v2 `trigger`, so the
 *              on-call rotation is actually woken up
 *   resolve  → PagerDuty `resolve` (closing the incident) + a Slack note
 *
 * PagerDuty is keyed by a deterministic `dedup_key` per scope, so repeated
 * cycles update a single incident instead of opening new ones, and a resolve
 * always matches the trigger that opened it.
 *
 * Both transports are optional: with no webhook/routing key configured the
 * dispatcher degrades to logging, which is what local dev and CI want.
 */

import { logger } from "../../utils/logger";
import { createTimeoutSignal } from "../../utils/httpTimeout";
import type { AlertDispatcher, BackpressureAlert } from "./types";

const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

export interface EventBusAlertDispatcherOptions {
  slackWebhookUrl?: string | null | undefined;
  pagerdutyRoutingKey?: string | null | undefined;
  /** Defaults to `true`; set false to evaluate without emitting anything. */
  enabled?: boolean | undefined;
  source?: string | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

export class EventBusAlertDispatcher implements AlertDispatcher {
  private readonly slackWebhookUrl: string | null;
  private readonly pagerdutyRoutingKey: string | null;
  private readonly enabled: boolean;
  private readonly source: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: EventBusAlertDispatcherOptions) {
    this.slackWebhookUrl = options.slackWebhookUrl ?? null;
    this.pagerdutyRoutingKey = options.pagerdutyRoutingKey ?? null;
    this.enabled = options.enabled ?? true;
    this.source = options.source ?? "stellarflow-event-bus";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  /** Slack is wired when a webhook URL is configured. */
  get hasSlack(): boolean {
    return Boolean(this.slackWebhookUrl);
  }

  /** PagerDuty is wired when a routing key is configured. */
  get hasPagerduty(): boolean {
    return Boolean(this.pagerdutyRoutingKey);
  }

  async trigger(alert: BackpressureAlert): Promise<void> {
    if (!this.enabled) return;
    const headline =
      alert.level === "critical"
        ? "CRITICAL queue backlog"
        : "Queue backlog above threshold";
    const message = this.describe(alert, headline);

    if (this.slackWebhookUrl) {
      await this.postSlack(this.slackWebhookUrl, {
        text: message,
        blocks: this.slackBlocks(alert, headline),
      });
    }
    if (alert.level === "critical" && this.pagerdutyRoutingKey) {
      await this.postPagerduty(this.pagerdutyRoutingKey, {
        event_action: "trigger",
        dedup_key: dedupKey(alert),
        payload: {
          summary: `${headline}: ${alert.scope} holds ${alert.pending} unhandled messages`,
          source: this.source,
          severity: "critical",
          timestamp: this.timestampOf(alert),
          component: alert.pool ?? alert.scope,
          group: "queue-backpressure",
          class: alert.scope,
          custom_details: this.customDetails(alert),
        },
      });
    }
    if (!this.slackWebhookUrl && !this.hasPagerdutyFor(alert)) {
      logger.warn(
        `[EventBus] ${message} (no Slack webhook or PagerDuty routing key configured)`,
      );
    }
  }

  async resolve(alert: BackpressureAlert): Promise<void> {
    if (!this.enabled) return;
    const message = `Queue backlog resolved: ${alert.scope} is back to ${alert.pending} unhandled messages (threshold ${alert.threshold}).`;

    if (this.slackWebhookUrl) {
      await this.postSlack(this.slackWebhookUrl, {
        text: `:white_check_mark: ${message}`,
      });
    }
    if (this.pagerdutyRoutingKey) {
      await this.postPagerduty(this.pagerdutyRoutingKey, {
        event_action: "resolve",
        dedup_key: dedupKey(alert),
        payload: {
          summary: message,
          source: this.source,
          timestamp: this.timestampOf(alert),
        },
      });
    }
    if (!this.slackWebhookUrl && !this.pagerdutyRoutingKey) {
      logger.info(`[EventBus] ${message}`);
    }
  }

  private hasPagerdutyFor(alert: BackpressureAlert): boolean {
    return alert.level === "critical" && this.hasPagerduty;
  }

  /** PagerDuty rejects a non-ISO timestamp, so fall back to "now". */
  private timestampOf(alert: BackpressureAlert): string {
    return Number.isNaN(Date.parse(alert.observedAt))
      ? new Date(this.now()).toISOString()
      : alert.observedAt;
  }

  private describe(alert: BackpressureAlert, headline: string): string {
    const top = alert.queues.slice(0, 3);
    const breakdown = top
      .map((queue) => `${queue.name}=${queue.pending}`)
      .join(", ");
    const extra = alert.queues.length > top.length ? ", …" : "";
    return (
      `${headline} — ${alert.scope} holds ${alert.pending} unhandled messages ` +
      `(${alert.overshootPercent}% of the ${alert.threshold} threshold` +
      (alert.criticalThreshold > alert.threshold
        ? `, critical at ${alert.criticalThreshold}`
        : "") +
      `). Worst queues: ${breakdown}${extra}.` +
      (alert.probeErrors.length > 0
        ? ` Probe errors: ${alert.probeErrors.join("; ")}.`
        : "")
    );
  }

  private slackBlocks(
    alert: BackpressureAlert,
    headline: string,
  ): Array<Record<string, unknown>> {
    const fields = [
      { type: "mrkdwn", text: `*Scope*\n${alert.scope}` },
      { type: "mrkdwn", text: `*Backlog*\n${alert.pending}` },
      { type: "mrkdwn", text: `*Threshold*\n${alert.threshold}` },
      {
        type: "mrkdwn",
        text: `*Desired replicas*\n${alert.desiredReplicas ?? "n/a"}`,
      },
    ];
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${alert.level === "critical" ? "🚨" : "⚠️"} ${headline}: ${alert.scope}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: this.describe(alert, headline) },
      },
      { type: "section", fields },
      ...(alert.queues.length > 0
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Queue breakdown*\n${alert.queues
                  .slice(0, 10)
                  .map(
                    (queue) =>
                      `• \`${queue.name}\` — ${queue.pending} pending, ` +
                      `${queue.consumers ?? "?"} consumer(s), ` +
                      `${queue.unacked ?? "?"} unacked`,
                  )
                  .join("\n")}`,
              },
            },
          ]
        : []),
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*Level*\n${alert.level.toUpperCase()}` },
          { type: "mrkdwn", text: `*Kind*\n${alert.kind}` },
          { type: "mrkdwn", text: `*Time*\n${alert.observedAt}` },
        ],
      },
      ...(alert.probeErrors.length > 0
        ? [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `*Probe errors*\n${alert.probeErrors.join("; ")}`,
                },
              ],
            },
          ]
        : []),
    ];
  }

  private customDetails(alert: BackpressureAlert): Record<string, unknown> {
    return {
      scope: alert.scope,
      pool: alert.pool,
      pending: alert.pending,
      threshold: alert.threshold,
      critical_threshold: alert.criticalThreshold,
      overshoot_percent: alert.overshootPercent,
      desired_replicas: alert.desiredReplicas,
      probe_errors: alert.probeErrors,
      queues: alert.queues,
    };
  }

  private async postSlack(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: createTimeoutSignal(this.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Slack webhook returned ${response.status}`);
      }
    } catch (error) {
      logger.error(
        "[EventBus] Slack notification failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async postPagerduty(
    routingKey: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    try {
      const response = await fetch(PAGERDUTY_EVENTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing_key: routingKey, ...event }),
        signal: createTimeoutSignal(this.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `PagerDuty events API returned ${response.status}: ${(
            await response.text().catch(() => "")
          ).slice(0, 200)}`,
        );
      }
    } catch (error) {
      logger.error(
        "[EventBus] PagerDuty notification failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Deterministic incident key for a scope.
 *
 * Stability matters: a `trigger` and its matching `resolve` must produce the
 * same `dedup_key`, and repeated triggers must collapse into one incident.
 */
export function dedupKey(alert: BackpressureAlert): string {
  return `stellarflow-queue-backpressure-${alert.scope}`;
}

/** Dispatcher used when neither Slack nor PagerDuty is configured. */
export class LoggingAlertDispatcher implements AlertDispatcher {
  async trigger(alert: BackpressureAlert): Promise<void> {
    logger.warn(
      `[EventBus] backpressure ${alert.level} on ${alert.scope}: ${alert.pending} pending (threshold ${alert.threshold})`,
    );
  }

  async resolve(alert: BackpressureAlert): Promise<void> {
    logger.info(
      `[EventBus] backpressure resolved on ${alert.scope}: ${alert.pending} pending`,
    );
  }
}

/**
 * Pick the richest dispatcher the environment supports.
 */
export function createAlertDispatcher(
  options: EventBusAlertDispatcherOptions,
): AlertDispatcher {
  if (options.enabled === false) return new LoggingAlertDispatcher();
  if (!options.slackWebhookUrl && !options.pagerdutyRoutingKey) {
    return new LoggingAlertDispatcher();
  }
  return new EventBusAlertDispatcher(options);
}

/** Convenience accessor used by the orchestrator. */
export function createDispatcher(
  env: Record<string, string | undefined> = process.env,
  now?: () => number,
): AlertDispatcher {
  return createAlertDispatcher({
    slackWebhookUrl: env.SLACK_WEBHOOK_URL,
    pagerdutyRoutingKey: env.PAGERDUTY_ROUTING_KEY,
    now,
  });
}
