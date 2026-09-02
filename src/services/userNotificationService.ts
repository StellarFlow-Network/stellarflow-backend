import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { getRedisClient } from "../lib/redis";
import webpush from "web-push";
import sgMail from "@sendgrid/mail";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

export enum NotificationEventType {
  LIQUIDATION = "liquidation",
  FILLED_ORDER = "filled_order",
  ESCROW_CLAIM = "escrow_claim",
  ACCOUNT_EVENT = "account_event",
}

export enum NotificationChannel {
  EMAIL = "email",
  PUSH = "push",
  DISCORD = "discord",
  SLACK = "slack",
}

export interface NotificationPayload {
  userId: string;
  eventType: NotificationEventType;
  title: string;
  message: string;
  data?: Record<string, any>;
}

export class UserNotificationService {
  private isRunning = false;
  private workerTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Initialize SendGrid if key provided
    if (process.env.SENDGRID_API_KEY) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    }

    // Initialize Web Push keys if provided
    if (
      process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT
    ) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT,
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY,
      );
    }
  }

  /**
   * Start worker processing user notification event queues from Redis stream.
   */
  startWorker(intervalMs = 5000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.workerTimer = setInterval(() => {
      void this.processQueue().catch((err) => {
        logger.error("[UserNotificationService] Error processing queue:", err);
      });
    }, intervalMs);

    logger.info("[UserNotificationService] Worker started");
  }

  stopWorker(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
    this.isRunning = false;
    logger.info("[UserNotificationService] Worker stopped");
  }

  /**
   * Enqueue a notification event to Redis stream for asynchronous worker processing.
   */
  async enqueueNotification(payload: NotificationPayload): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) {
      // Fallback to direct dispatch if Redis is not available
      await this.dispatchNotification(payload);
      return;
    }

    await redis.xAdd(
      "notifications:queue",
      "*",
      {
        payload: JSON.stringify(payload),
      },
      { TRIM: { strategy: "MAXLEN", modifier: "~", threshold: 10000 } },
    );
  }

  /**
   * Process pending notification items from the Redis queue stream.
   */
  async processQueue(): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    try {
      const response = (await redis.xRead(
        { key: "notifications:queue", id: "0" },
        { COUNT: 50, BLOCK: 1000 },
      )) as any;

      if (!response) return;

      for (const streamEntry of response) {
        const messages = streamEntry.messages;
        for (const message of messages) {
          const id = message.id;
          const rawPayload = message.message.payload;

          try {
            const payload = JSON.parse(rawPayload) as NotificationPayload;
            await this.dispatchNotification(payload);
            await redis.xDel("notifications:queue", [id]);
          } catch (err) {
            logger.error(`[UserNotificationService] Failed to process message ${id}:`, err);
          }
        }
      }
    } catch (err) {
      logger.error("[UserNotificationService] xRead error:", err);
    }
  }

  /**
   * Respect user notification preference settings stored in database and dispatch accordingly.
   */
  async dispatchNotification(payload: NotificationPayload): Promise<void> {
    const { userId, eventType, title, message, data } = payload;

    // Fetch user preferences from database
    let prefs: any = null;
    try {
      prefs = await (prisma as any).userNotificationPreference?.findUnique?.({
        where: { userId },
      });
    } catch {
      // Fallback if table doesn't exist in minimal prisma client setups
    }

    // Default to enabling email and push if no preference row exists
    const emailEnabled = prefs ? prefs.emailEnabled ?? true : true;
    const pushEnabled = prefs ? prefs.pushEnabled ?? true : true;

    const channelsToDispatch: NotificationChannel[] = [];
    if (emailEnabled) channelsToDispatch.push(NotificationChannel.EMAIL);
    if (pushEnabled) channelsToDispatch.push(NotificationChannel.PUSH);

    await Promise.allSettled(
      channelsToDispatch.map(async (channel) => {
        if (channel === NotificationChannel.EMAIL) {
          await this.sendEmail(userId, title, message, data);
        } else if (channel === NotificationChannel.PUSH) {
          await this.sendWebPush(userId, title, message, data);
        }
      }),
    );
  }

  /**
   * Integrate email gateway (SendGrid / AWS SES)
   */
  async sendEmail(
    userId: string,
    subject: string,
    body: string,
    data?: Record<string, any>,
  ): Promise<boolean> {
    // Fetch user email from database
    let user: any = null;
    try {
      user = await prisma.user.findUnique({ where: { id: userId } });
    } catch {
      // user model might be mockable
    }

    const recipientEmail = user?.email || process.env.DEFAULT_NOTIFICATION_EMAIL;
    if (!recipientEmail) {
      logger.warn(`[UserNotificationService] No email found for user ${userId}`);
      return false;
    }

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>${subject}</h2>
        <p>${body}</p>
        ${data ? `<pre>${JSON.stringify(data, null, 2)}</pre>` : ""}
        <hr/>
        <p style="font-size: 12px; color: #666;">StellarFlow Notification System</p>
      </div>
    `;

    // Try SendGrid first
    if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL) {
      try {
        await sgMail.send({
          to: recipientEmail,
          from: process.env.SENDGRID_FROM_EMAIL,
          subject,
          text: body,
          html: htmlContent,
        });
        return true;
      } catch (err) {
        logger.error("[UserNotificationService] SendGrid error:", err);
      }
    }

    // Fallback to AWS SES
    if (process.env.AWS_REGION && process.env.SES_FROM_EMAIL) {
      try {
        const sesClient = new SESClient({ region: process.env.AWS_REGION });
        const command = new SendEmailCommand({
          Source: process.env.SES_FROM_EMAIL,
          Destination: { ToAddresses: [recipientEmail] },
          Message: {
            Subject: { Data: subject },
            Body: { Text: { Data: body }, Html: { Data: htmlContent } },
          },
        });
        await sesClient.send(command);
        return true;
      } catch (err) {
        logger.error("[UserNotificationService] AWS SES error:", err);
      }
    }

    logger.info(`[UserNotificationService] [Mock Email] To: ${recipientEmail} | Subj: ${subject} | Body: ${body}`);
    return true;
  }

  /**
   * Integrate Web Push endpoints
   */
  async sendWebPush(
    userId: string,
    title: string,
    message: string,
    data?: Record<string, any>,
  ): Promise<boolean> {
    let subscriptions: any[] = [];
    try {
      subscriptions = await (prisma as any).pushSubscription?.findMany?.({
        where: { userId },
      }) || [];
    } catch {
      // Fallback if table doesn't exist
    }

    if (subscriptions.length === 0 && process.env.DEFAULT_PUSH_ENDPOINT) {
      subscriptions = [
        {
          endpoint: process.env.DEFAULT_PUSH_ENDPOINT,
          p256dh: process.env.DEFAULT_PUSH_P256DH || "",
          auth: process.env.DEFAULT_PUSH_AUTH || "",
        },
      ];
    }

    if (subscriptions.length === 0) {
      logger.debug(`[UserNotificationService] No push subscriptions for user ${userId}`);
      return false;
    }

    const payloadString = JSON.stringify({
      title,
      body: message,
      icon: "/favicon.ico",
      data,
    });

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const pushSub = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };
        if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
          await webpush.sendNotification(pushSub, payloadString);
        } else {
          logger.info(`[UserNotificationService] [Mock WebPush] To endpoint ${sub.endpoint} | Msg: ${message}`);
        }
      }),
    );

    return results.some((r) => r.status === "fulfilled");
  }
}

export const userNotificationService = new UserNotificationService();
