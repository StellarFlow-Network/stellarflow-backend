import axios from "axios";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../utils/httpTimeout.js";
import { withRetry } from "../utils/retryUtil.js";

type MarkdownText = {
  type: "mrkdwn";
  text: string;
};

type PlainText = {
  type: "plain_text";
  text: string;
};

type DiscordEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

type DiscordPayload = {
  embeds: Array<{
    title: string;
    color: number;
    fields: DiscordEmbedField[];
  }>;
};

type SlackPayload = {
  blocks: Array<
    | {
      type: "header";
      text: PlainText;
    }
    | {
      type: "section";
      fields?: MarkdownText[];
      text?: MarkdownText;
    }
    | {
      type: "context";
      elements: MarkdownText[];
    }
  >;
};

type WebhookPayload = DiscordPayload | SlackPayload;

type ErrorDetails = {
  errorType: string;
  errorMessage: string;
  attempts: number;
  service: string;
  pricePair: string;
  timestamp: Date;
};

type ReviewDetails = {
  reviewId: number;
  currency: string;
  rate: number;
  previousRate: number;
  changePercent: number;
  source: string;
  timestamp: Date;
  reason: string;
};

type GasBalanceAlertDetails = {
  currentBalance: number;
  threshold: number;
  walletAddress?: string;
  timestamp: Date;
};

type MonitorFailureAlertDetails = {
  consecutiveFailures: number;
  lastKnownBalance: number | null;
  timestamp: Date;
};

export class WebhookService {
  private webhookUrl: string | undefined;
  private platform: string;

  constructor() {
    this.webhookUrl =
      process.env.SLACK_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
    this.platform = process.env.NOTIFICATION_PLATFORM || "slack";
  }

