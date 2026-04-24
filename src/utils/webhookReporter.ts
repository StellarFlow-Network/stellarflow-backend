import axios from 'axios';

interface WebhookMessage {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: Array<{
    title: string;
    description: string;
    color: number;
    timestamp: string;
    fields?: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
  }>;
}

interface SlackMessage {
  text: string;
  username?: string;
  icon_url?: string;
  attachments?: Array<{
    color: string;
    title: string;
    text: string;
    fields?: Array<{
      title: string;
      value: string;
      short?: boolean;
    }>;
    ts: number;
  }>;
}

interface AlertData {
  error: Error | string;
  fetcherName: string;
  timestamp?: Date;
}

class WebhookReporter {
  private discordWebhookUrl: string | null;
  private slackWebhookUrl: string | null;
  private rateLimitMinutes: number;
  private lastSentTimes: Map<string, number> = new Map();

  constructor() {
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || null;
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || null;
    this.rateLimitMinutes = parseInt(process.env.WEBHOOK_RATE_LIMIT_MINUTES || '5');
  }

  private isRateLimited(fetcherName: string): boolean {
    const now = Date.now();
    const lastSent = this.lastSentTimes.get(fetcherName) || 0;
    const timeDiff = now - lastSent;
    const rateLimitMs = this.rateLimitMinutes * 60 * 1000;

    return timeDiff < rateLimitMs;
  }

  private updateLastSent(fetcherName: string): void {
    this.lastSentTimes.set(fetcherName, Date.now());
  }

  private formatDiscordMessage(data: AlertData): WebhookMessage {
    const timestamp = data.timestamp || new Date();
    const errorMessage = data.error instanceof Error ? data.error.message : data.error;
    const errorStack = data.error instanceof Error ? data.error.stack : '';

    return {
      username: 'StellarFlow Alert',
      avatar_url: 'https://via.placeholder.com/40/FF0000/FFFFFF?text=!',
      content: '🚨 **Critical Fetcher Failure**',
      embeds: [
        {
          title: `❌ ${data.fetcherName} Failed`,
          description: 'A critical error occurred in the fetcher service.',
          color: 0xFF0000,
          timestamp: timestamp.toISOString(),
          fields: [
            {
              name: '🔧 Fetcher',
              value: data.fetcherName,
              inline: true,
            },
            {
              name: '⏰ Time',
              value: timestamp.toUTCString(),
              inline: true,
            },
            {
              name: '📝 Error',
              value: `\`\`\`${errorMessage}\`\`\``,
              inline: false,
            },
            ...(errorStack ? [{
              name: '📚 Stack Trace',
              value: `\`\`\`${errorStack.substring(0, 1000)}${errorStack.length > 1000 ? '...' : ''}\`\`\``,
              inline: false,
            }] : []),
          ],
        },
      ],
    };
  }

  private formatSlackMessage(data: AlertData): SlackMessage {
    const timestamp = data.timestamp || new Date();
    const errorMessage = data.error instanceof Error ? data.error.message : data.error;
    const errorStack = data.error instanceof Error ? data.error.stack : '';

    return {
      text: '🚨 Critical Fetcher Failure',
      username: 'StellarFlow Alert',
      icon_url: 'https://via.placeholder.com/40/FF0000/FFFFFF?text=!',
      attachments: [
        {
          color: 'danger',
          title: `❌ ${data.fetcherName} Failed`,
          text: 'A critical error occurred in the fetcher service.',
          fields: [
            {
              title: '🔧 Fetcher',
              value: data.fetcherName,
              short: true,
            },
            {
              title: '⏰ Time',
              value: timestamp.toUTCString(),
              short: true,
            },
            {
              title: '📝 Error',
              value: errorMessage,
              short: false,
            },
            ...(errorStack ? [{
              title: '📚 Stack Trace',
              value: errorStack.substring(0, 1000) + (errorStack.length > 1000 ? '...' : ''),
              short: false,
            }] : []),
          ],
          ts: Math.floor(timestamp.getTime() / 1000),
        },
      ],
    };
  }

  private async sendDiscordWebhook(message: WebhookMessage): Promise<boolean> {
    if (!this.discordWebhookUrl) {
      return false;
    }

    try {
      const response = await axios.post(this.discordWebhookUrl, message, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      return response.status >= 200 && response.status < 300;
    } catch (error) {
      console.error('Discord webhook failed:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  private async sendSlackWebhook(message: SlackMessage): Promise<boolean> {
    if (!this.slackWebhookUrl) {
      return false;
    }

    try {
      const response = await axios.post(this.slackWebhookUrl, message, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      return response.status >= 200 && response.status < 300;
    } catch (error) {
      console.error('Slack webhook failed:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  public async sendCriticalAlert(error: Error | string, fetcherName: string): Promise<void> {
    if (this.isRateLimited(fetcherName)) {
      console.log(`Webhook alert for ${fetcherName} rate limited`);
      return;
    }

    const alertData: AlertData = {
      error,
      fetcherName,
      timestamp: new Date(),
    };

    let success = false;

    // Try Discord first (primary)
    if (this.discordWebhookUrl) {
      const discordMessage = this.formatDiscordMessage(alertData);
      success = await this.sendDiscordWebhook(discordMessage);
    }

    // Fallback to Slack if Discord fails
    if (!success && this.slackWebhookUrl) {
      const slackMessage = this.formatSlackMessage(alertData);
      success = await this.sendSlackWebhook(slackMessage);
    }

    if (success) {
      this.updateLastSent(fetcherName);
      console.log(`Critical alert sent for ${fetcherName}`);
    } else {
      console.error(`Failed to send critical alert for ${fetcherName}`);
    }
  }

  public clearRateLimit(fetcherName?: string): void {
    if (fetcherName) {
      this.lastSentTimes.delete(fetcherName);
    } else {
      this.lastSentTimes.clear();
    }
  }

  public getRateLimitStatus(): Record<string, { lastSent: number; canSend: boolean }> {
    const status: Record<string, { lastSent: number; canSend: boolean }> = {};
    const now = Date.now();
    const rateLimitMs = this.rateLimitMinutes * 60 * 1000;

    for (const [fetcherName, lastSent] of this.lastSentTimes.entries()) {
      status[fetcherName] = {
        lastSent,
        canSend: (now - lastSent) >= rateLimitMs,
      };
    }

    return status;
  }
}

// Singleton instance
export const webhookReporter = new WebhookReporter();

// Re-export for convenience
export const sendCriticalAlert = webhookReporter.sendCriticalAlert.bind(webhookReporter);
