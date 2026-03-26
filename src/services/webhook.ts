import axios from "axios";
import axios from 'axios';

export class WebhookService {
  private webhookUrl: string | undefined;
  private platform: string;

  constructor() {
    this.webhookUrl =
      process.env.SLACK_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
    this.platform = process.env.NOTIFICATION_PLATFORM || "slack";
  }

  async sendErrorNotification(errorDetails: {
    errorType: string;
    errorMessage: string;
    attempts: number;
    service: string;
    pricePair: string;
    timestamp: Date;
  }): Promise<void> {
    if (!this.webhookUrl) return;

    const message = this.formatErrorMessage(errorDetails);
    await this.postMessage(message);
  }

  async sendManualReviewNotification(reviewDetails: {
    reviewId: number;
    currency: string;
    rate: number;
    previousRate: number;
    changePercent: number;
    source: string;
    timestamp: Date;
    reason: string;
  }): Promise<void> {
    if (!this.webhookUrl) return;

    const message = this.formatReviewMessage(reviewDetails);
    await this.postMessage(message);
  }

  private async postMessage(message: unknown): Promise<void> {
    try {
      await axios.post(this.webhookUrl!, message, {
        headers: { "Content-Type": "application/json" },
        timeout: 5000,
      });
    } catch (error) {
      console.error("Failed to send webhook notification:", error);
    }
  }

  private formatErrorMessage(errorDetails: {
    errorType: string;
    errorMessage: string;
    attempts: number;
    service: string;
    pricePair: string;
    timestamp: Date;
  }): unknown {
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

  private formatReviewMessage(reviewDetails: {
    reviewId: number;
    currency: string;
    rate: number;
    previousRate: number;
    changePercent: number;
    source: string;
    timestamp: Date;
    reason: string;
  }): unknown {
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
}

export const webhookService = new WebhookService();
export const webhookService = new WebhookService();
