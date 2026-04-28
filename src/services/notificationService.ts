import axios, { AxiosError } from "axios";
import { withRetry } from "../utils/retryUtil.js";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../utils/httpTimeout.js";

export enum AlertSeverity {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high", 
  CRITICAL = "critical"
}

export enum AlertType {
  SYSTEM_FAILURE = "system_failure",
  KILL_SWITCH_TRIGGERED = "kill_switch_triggered",
  PRICE_ANOMALY = "price_anomaly",
  API_ERROR = "api_error",
  DATABASE_ERROR = "database_error",
  FAILOVER_EVENT = "failover_event",
  HEALTH_CHECK_FAILURE = "health_check_failure",
  SECURITY_ALERT = "security_alert"
}

export interface SystemAlert {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  details?: Record<string, any>;
  timestamp: Date;
  service?: string;
  region?: string;
  correlationId?: string;
}

export interface NotificationConfig {
  discordWebhookUrl?: string;
  slackWebhookUrl?: string;
  enabledPlatforms: ("discord" | "slack")[];
  rateLimitMinutes: number;
  retryAttempts: number;
  timeoutMs: number;
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  timestamp?: string;
  footer?: {
    text: string;
  };
}

interface DiscordPayload {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds: DiscordEmbed[];
}

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{
    type: string;
    text: string;
    emoji?: boolean;
  }>;
  accessory?: {
    type: string;
    text: {
      type: string;
      text: string;
      emoji?: boolean;
    };
  };
}

interface SlackPayload {
  username?: string;
  icon_url?: string;
  text?: string;
  blocks: SlackBlock[];
  attachments?: Array<{
    color: string;
    title: string;
    text?: string;
    fields?: Array<{
      title: string;
      value: string;
      short?: boolean;
    }>;
    ts?: number;
  }>;
}

export class NotificationService {
  private config: NotificationConfig;
  private lastSentTimes: Map<string, number> = new Map();
  private readonly COLORS = {
    [AlertSeverity.LOW]: 0x00ff00,      // Green
    [AlertSeverity.MEDIUM]: 0xffff00,   // Yellow  
    [AlertSeverity.HIGH]: 0xff8c00,     // Orange
    [AlertSeverity.CRITICAL]: 0xff0000   // Red
  };

  private readonly SLACK_COLORS = {
    [AlertSeverity.LOW]: "good",
    [AlertSeverity.MEDIUM]: "warning",
    [AlertSeverity.HIGH]: "danger", 
    [AlertSeverity.CRITICAL]: "danger"
  };

  constructor(config?: Partial<NotificationConfig>) {
    this.config = {
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      enabledPlatforms: (process.env.NOTIFICATION_PLATFORMS?.split(",") || ["discord", "slack"]) as ("discord" | "slack")[],
      rateLimitMinutes: parseInt(process.env.WEBHOOK_RATE_LIMIT_MINUTES || "5"),
      retryAttempts: 3,
      timeoutMs: OUTGOING_HTTP_TIMEOUT_MS,
      ...config
    };
  }

  private isRateLimited(alertKey: string): boolean {
    const now = Date.now();
    const lastSent = this.lastSentTimes.get(alertKey) || 0;
    const timeDiff = now - lastSent;
    const rateLimitMs = this.config.rateLimitMinutes * 60 * 1000;

    return timeDiff < rateLimitMs;
  }

  private updateLastSent(alertKey: string): void {
    this.lastSentTimes.set(alertKey, Date.now());
  }

  private generateAlertKey(alert: SystemAlert): string {
    return `${alert.type}_${alert.service || 'unknown'}_${alert.severity}`;
  }

  private formatDiscordPayload(alert: SystemAlert): DiscordPayload {
    const embed: DiscordEmbed = {
      title: alert.title,
      description: alert.message,
      color: this.COLORS[alert.severity],
      timestamp: alert.timestamp.toISOString(),
      footer: {
        text: `StellarFlow Backend • ${alert.type.replace(/_/g, " ").toUpperCase()}`
      }
    };

    // Add fields if details exist
    if (alert.details && Object.keys(alert.details).length > 0) {
      embed.fields = Object.entries(alert.details).map(([key, value]) => ({
        name: key.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
        value: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value),
        inline: false
      }));
    }

    // Add standard fields
    const standardFields = [
      ...(alert.service ? [{ name: "Service", value: alert.service, inline: true }] : []),
      ...(alert.region ? [{ name: "Region", value: alert.region, inline: true }] : []),
      ...(alert.correlationId ? [{ name: "Correlation ID", value: alert.correlationId, inline: true }] : []),
      { name: "Severity", value: alert.severity.toUpperCase(), inline: true },
      { name: "Time", value: alert.timestamp.toUTCString(), inline: true }
    ];

    if (embed.fields) {
      embed.fields.push(...standardFields);
    } else {
      embed.fields = standardFields;
    }