  async sendErrorNotification(errorDetails: ErrorDetails): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const message = this.formatErrorMessage(errorDetails);
    await this.postMessage(message);
  }

  async sendManualReviewNotification(
    reviewDetails: ReviewDetails,
  ): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const message = this.formatReviewMessage(reviewDetails);
    await this.postMessage(message);
  }

  async sendGasBalanceAlert(
    alertDetails: GasBalanceAlertDetails,
  ): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const message = this.formatGasBalanceAlert(alertDetails);
    await this.postMessage(message);
  }

  async sendMonitorFailureAlert(
    alertDetails: MonitorFailureAlertDetails,
  ): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const message = this.formatMonitorFailureAlert(alertDetails);
    await this.postMessage(message);
  }

  private async postMessage(message: WebhookPayload): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const webhookUrl = this.webhookUrl;

    try {
      await withRetry(
        () =>
          axios.post(webhookUrl, message, {
            headers: { "Content-Type": "application/json" },
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
          }),
        {
          maxRetries: 3,
          retryDelay: 1000,
          onRetry: (attempt, error, delay) => {
            console.debug(
              `Webhook notification retry attempt ${attempt}/3 after ${delay}ms. Error: ${error.message}`,
            );
          },
        },
      );
    } catch (error) {
      console.error(
        "Failed to send webhook notification after retries:",
        error,
      );
    }
  }

  private formatErrorMessage(errorDetails: ErrorDetails): WebhookPayload {
    const { errorMessage, attempts, service, pricePair, timestamp } =
      errorDetails;

    if (this.platform === "discord") {
      return {
        embeds: [
          {
            title: "Price Fetch Error",
            color: 0xff0000,
            fields: [
              { name: "Service", value: service, inline: true },
              { name: "Price Pair", value: pricePair, inline: true },
              {
                name: "Failed Attempts",
                value: attempts.toString(),
                inline: true,
              },
              { name: "Error", value: errorMessage.substring(0, 500) },
              { name: "Time", value: new Date(timestamp).toISOString() },
            ],
          },
        ],
      };
    }

    return {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Price Fetch Error" },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Service:*\n${service}` },
            { type: "mrkdwn", text: `*Price Pair:*\n${pricePair}` },
            { type: "mrkdwn", text: `*Failed Attempts:*\n${attempts}/3` },
            {
              type: "mrkdwn",
              text: `*Time:*\n${new Date(timestamp).toISOString()}`,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Error:*\n\`\`\`${errorMessage.substring(0, 500)}\`\`\``,
          },
        },
      ],
    };
  }

  private formatReviewMessage(reviewDetails: ReviewDetails): WebhookPayload {
    const {
      reviewId,
      currency,
      rate,
      previousRate,
      changePercent,
      source,
      timestamp,
      reason,
    } = reviewDetails;

    if (this.platform === "discord") {
      return {
        embeds: [
          {
            title: "Manual Price Review Required",
            color: 0xffa500,
            fields: [
              { name: "Review ID", value: reviewId.toString(), inline: true },
              { name: "Currency", value: currency, inline: true },
              { name: "Source", value: source, inline: true },
              { name: "Current Rate", value: rate.toString(), inline: true },
              {
                name: "Previous Safe Rate",
                value: previousRate.toString(),
                inline: true,
              },
              {
                name: "Change",
                value: `${changePercent.toFixed(2)}%`,
                inline: true,
              },
              { name: "Reason", value: reason.substring(0, 500) },
              { name: "Time", value: timestamp.toISOString() },
            ],
          },
        ],
      };
    }

    return {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Manual Price Review Required" },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Review ID:*\n${reviewId}` },
            { type: "mrkdwn", text: `*Currency:*\n${currency}` },
            { type: "mrkdwn", text: `*Source:*\n${source}` },
            { type: "mrkdwn", text: `*Current Rate:*\n${rate}` },
            {
              type: "mrkdwn",
              text: `*Previous Safe Rate:*\n${previousRate}`,
            },
            {
              type: "mrkdwn",
              text: `*Change:*\n${changePercent.toFixed(2)}%`,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Reason:*\n${reason}`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Detected at ${timestamp.toISOString()}`,
            },
          ],
        },
      ],
    };
  }

  // FIX 1: Added Slack branch — previously always returned a Discord embed,
  // which would be silently dropped or mangled when NOTIFICATION_PLATFORM=slack.
  private formatGasBalanceAlert(
    alertDetails: GasBalanceAlertDetails,
  ): WebhookPayload {
    const { currentBalance, threshold, walletAddress, timestamp } = alertDetails;
    const deficit = (threshold - currentBalance).toFixed(2);

    if (this.platform === "discord") {
      return {
        embeds: [
          {
            title: "🚨 CRITICAL: Low Gas Balance Alert",
            color: 0xff0000,
            fields: [
              {
                name: "Current Balance",
                value: `${currentBalance.toFixed(2)} XLM`,
                inline: true,
              },
              {
                name: "Alert Threshold",
                value: `${threshold} XLM`,
                inline: true,
              },
              {
                name: "Deficit",
                value: `${deficit} XLM`,
                inline: true,
              },
              ...(walletAddress
                ? [{ name: "Wallet Address", value: `${walletAddress.substring(0, 20)}...` }]
                : []),
              {
                name: "Action Required",
                value: "Top up the admin wallet with XLM to ensure transaction fees can be paid",
              },
              { name: "Time", value: timestamp.toISOString() },
            ],
          },
        ],
      };
    }

    return {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "🚨 CRITICAL: Low Gas Balance Alert" },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Current Balance:*\n${currentBalance.toFixed(2)} XLM` },
            { type: "mrkdwn", text: `*Alert Threshold:*\n${threshold} XLM` },
            { type: "mrkdwn", text: `*Deficit:*\n${deficit} XLM` },
            ...(walletAddress
              ? [{ type: "mrkdwn" as const, text: `*Wallet Address:*\n${walletAddress.substring(0, 20)}...` }]
              : []),
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Action Required:*\nTop up the admin wallet with XLM to ensure transaction fees can be paid",
          },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Detected at ${timestamp.toISOString()}` }],
        },
      ],
    };
  }

  // FIX 1 (continued): Added Slack branch to formatMonitorFailureAlert for the same reason.
  private formatMonitorFailureAlert(
    alertDetails: MonitorFailureAlertDetails,
  ): WebhookPayload {
    const { consecutiveFailures, lastKnownBalance, timestamp } = alertDetails;
    const lastBalance =
      lastKnownBalance !== null ? `${lastKnownBalance.toFixed(2)} XLM` : "Unknown";

    if (this.platform === "discord") {
      return {
        embeds: [
          {
            title: "🚨 CRITICAL: Gas Monitor Failures",
            color: 0xff0000,
            fields: [
              {
                name: "Consecutive Failures",
                value: `${consecutiveFailures}`,
                inline: true,
              },
              {
                name: "Last Known Balance",
                value: lastBalance,
                inline: true,
              },
              {
                name: "Issue",
                value: "Unable to check admin wallet balance. Cannot confirm if funds are sufficient.",
              },
              {
                name: "Action Required",
                value: "Investigate Stellar Horizon connectivity and verify environment variables.",
              },
              { name: "Time", value: timestamp.toISOString() },
            ],
          },
        ],
      };
    }

    return {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "🚨 CRITICAL: Gas Monitor Failures" },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Consecutive Failures:*\n${consecutiveFailures}` },
            { type: "mrkdwn", text: `*Last Known Balance:*\n${lastBalance}` },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Issue:*\nUnable to check admin wallet balance. Cannot confirm if funds are sufficient.",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Action Required:*\nInvestigate Stellar Horizon connectivity and verify environment variables.",
          },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Detected at ${timestamp.toISOString()}` }],
        },
      ],
    };
  }
}

// FIX 2: Lazy singleton factory — avoids constructing WebhookService at import
// time, keeping it consistent with the pattern used in gasBalanceMonitorService.
let _instance: WebhookService | null = null;

export function getWebhookService(): WebhookService {
  if (!_instance) {
    _instance = new WebhookService();
  }
  return _instance;
}
