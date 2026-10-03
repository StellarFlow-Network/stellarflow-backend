/**
 * Multi-Anchor Settlement Status Push Notification Service – Issue #1002
 *
 * Responsibilities:
 * 1. Delivers real-time SMS (Twilio) and Email (SendGrid) updates to remittance
 *    recipients when settlement status changes to READY_FOR_PICKUP or COMPLETED.
 * 2. Asynchronously processes notifications without blocking anchor webhook responses.
 * 3. Tracks delivery metrics, attempts, latency, and success rates in PostgreSQL.
 */

import crypto from "crypto";
import prisma from "../lib/prisma";
import { httpClient } from "../lib/httpClient";
import { createFetcherLogger } from "../utils/logger";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../utils/httpTimeout";

export interface RecipientInfo {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  pickupCode?: string | null;
}

export interface SettlementNotificationPayload {
  transactionId: string;
  status: string;
  previousStatus?: string | undefined;
  amount: number | string;
  currency: string;
  outputAmount?: number | string;
  receiverCurrency?: string;
  reference?: string | null;
  provider?: string | null;
  occurredAt?: string;
  recipient: RecipientInfo;
}

export interface DeliveryResult {
  channel: "SMS" | "EMAIL";
  provider: "TWILIO" | "SENDGRID";
  success: boolean;
  recipient: string;
  latencyMs: number;
  error?: string | undefined;
}

export interface NotificationSuccessRateMetrics {
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  successRate: number; // e.g., 98.5%
  averageLatencyMs: number;
  byChannel: {
    SMS: {
      total: number;
      success: number;
      failed: number;
      successRate: number;
    };
    EMAIL: {
      total: number;
      success: number;
      failed: number;
      successRate: number;
    };
  };
  byEvent: Record<string, { total: number; success: number; failed: number }>;
}

export class AnchorSettlementNotificationService {
  private readonly logger = createFetcherLogger(
    "AnchorSettlementNotificationService",
  );
  private tablesReady: Promise<void> | null = null;

  constructor(
    private readonly twilioAccountSid = process.env.TWILIO_ACCOUNT_SID,
    private readonly twilioAuthToken = process.env.TWILIO_AUTH_TOKEN,
    private readonly twilioFromNumber = process.env.TWILIO_FROM_NUMBER,
    private readonly sendgridApiKey = process.env.SENDGRID_API_KEY,
    private readonly sendgridFromEmail = process.env.SENDGRID_FROM_EMAIL ||
      "notifications@stellarflow.io",
  ) {}

  /**
   * Ensures the PostgreSQL metric delivery logs table exists.
   */
  async ensureTables(): Promise<void> {
    if (!this.tablesReady) {
      this.tablesReady = this.createTables().catch((error: unknown) => {
        this.tablesReady = null;
        throw error;
      });
    }
    return this.tablesReady;
  }

