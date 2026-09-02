/**
 * EmailService – Issue #834
 *
 * Lightweight email dispatch used to notify users whenever their remittance
 * dispute ticket changes state.
 *
 * Dispatch is POSTed to a generic HTTP email API (Resend / SendGrid / Mailgun
 * style) when `EMAIL_API_URL` is configured.  When no provider is configured
 * the message is logged and skipped so local development and CI runs never
 * fail due to missing SMTP infrastructure.
 */

import { httpClient } from "../lib/httpClient.js";
import { withRetry } from "../utils/retryUtil.js";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../utils/httpTimeout.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailConfig {
  apiUrl: string | undefined;
  apiKey: string | undefined;
  fromEmail: string;
}

export class EmailService {
  private readonly config: EmailConfig;

  constructor(config: Partial<EmailConfig> = {}) {
    this.config = {
      apiUrl: config.apiUrl ?? process.env.EMAIL_API_URL,
      apiKey: config.apiKey ?? process.env.EMAIL_API_KEY,
      fromEmail:
        config.fromEmail ??
        process.env.EMAIL_FROM ??
        "no-reply@stellarflow.network",
    };
  }

  /**
   * Send a single email.  Returns true when the message was dispatched (or
   * skipped because no provider is configured), false when dispatch failed.
   */
  async send(message: EmailMessage): Promise<boolean> {
    const { apiUrl, apiKey, fromEmail } = this.config;

    if (!apiUrl) {
      console.info(
        `[EmailService] EMAIL_API_URL not configured - skipping email to ${message.to} (subject: ${message.subject})`,
      );
      return true;
    }

    try {
      await withRetry(
        () =>
          httpClient.post(
            apiUrl,
            {
              from: fromEmail,
              to: message.to,
              subject: message.subject,
              text: message.text,
              ...(message.html ? { html: message.html } : {}),
            },
            {
              headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              },
              timeout: OUTGOING_HTTP_TIMEOUT_MS,
            },
          ),
        {
          maxRetries: 3,
          retryDelay: 1000,
          onRetry: (attempt, error, delay) => {
            console.debug(
              `[EmailService] Retry attempt ${attempt} after ${delay}ms. Error: ${error.message}`,
            );
          },
        },
      );

      console.info(
        `[EmailService] Email sent to ${message.to}: ${message.subject}`,
      );
      return true;
    } catch (error) {
      console.error(
        "[EmailService] Email dispatch failed:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }
}

export const emailService = new EmailService();
export default emailService;