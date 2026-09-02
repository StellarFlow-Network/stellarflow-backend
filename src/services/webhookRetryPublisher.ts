import crypto from "node:crypto";
import amqp, { type Channel, type ChannelModel } from "amqplib";

const WEBHOOK_EXCHANGE = "webhook";
const WEBHOOK_RETRY_QUEUE = "webhook.retry";
const WEBHOOK_RETRY_KEY = "webhook.retry";

let connectionPromise: Promise<ChannelModel> | null = null;
let channelPromise: Promise<Channel> | null = null;

function getBrokerUrl(): string {
  return process.env.CELERY_BROKER_URL || "amqp://guest:guest@localhost:5672//";
}

async function getChannel(): Promise<Channel> {
  if (!channelPromise) {
    connectionPromise ??= amqp.connect(getBrokerUrl());
    channelPromise = connectionPromise.then(async (connection) => {
      connection.on("close", () => {
        connectionPromise = null;
        channelPromise = null;
      });
      connection.on("error", () => {
        connectionPromise = null;
        channelPromise = null;
      });

      const channel = await connection.createChannel();
      await channel.assertExchange(WEBHOOK_EXCHANGE, "direct", { durable: true });
      await channel.assertQueue(WEBHOOK_RETRY_QUEUE, { durable: true });
      await channel.bindQueue(WEBHOOK_RETRY_QUEUE, WEBHOOK_EXCHANGE, WEBHOOK_RETRY_KEY);
      return channel;
    });
  }
  return channelPromise;
}

export interface WebhookRetryMessage {
  endpoint_id: string;
  endpoint_url: string;
  event_id: string;
  payload: Record<string, unknown>;
  attempt: number;
}

export async function publishWebhookRetry(
  endpointUrl: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const endpointId = crypto.createHash("sha256").update(endpointUrl).digest("hex").slice(0, 32);
  const message: WebhookRetryMessage = {
    endpoint_id: endpointId,
    endpoint_url: endpointUrl,
    event_id: crypto.randomUUID(),
    payload,
    attempt: 0,
  };

  const channel = await getChannel();
  channel.publish(
    WEBHOOK_EXCHANGE,
    WEBHOOK_RETRY_KEY,
    Buffer.from(JSON.stringify(message), "utf8"),
    { persistent: true, contentType: "application/json" },
  );
}

export async function closeWebhookRetryPublisher(): Promise<void> {
  const channel = await channelPromise?.catch(() => null);
  await channel?.close().catch(() => undefined);
  const connection = await connectionPromise?.catch(() => null);
  await connection?.close().catch(() => undefined);
  channelPromise = null;
  connectionPromise = null;
}
