import axios from "axios";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { RemittanceFxEngine } from "./remittance/fxEngine";

export interface Sep31Asset {
  id: string;
  code: string;
  issuer: string | null;
}

export interface Sep31AssetPair {
  source: string;
  destination: string;
}

export interface Sep31TransactionInput {
  userId: string;
  amount: number;
  source: Sep31Asset;
  destination: Sep31Asset;
  sender: Record<string, unknown>;
  receiver: Record<string, unknown>;
  reference?: string;
}

export interface Sep31TransactionRecord extends Sep31TransactionInput {
  id: string;
  status: string;
  outputAmount: number;
  fee: number;
  rate: number;
  callbackUrl: string | null;
  createdAt: Date;
}

export interface Sep31Repository {
  create(
    input: Sep31TransactionInput & {
      outputAmount: number;
      fee: number;
      rate: number;
    },
  ): Promise<Sep31TransactionRecord>;
  findById(id: string, userId: string): Promise<Sep31TransactionRecord | null>;
  setCallback(id: string, userId: string, callbackUrl: string): Promise<void>;
}

export class Sep31ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Sep31ValidationError";
  }
}

function parseAsset(value: unknown, field: string): Sep31Asset {
  if (typeof value !== "string") {
    throw new Sep31ValidationError(`${field} must be a Stellar asset identifier`);
  }

  if (value === "stellar:native") {
    return { id: value, code: "XLM", issuer: null };
  }

  const match = /^stellar:([A-Z0-9]{1,12}):([A-Z2-7]{56})$/.exec(value);
  if (!match) {
    throw new Sep31ValidationError(
      `${field} must use stellar:native or stellar:CODE:ISSUER format`,
    );
  }
  return { id: value, code: match[1]!, issuer: match[2]! };
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Sep31ValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readAssetPairs(raw = process.env.SEP31_ASSET_PAIRS): Sep31AssetPair[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SEP31_ASSET_PAIRS must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SEP31_ASSET_PAIRS must be a JSON array");
  }
  return parsed.map((entry, index) => {
    const pair = asObject(entry, `SEP31_ASSET_PAIRS[${index}]`);
    const source = parseAsset(pair.source, `SEP31_ASSET_PAIRS[${index}].source`);
    const destination = parseAsset(
      pair.destination,
      `SEP31_ASSET_PAIRS[${index}].destination`,
    );
    return { source: source.id, destination: destination.id };
  });
}

function allowedCallbackHosts(raw = process.env.SEP31_CALLBACK_ALLOWED_HOSTS): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

export class PrismaSep31Repository implements Sep31Repository {
  async create(
    input: Sep31TransactionInput & {
      outputAmount: number;
      fee: number;
      rate: number;
    },
  ): Promise<Sep31TransactionRecord> {
    return prisma.$transaction(async (tx) => {
      const transaction = await tx.remittanceTransaction.create({
        data: {
          userId: input.userId,
          asset: input.destination.code,
          senderCurrency: input.source.code,
          receiverCurrency: input.destination.code,
          amount: input.amount,
          outputAmount: input.outputAmount,
          fee: input.fee,
          rate: input.rate,
          status: "pending_sender",
          provider: "SEP-31",
          ...(input.reference === undefined ? {} : { reference: input.reference }),
        },
      });
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "Sep31TransactionMetadata" (
          "transactionId", "sourceAsset", "destinationAsset", "sender", "receiver"
        ) VALUES (
          ${transaction.id}, ${input.source.id}, ${input.destination.id},
          ${JSON.stringify(input.sender)}::jsonb, ${JSON.stringify(input.receiver)}::jsonb
        )
      `);

      return {
        ...input,
        id: transaction.id,
        status: transaction.status,
        createdAt: transaction.createdAt,
        callbackUrl: null,
      };
    });
  }

  async findById(
    id: string,
    userId: string,
  ): Promise<Sep31TransactionRecord | null> {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        userId: string;
        amount: string;
        outputAmount: string;
        fee: string;
        rate: string;
        status: string;
        reference: string | null;
        createdAt: Date;
        sourceAsset: string;
        destinationAsset: string;
        sender: Record<string, unknown>;
        receiver: Record<string, unknown>;
        callbackUrl: string | null;
      }>
    >(Prisma.sql`
      SELECT r."id", r."userId", r."amount"::text, r."outputAmount"::text,
        r."fee"::text, r."rate"::text, r."status", r."reference", r."createdAt",
        m."sourceAsset", m."destinationAsset", m."sender", m."receiver", m."callbackUrl"
      FROM "RemittanceTransaction" r
      JOIN "Sep31TransactionMetadata" m ON m."transactionId" = r."id"
      WHERE r."id" = ${id} AND r."userId" = ${userId} AND r."provider" = 'SEP-31'
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      userId: row.userId,
      amount: Number(row.amount),
      outputAmount: Number(row.outputAmount),
      fee: Number(row.fee),
      rate: Number(row.rate),
      status: row.status,
      source: parseAsset(row.sourceAsset, "source_asset"),
      destination: parseAsset(row.destinationAsset, "destination_asset"),
      sender: row.sender,
      receiver: row.receiver,
      callbackUrl: row.callbackUrl,
      ...(row.reference === null ? {} : { reference: row.reference }),
      createdAt: row.createdAt,
    };
  }

  async setCallback(
    id: string,
    userId: string,
    callbackUrl: string,
  ): Promise<void> {
    const result = await prisma.$executeRaw(Prisma.sql`
      UPDATE "Sep31TransactionMetadata" m
      SET "callbackUrl" = ${callbackUrl}
      FROM "RemittanceTransaction" r
      WHERE m."transactionId" = r."id"
        AND r."id" = ${id} AND r."userId" = ${userId} AND r."provider" = 'SEP-31'
    `);
    if (result !== 1) throw new Error("SEP-31 transaction not found");
  }
}

export class Sep31Service {
  constructor(
    private readonly repository: Sep31Repository = new PrismaSep31Repository(),
    private readonly pairs: Sep31AssetPair[] = readAssetPairs(),
    private readonly fx = new RemittanceFxEngine(),
  ) {}