  private async createTables(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS notification_delivery_logs (
        id UUID PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        provider TEXT NOT NULL,
        recipient TEXT NOT NULL,
        status TEXT NOT NULL,
        status_event TEXT NOT NULL,
        latency_ms INT NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS notification_delivery_logs_status_idx
        ON notification_delivery_logs (status, created_at);
    `);

    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS notification_delivery_logs_created_at_idx ON notification_delivery_logs (created_at)`,
    );

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS notification_delivery_logs_tx_idx
        ON notification_delivery_logs (transaction_id);
    `);
  }

  /**
   * Mask contact details for privacy and compliance in log records.
   */
  maskRecipient(target: string): string {
    if (!target) return "unknown";
    if (target.includes("@")) {
      const parts = target.split("@");
      const name = parts[0] || "";
      const domain = parts[1] || "";
      const maskedName =
        name.length <= 2
          ? name[0] + "*"
          : name[0] + "*".repeat(name.length - 2) + name[name.length - 1];
      return `${maskedName}@${domain}`;
    }
    if (target.length <= 4) return "****";
    return `${target.slice(0, 3)}****${target.slice(-2)}`;
  }

  /**
   * Resolves recipient contact information from RemittanceTransaction and Sep31Metadata.
   */
  async resolveRecipientDetails(
    transactionId: string,
  ): Promise<SettlementNotificationPayload | null> {
    try {
      const tx = await prisma.remittanceTransaction.findUnique({
        where: { id: transactionId },
        select: {
          id: true,
          status: true,
          amount: true,
          senderCurrency: true,
          outputAmount: true,
          receiverCurrency: true,
          reference: true,
          provider: true,
          sep31Metadata: {
            select: {
              receiver: true,
            },
          },
        },
      });

      if (!tx) {
        this.logger.warn("Transaction not found for settlement notification", {
          transactionId,
        });
        return null;
      }

      let phone: string | null = null;
      let email: string | null = null;
      let name: string | null = null;
      let pickupCode: string | null = null;

      if (
        tx.sep31Metadata?.receiver &&
        typeof tx.sep31Metadata.receiver === "object"
      ) {
        const receiver = tx.sep31Metadata.receiver as Record<string, unknown>;
        phone =
          (receiver.phone_number as string) ||
          (receiver.phoneNumber as string) ||
          (receiver.mobile_number as string) ||
          (receiver.mobile as string) ||
          (receiver.phone as string) ||
          (receiver.msisdn as string) ||
          null;

        email =
          (receiver.email as string) ||
          (receiver.email_address as string) ||
          (receiver.recipient_email as string) ||
          null;

        name =
          (receiver.name as string) ||
          (receiver.full_name as string) ||
          (receiver.first_name
            ? `${receiver.first_name} ${receiver.last_name || ""}`.trim()
            : null) ||
          null;

        pickupCode =
          (receiver.pickup_code as string) ||
          (receiver.pickup_pin as string) ||
          (receiver.pin as string) ||
          null;
      }

      // Default fallback from environment in sandbox/testing if not specified
      if (
        process.env.NODE_ENV !== "production" &&
        !phone &&
        process.env.DEFAULT_RECIPIENT_PHONE
      ) {
        phone = process.env.DEFAULT_RECIPIENT_PHONE;
      }
      if (
        process.env.NODE_ENV !== "production" &&
        !email &&
        process.env.DEFAULT_RECIPIENT_EMAIL
      ) {
        email = process.env.DEFAULT_RECIPIENT_EMAIL;
      }

      return {
        transactionId: tx.id,
        status: tx.status,
        amount: Number(tx.amount),
        currency: tx.senderCurrency,
        outputAmount: Number(tx.outputAmount),
        receiverCurrency: tx.receiverCurrency,
        reference: tx.reference,
        provider: tx.provider,
        recipient: { phone, email, name, pickupCode },
      };
    } catch (error) {
      this.logger.error("Failed to resolve recipient details", {
        transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Main entrypoint triggered on settlement status changes.
   */
  async handleStatusChange(
    transactionId: string,
    newStatus: string,
    previousStatus?: string,
  ): Promise<DeliveryResult[]> {
    const normalizedStatus = newStatus.toUpperCase();
    if (
      normalizedStatus !== "READY_FOR_PICKUP" &&
      normalizedStatus !== "COMPLETED"
    ) {
      return [];
    }

    const payload = await this.resolveRecipientDetails(transactionId);
    if (!payload) return [];

    payload.occurredAt = new Date().toISOString();
    payload.status = normalizedStatus;
    payload.previousStatus = previousStatus;

    const results: DeliveryResult[] = [];

    // 1. Send SMS Notification (Twilio) for READY_FOR_PICKUP and COMPLETED
    if (payload.recipient.phone) {
      const smsResult = await this.sendTwilioSms(payload);
      results.push(smsResult);
      await this.recordDeliveryLog(
        payload.transactionId,
        smsResult,
        normalizedStatus,
      );
    } else {
      this.logger.info("Skipping SMS: No recipient phone number provided", {
        transactionId,
      });
    }

    // 2. Send Email Notification (SendGrid) for COMPLETED and READY_FOR_PICKUP
    if (payload.recipient.email) {
      const emailResult = await this.sendSendGridEmail(payload);
      results.push(emailResult);
      await this.recordDeliveryLog(
        payload.transactionId,
        emailResult,
        normalizedStatus,
      );
    } else {
      this.logger.info("Skipping Email: No recipient email address provided", {
        transactionId,
      });
    }

    return results;
  }

  /**
   * Send SMS via Twilio Messages API.
   */
  async sendTwilioSms(
    payload: SettlementNotificationPayload,
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    const recipientPhone = payload.recipient.phone!;
    const masked = this.maskRecipient(recipientPhone);

    const messageBody = this.buildSmsText(payload);

    if (!/^\+[1-9]\d{1,14}$/.test(recipientPhone)) {
      return {
        channel: "SMS",
        provider: "TWILIO",
        success: false,
        recipient: masked,
        latencyMs: Date.now() - startTime,
        error: "Recipient phone must use E.164 format",
      };
    }
    if (
      !this.twilioAccountSid ||
      !this.twilioAuthToken ||
      !this.twilioFromNumber
    ) {
      return {
        channel: "SMS",
        provider: "TWILIO",
        success: false,
        recipient: masked,
        latencyMs: Date.now() - startTime,
        error: "Twilio credentials are not configured",
      };
    }

    try {
      const auth = Buffer.from(
        `${this.twilioAccountSid}:${this.twilioAuthToken}`,
      ).toString("base64");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.twilioAccountSid}/Messages.json`;

      const params = new URLSearchParams();
      params.append("To", recipientPhone);
      params.append("From", this.twilioFromNumber);
      params.append("Body", messageBody);

      const response = await httpClient.post(url, params.toString(), {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: OUTGOING_HTTP_TIMEOUT_MS,
      });

      const success = response.status >= 200 && response.status < 300;
      return {
        channel: "SMS",
        provider: "TWILIO",
        success,
        recipient: masked,
        latencyMs: Date.now() - startTime,
        error: success ? undefined : `Twilio status ${response.status}`,
      };
    } catch {
      const errorMessage = "Notification provider request failed";
      this.logger.error("Twilio SMS dispatch failed", {
        transactionId: payload.transactionId,
        recipient: masked,
        error: errorMessage,
      });
      return {
        channel: "SMS",
        provider: "TWILIO",
        success: false,
        recipient: masked,
        latencyMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Send Email via SendGrid v3 API.
   */
  async sendSendGridEmail(
    payload: SettlementNotificationPayload,
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    const recipientEmail = payload.recipient.email!;
    const masked = this.maskRecipient(recipientEmail);

    const { subject, html, text } = this.buildEmailContent(payload);

    if (!this.sendgridApiKey) {
      return {
        channel: "EMAIL",
        provider: "SENDGRID",
        success: false,
        recipient: masked,
        latencyMs: Date.now() - startTime,
        error: "SendGrid credentials are not configured",
      };
    }

    try {
      const url = "https://api.sendgrid.com/v3/mail/send";
      const emailBody = {
        personalizations: [
          {
            to: [
              {
                email: recipientEmail,
                name: payload.recipient.name || "Customer",
              },
            ],
            subject,
          },
        ],
        from: { email: this.sendgridFromEmail, name: "StellarFlow Remittance" },
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html },
        ],
      };

      const response = await httpClient.post(url, emailBody, {
        headers: {
          Authorization: `Bearer ${this.sendgridApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: OUTGOING_HTTP_TIMEOUT_MS,
      });

      const success = response.status >= 200 && response.status < 300;
      return {
        channel: "EMAIL",
        provider: "SENDGRID",
        success,
        recipient: masked,
        latencyMs: Date.now() - startTime,
        error: success ? undefined : `SendGrid status ${response.status}`,
      };
    } catch {
      const errorMessage = "Notification provider request failed";
      this.logger.error("SendGrid email dispatch failed", {
        transactionId: payload.transactionId,
        recipient: masked,
        error: errorMessage,
      });
      return {
        channel: "EMAIL",
        provider: "SENDGRID",
        success: false,
        recipient: masked,
        latencyMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Builds context-aware SMS message text.
   */
  buildSmsText(payload: SettlementNotificationPayload): string {
    const amount = payload.outputAmount || payload.amount;
    const currency = payload.receiverCurrency || payload.currency;
    const ref = payload.reference ? ` Ref: ${payload.reference}.` : "";
    const pickup = payload.recipient.pickupCode
      ? ` Pickup Code: ${payload.recipient.pickupCode}.`
      : "";

    if (payload.status === "READY_FOR_PICKUP") {
      return `💵 StellarFlow: Your payout of ${amount} ${currency} is READY FOR PICKUP.${pickup}${ref} Present your ID at your local anchor partner.`;
    }

    return `✅ StellarFlow: Remittance payout of ${amount} ${currency} has been COMPLETED.${ref} Thank you for using StellarFlow.`;
  }

  /**
   * Builds context-aware Email content.
   */
  buildEmailContent(payload: SettlementNotificationPayload): {
    subject: string;
    html: string;
    text: string;
  } {
    const amount = payload.outputAmount || payload.amount;
    const currency = payload.receiverCurrency || payload.currency;
    const ref = payload.reference || payload.transactionId;
    const name = payload.recipient.name || "Customer";
    const timestamp = payload.occurredAt || new Date().toISOString();

    if (payload.status === "READY_FOR_PICKUP") {
      const subject = `💵 Funds Ready for Pickup: ${amount} ${currency} (Ref: ${ref})`;
      const text = `Hello ${name},\n\nYour remittance payout of ${amount} ${currency} is now READY FOR PICKUP.\nReference: ${ref}\n\nPlease visit your local anchor counter with valid identification.`;
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #4F46E5;">💵 Funds Ready for Pickup</h2>
          <p>Hello <strong>${name}</strong>,</p>
          <p>Your transfer is ready for collection at your selected payout counter.</p>
          <div style="background-color: #F3F4F6; padding: 15px; border-radius: 6px; margin: 15px 0;">
            <p style="margin: 5px 0;"><strong>Amount:</strong> ${amount} ${currency}</p>
            <p style="margin: 5px 0;"><strong>Reference Number:</strong> ${ref}</p>
            ${payload.recipient.pickupCode ? `<p style="margin: 5px 0; color: #16A34A;"><strong>Pickup Code:</strong> ${payload.recipient.pickupCode}</p>` : ""}
          </div>
          <p style="font-size: 13px; color: #6B7280;">Please present this reference and valid government-issued ID at pickup.</p>
        </div>
      `;
      return { subject, html, text };
    }

    const subject = `✅ Payout Completed: ${amount} ${currency} (Ref: ${ref})`;
    const text = `Hello ${name},\n\nYour remittance payout of ${amount} ${currency} has been successfully COMPLETED.\nReference: ${ref}\nTransaction: ${payload.transactionId}\nNotification time: ${timestamp}\n\nThank you for using StellarFlow.`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #16A34A;">✅ Payout Completed</h2>
        <p>Hello <strong>${name}</strong>,</p>
        <p>Your cross-border remittance settlement has been completed successfully.</p>
        <div style="background-color: #F3F4F6; padding: 15px; border-radius: 6px; margin: 15px 0;">
          <p style="margin: 5px 0;"><strong>Amount Settled:</strong> ${amount} ${currency}</p>
          <p style="margin: 5px 0;"><strong>Reference Number:</strong> ${ref}</p>
          <p style="margin: 5px 0;"><strong>Status:</strong> COMPLETED</p>
          <p><strong>Transaction:</strong> ${payload.transactionId}</p>
          <p><strong>Notification time:</strong> ${timestamp}</p>
        </div>
        <p style="font-size: 13px; color: #6B7280;">Thank you for trusting the StellarFlow Multi-Anchor Network.</p>
      </div>
    `;
    return { subject, html, text };
  }

  /**
   * Record a notification delivery log row in PostgreSQL.
   */
  private async recordDeliveryLog(
    transactionId: string,
    result: DeliveryResult,
    statusEvent: string,
  ): Promise<void> {
    try {
      await this.ensureTables();

      await prisma.$executeRawUnsafe(
        `
          INSERT INTO notification_delivery_logs
            (id, transaction_id, channel, provider, recipient, status, status_event, latency_ms, error_message, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        `,
        crypto.randomUUID(),
        transactionId,
        result.channel,
        result.provider,
        result.recipient,
        result.success ? "DELIVERED" : "FAILED",
        statusEvent,
        result.latencyMs,
        result.error || null,
      );
    } catch (error) {
      this.logger.error("Failed to record delivery log to database", {
        transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Query delivery success rate metrics from PostgreSQL.
   */
  async getDeliverySuccessRateMetrics(options?: {
    timeRangeMinutes?: number;
  }): Promise<NotificationSuccessRateMetrics> {
    await this.ensureTables();

    const timeRangeMinutes = options?.timeRangeMinutes || 1440; // Default: last 24h
    const cutoff = new Date(Date.now() - timeRangeMinutes * 60 * 1000);

    const rows = await prisma.$queryRawUnsafe<
      Array<{
        channel: string;
        status: string;
        status_event: string;
        count: string | number;
        avg_latency: string | number;
      }>
    >(
      `
        SELECT
          channel,
          status,
          status_event,
          COUNT(*) as count,
          AVG(latency_ms) as avg_latency
        FROM notification_delivery_logs
        WHERE created_at >= $1
        GROUP BY channel, status, status_event
      `,
      cutoff,
    );

    let totalDeliveries = 0;
    let successfulDeliveries = 0;
    let failedDeliveries = 0;
    let totalLatencySum = 0;

    const byChannel = {
      SMS: { total: 0, success: 0, failed: 0, successRate: 0 },
      EMAIL: { total: 0, success: 0, failed: 0, successRate: 0 },
    };

    const byEvent: Record<
      string,
      { total: number; success: number; failed: number }
    > = {};

    for (const row of rows) {
      const count = Number(row.count);
      const latency = Number(row.avg_latency || 0);
      const isDelivered = row.status === "DELIVERED";

      totalDeliveries += count;
      totalLatencySum += latency * count;

      if (isDelivered) {
        successfulDeliveries += count;
      } else {
        failedDeliveries += count;
      }

      // Channel breakdown
      if (row.channel === "SMS" || row.channel === "EMAIL") {
        byChannel[row.channel].total += count;
        if (isDelivered) {
          byChannel[row.channel].success += count;
        } else {
          byChannel[row.channel].failed += count;
        }
      }

      // Event breakdown
      if (!byEvent[row.status_event]) {
        byEvent[row.status_event] = { total: 0, success: 0, failed: 0 };
      }
      const eventMetrics = byEvent[row.status_event]!;
      eventMetrics.total += count;
      if (isDelivered) {
        eventMetrics.success += count;
      } else {
        eventMetrics.failed += count;
      }
    }

    // Calculate percentages
    const successRate =
      totalDeliveries > 0
        ? Number(((successfulDeliveries / totalDeliveries) * 100).toFixed(2))
        : 100;

    byChannel.SMS.successRate =
      byChannel.SMS.total > 0
        ? Number(
            ((byChannel.SMS.success / byChannel.SMS.total) * 100).toFixed(2),
          )
        : 100;

    byChannel.EMAIL.successRate =
      byChannel.EMAIL.total > 0
        ? Number(
            ((byChannel.EMAIL.success / byChannel.EMAIL.total) * 100).toFixed(
              2,
            ),
          )
        : 100;

    const averageLatencyMs =
      totalDeliveries > 0 ? Math.round(totalLatencySum / totalDeliveries) : 0;

    return {
      totalDeliveries,
      successfulDeliveries,
      failedDeliveries,
      successRate,
      averageLatencyMs,
      byChannel,
      byEvent,
    };
  }
}

export const anchorSettlementNotificationService =
  new AnchorSettlementNotificationService();
