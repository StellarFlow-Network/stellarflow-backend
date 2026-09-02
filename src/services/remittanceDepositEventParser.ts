export interface RemittanceDepositEvent {
  user: string;
  token: string;
  amount: number;
  quoteId?: string;
  transactionHash?: string;
}

export interface RawSorobanDepositEvent {
  topics?: unknown[];
  data?: Record<string, unknown>;
  txHash?: string;
  transactionHash?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readAmount(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }

  return NaN;
}

export function parseRemittanceDepositEvent(
  event: RawSorobanDepositEvent,
): RemittanceDepositEvent {
  const eventType = readString(event.topics?.[0])?.toLowerCase();
  if (eventType !== "deposit") {
    throw new Error("Expected a deposit event");
  }

  const data = event.data ?? {};
  const user = readString(data.user);
  const token = readString(data.token);
  const amount = readAmount(data.amount);

  if (!user) {
    throw new Error("Deposit event missing user");
  }

  if (!token) {
    throw new Error("Deposit event missing token");
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Deposit event amount must be positive");
  }

  const parsed: RemittanceDepositEvent = {
    user,
    token,
    amount,
  };

  const quoteId = readString(data.quoteId) ?? readString(data.quote_id);
  if (quoteId) {
    parsed.quoteId = quoteId;
  }

  const transactionHash =
    readString(event.txHash) ?? readString(event.transactionHash);
  if (transactionHash) {
    parsed.transactionHash = transactionHash;
  }

  return parsed;
}