  getInfo() {
    if (this.pairs.length === 0) {
      throw new Error("SEP-31 is disabled: no SEP31_ASSET_PAIRS configured");
    }
    return {
      receive: Object.fromEntries(
        [...new Set(this.pairs.map((pair) => pair.destination))].map((asset) => [
          asset,
          { enabled: true },
        ]),
      ),
      asset_pairs: this.pairs,
    };
  }

  async createTransaction(userId: string, body: unknown) {
    if (!userId) throw new Sep31ValidationError("Authenticated user is required");
    const payload = asObject(body, "request body");
    const source = parseAsset(payload.source_asset, "source_asset");
    const destination = parseAsset(payload.destination_asset, "destination_asset");
    if (
      !this.pairs.some(
        (pair) => pair.source === source.id && pair.destination === destination.id,
      )
    ) {
      throw new Sep31ValidationError("The source and destination asset pair is not supported");
    }

    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Sep31ValidationError("amount must be a positive number");
    }
    const reference = payload.idempotency_key;
    if (
      reference !== undefined &&
      (typeof reference !== "string" || reference.length > 128)
    ) {
      throw new Sep31ValidationError("idempotency_key must be a string up to 128 characters");
    }

    const quote = await this.fx.getQuote({
      sourceCurrency: source.code,
      targetCurrency: destination.code,
      sourceAmount: amount,
    });
    return this.repository.create({
      userId,
      amount,
      source,
      destination,
      sender: asObject(payload.sender, "sender"),
      receiver: asObject(payload.receiver, "receiver"),
      ...(typeof reference === "string" ? { reference } : {}),
      outputAmount: quote.targetAmount,
      fee: quote.feeAmount,
      rate: quote.exchangeRate,
    });
  }

  async getTransaction(id: string, userId: string) {
    return this.repository.findById(id, userId);
  }

  async registerCallback(id: string, userId: string, rawUrl: unknown) {
    if (typeof rawUrl !== "string") {
      throw new Sep31ValidationError("callback url is required");
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Sep31ValidationError("callback url must be a valid HTTPS URL");
    }
    if (url.protocol !== "https:") {
      throw new Sep31ValidationError("callback url must use HTTPS");
    }
    if (!allowedCallbackHosts().has(url.hostname.toLowerCase())) {
      throw new Sep31ValidationError("callback host is not allowlisted");
    }
    if (!(await this.repository.findById(id, userId))) {
      throw new Error("SEP-31 transaction not found");
    }
    await this.repository.setCallback(id, userId, url.toString());
    return { id, callback: url.toString() };
  }
}

export async function dispatchSep31CompletionCallback(
  transactionId: string,
  status: string,
): Promise<void> {
  const rows = await prisma.$queryRaw<
    Array<{
      callbackUrl: string | null;
      amount: string;
      outputAmount: string;
      fee: string;
      sourceAsset: string;
      destinationAsset: string;
    }>
  >(Prisma.sql`
    SELECT m."callbackUrl", r."amount"::text, r."outputAmount"::text,
      r."fee"::text, m."sourceAsset", m."destinationAsset"
    FROM "RemittanceTransaction" r
    JOIN "Sep31TransactionMetadata" m ON m."transactionId" = r."id"
    WHERE r."id" = ${transactionId} AND r."provider" = 'SEP-31'
    LIMIT 1
  `);
  const transaction = rows[0];
  if (!transaction?.callbackUrl) return;

  await axios.post(
    transaction.callbackUrl,
    {
      id: transactionId,
      status,
      amount_in: transaction.amount,
      amount_out: transaction.outputAmount,
      fee: transaction.fee,
      source_asset: transaction.sourceAsset,
      destination_asset: transaction.destinationAsset,
    },
    { timeout: 5000 },
  );
}