    return {
      username: "StellarFlow Alerts",
      avatar_url: "https://via.placeholder.com/40/FF6B6B/FFFFFF?text=SF",
      content: this.getSeverityEmoji(alert.severity) + " **" + alert.title + "**",
      embeds: [embed]
    };
  }

  private formatSlackPayload(alert: SystemAlert): SlackPayload {
    const blocks: SlackBlock[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${this.getSeverityEmoji(alert.severity)} ${alert.title}`,
          emoji: true
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: alert.message
        }
      }
    ];

    // Add details section if available
    if (alert.details && Object.keys(alert.details).length > 0) {
      const detailFields = Object.entries(alert.details).map(([key, value]) => ({
        type: "mrkdwn" as const,
        text: `*${key.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}:*\n${typeof value === 'object' ? '```' + JSON.stringify(value, null, 2) + '```' : value}`
      }));
      
      blocks.push({
        type: "section",
        fields: detailFields
      });
    }

    // Add context section
    const contextFields = [
      ...(alert.service ? [{ type: "mrkdwn" as const, text: `*Service:* ${alert.service}` }] : []),
      ...(alert.region ? [{ type: "mrkdwn" as const, text: `*Region:* ${alert.region}` }] : []),
      ...(alert.correlationId ? [{ type: "mrkdwn" as const, text: `*Correlation ID:* ${alert.correlationId}` }] : []),
      { type: "mrkdwn" as const, text: `*Severity:* ${alert.severity.toUpperCase()}` },
      { type: "mrkdwn" as const, text: `*Time:* ${alert.timestamp.toUTCString()}` }
    ];

    blocks.push({
      type: "context",
      elements: contextFields
    });

    return {
      username: "StellarFlow Alerts",
      icon_url: "https://via.placeholder.com/40/FF6B6B/FFFFFF?text=SF",
      blocks
    };
  }

  private getSeverityEmoji(severity: AlertSeverity): string {
    switch (severity) {
      case AlertSeverity.LOW: return "🟢";
      case AlertSeverity.MEDIUM: return "🟡";
      case AlertSeverity.HIGH: return "🟠";
      case AlertSeverity.CRITICAL: return "🔴";
      default: return "⚪";
    }
  }

  private async sendDiscordWebhook(payload: DiscordPayload): Promise<boolean> {
    if (!this.config.discordWebhookUrl || !this.config.enabledPlatforms.includes("discord")) {
      return false;
    }

    try {
      await withRetry(
        () => axios.post(this.config.discordWebhookUrl!, payload, {
          headers: { "Content-Type": "application/json" },
          timeout: this.config.timeoutMs
        }),
        {
          maxRetries: this.config.retryAttempts,
          retryDelay: 1000,
          onRetry: (attempt, error, delay) => {
            console.debug(`Discord webhook retry attempt ${attempt}/${this.config.retryAttempts} after ${delay}ms. Error: ${error.message}`);
          }
        }
      );
      return true;
    } catch (error) {
      console.error("Discord webhook failed after retries:", error instanceof Error ? error.message : error);
      return false;
    }
  }

  private async sendSlackWebhook(payload: SlackPayload): Promise<boolean> {
    if (!this.config.slackWebhookUrl || !this.config.enabledPlatforms.includes("slack")) {
      return false;
    }

    try {
      await withRetry(
        () => axios.post(this.config.slackWebhookUrl!, payload, {
          headers: { "Content-Type": "application/json" },
          timeout: this.config.timeoutMs
        }),
        {
          maxRetries: this.config.retryAttempts,
          retryDelay: 1000,
          onRetry: (attempt, error, delay) => {
            console.debug(`Slack webhook retry attempt ${attempt}/${this.config.retryAttempts} after ${delay}ms. Error: ${error.message}`);
          }
        }
      );
      return true;
    } catch (error) {
      console.error("Slack webhook failed after retries:", error instanceof Error ? error.message : error);
      return false;
    }
  }

  public async sendAlert(alert: SystemAlert): Promise<boolean> {
    const alertKey = this.generateAlertKey(alert);

    // Check rate limiting
    if (this.isRateLimited(alertKey)) {
      console.debug(`Alert ${alertKey} rate limited`);
      return false;
    }

    let success = false;

    // Try Discord first (primary platform)
    if (this.config.enabledPlatforms.includes("discord")) {
      const discordPayload = this.formatDiscordPayload(alert);
      success = await this.sendDiscordWebhook(discordPayload);
    }

    // Fallback to Slack if Discord fails or if Slack is also enabled
    if (!success && this.config.enabledPlatforms.includes("slack")) {
      const slackPayload = this.formatSlackPayload(alert);
      success = await this.sendSlackWebhook(slackPayload);
    }

    if (success) {
      this.updateLastSent(alertKey);
      console.log(`Alert sent successfully: ${alert.title}`);
    } else {
      console.error(`Failed to send alert: ${alert.title}`);
    }

    return success;
  }

  // Convenience methods for common alert types
  public async sendKillSwitchTriggeredAlert(details: {
    reason: string;
    service?: string;
    region?: string;
    correlationId?: string;
  }): Promise<boolean> {
    return this.sendAlert({
      type: AlertType.KILL_SWITCH_TRIGGERED,
      severity: AlertSeverity.CRITICAL,
      title: "🚨 KILL SWITCH TRIGGERED",
      message: `Critical system protection has been activated due to: ${details.reason}`,
      details: {
        trigger_reason: details.reason,
        automatic_recovery_enabled: true,
        manual_intervention_required: details.reason.includes("security") || details.reason.includes("data corruption")
      },
      timestamp: new Date(),
      service: details.service,
      region: details.region,
      correlationId: details.correlationId
    });
  }

  public async sendSystemFailureAlert(details: {
    error: Error | string;
    service?: string;
    region?: string;
    correlationId?: string;
  }): Promise<boolean> {
    const errorMessage = details.error instanceof Error ? details.error.message : details.error;
    const errorStack = details.error instanceof Error ? details.error.stack : undefined;

    return this.sendAlert({
      type: AlertType.SYSTEM_FAILURE,
      severity: AlertSeverity.CRITICAL,
      title: "❌ SYSTEM FAILURE",
      message: `A critical system failure has occurred: ${errorMessage}`,
      details: {
        error_message: errorMessage,
        ...(errorStack && { stack_trace: errorStack.substring(0, 1000) + (errorStack.length > 1000 ? "..." : "") })
      },
      timestamp: new Date(),
      service: details.service,
      region: details.region,
      correlationId: details.correlationId
    });
  }

  public async sendFailoverEventAlert(details: {
    fromRegion: string;
    toRegion: string;
    reason: string;
    automatic: boolean;
    correlationId?: string;
  }): Promise<boolean> {
    return this.sendAlert({
      type: AlertType.FAILOVER_EVENT,
      severity: AlertSeverity.HIGH,
      title: "🔄 FAILOVER EVENT",
      message: `System failover from ${details.fromRegion} to ${details.toRegion}${details.automatic ? " (automatic)" : " (manual)"}`,
      details: {
        from_region: details.fromRegion,
        to_region: details.toRegion,
        reason: details.reason,
        trigger_type: details.automatic ? "automatic" : "manual"
      },
      timestamp: new Date(),
      service: "regional-health-service",
      correlationId: details.correlationId
    });
  }

  public async sendPriceAnomalyAlert(details: {
    currency: string;
    rate: number;
    expectedRate: number;
    deviationPercent: number;
    source: string;
    correlationId?: string;
  }): Promise<boolean> {
    return this.sendAlert({
      type: AlertType.PRICE_ANOMALY,
      severity: AlertSeverity.HIGH,
      title: "📊 PRICE ANOMALY DETECTED",
      message: `Significant price deviation detected for ${details.currency}: ${details.deviationPercent.toFixed(2)}% from expected`,
      details: {
        currency: details.currency,
        current_rate: details.rate,
        expected_rate: details.expectedRate,
        deviation_percent: details.deviationPercent,
        source: details.source
      },
      timestamp: new Date(),
      service: "market-rate-service",
      correlationId: details.correlationId
    });
  }

  public clearRateLimit(alertKey?: string): void {
    if (alertKey) {
      this.lastSentTimes.delete(alertKey);
    } else {
      this.lastSentTimes.clear();
    }
  }

  public getRateLimitStatus(): Record<string, { lastSent: number; canSend: boolean; nextAvailableIn: number }> {
    const status: Record<string, { lastSent: number; canSend: boolean; nextAvailableIn: number }> = {};
    const now = Date.now();
    const rateLimitMs = this.config.rateLimitMinutes * 60 * 1000;

    for (const [key, lastSent] of this.lastSentTimes.entries()) {
      const timeSinceLastSent = now - lastSent;
      const canSend = timeSinceLastSent >= rateLimitMs;
      const nextAvailableIn = canSend ? 0 : rateLimitMs - timeSinceLastSent;

      status[key] = {
        lastSent,
        canSend,
        nextAvailableIn
      };
    }

    return status;
  }

  public updateConfig(config: Partial<NotificationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  public getConfig(): NotificationConfig {
    return { ...this.config };
  }
}

// Singleton instance
export const notificationService = new NotificationService();

// Export convenience functions
export const sendKillSwitchAlert = notificationService.sendKillSwitchTriggeredAlert.bind(notificationService);
export const sendSystemFailureAlert = notificationService.sendSystemFailureAlert.bind(notificationService);
export const sendFailoverEventAlert = notificationService.sendFailoverEventAlert.bind(notificationService);
export const sendPriceAnomalyAlert = notificationService.sendPriceAnomalyAlert.bind(notificationService);
