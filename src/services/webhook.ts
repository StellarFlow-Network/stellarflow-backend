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

  private formatPriorityAlert(details: {
    currency: string;
    rate: number;
    zScore: number;
    mean: number;
    stdDev: number;
    timestamp: Date;
  }): unknown {
    const { currency, rate, zScore, mean, stdDev, timestamp } = details;

    if (this.platform === "discord") {
      return {
        embeds: [
          {
            title: "🚨 PRIORITY ALERT: Price Anomaly Detected",
            color: 0xff0000,
            description: `Significant deviation from moving average detected for ${currency}.`,
            fields: [
              { name: "Currency", value: currency, inline: true },
              { name: "Current Rate", value: rate.toString(), inline: true },
              { name: "Z-Score", value: zScore.toFixed(2), inline: true },
              { name: "Mean (μ)", value: mean.toFixed(4), inline: true },
              { name: "Std Dev (σ)", value: stdDev.toFixed(4), inline: true },
              { name: "Threshold", value: "> 3.0σ", inline: true },
              { name: "Time", value: timestamp.toISOString() },
            ],
            footer: { text: "StellarFlow Predictive Analytics" }
          },
        ],
      };
    }

    return {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "🚨 PRIORITY ALERT: Price Anomaly" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Significant deviation detected for ${currency} price feed.*`,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Currency:*\n${currency}` },
            { type: "mrkdwn", text: `*Current Rate:*\n${rate}` },
            { type: "mrkdwn", text: `*Z-Score:*\n${zScore.toFixed(2)}σ` },
            { type: "mrkdwn", text: `*Moving Average:*\n${mean.toFixed(4)}` },
            { type: "mrkdwn", text: `*Std Dev:*\n${stdDev.toFixed(4)}` },
            { type: "mrkdwn", text: `*Time:*\n${timestamp.toISOString()}` },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "Predicted anomaly based on historical distribution (3σ threshold).",
            },
          ],
        },
      ],
    };
  }
}

export const webhookService = new WebhookService();
