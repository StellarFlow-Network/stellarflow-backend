/**
 * SEP-24 interactive flow handler (Issue #1015)
 *
 * Backs the hosted deposit/withdrawal webview described in
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 *
 * Lifecycle
 * ---------
 *  1. A wallet calls the (authenticated) initiation endpoint. We create a
 *     session and return an interactive URL carrying a short-lived signed token.
 *  2. The user opens that URL in a webview, sees a responsive form and submits
 *     their payout details.
 *  3. We seal the details, move the transaction to `pending_user_transfer_start`
 *     and hand the wallet a signed completion token through its callback
 *     (`postMessage` to the opener/parent window, or a server-side POST to an
 *     allow-listed URL).
 *
 * Security notes
 * --------------
 *  - Both tokens are HS256 JWTs signed with SEP24_INTERACTIVE_SECRET and scoped
 *    by `typ`, so one cannot be replayed as the other.
 *  - Payout details are PII: they are AES-256-GCM sealed before being stored.
 *  - A session accepts exactly one submission.
 *  - Callback URLs and the wallet origin must be on SEP24_ALLOWED_CALLBACK_ORIGINS;
 *    anything else is refused so the endpoint can't be used for SSRF or to leak
 *    a completion token to an arbitrary site.
 */

/* global AbortController, AbortSignal */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Sep24Operation = "deposit" | "withdraw";

/** SEP-24 transaction statuses this flow moves through. */
export type Sep24Status = "incomplete" | "pending_user_transfer_start";

export interface PayoutDetails {
  fullName: string;
  email?: string;
  bankName: string;
  accountNumber: string;
  amount?: string;
}

export interface Sep24Session {
  id: string;
  operation: Sep24Operation;
  assetCode: string;
  /** Stellar account of the user, when the wallet supplied it. */
  account?: string;
  amount?: string;
  /** Origin of the wallet (from `wallet_url`), already checked against the allowlist. */
  clientOrigin?: string;
  status: Sep24Status;
  createdAt: number;
  /** AES-256-GCM sealed PayoutDetails, present once submitted. */
  sealedPayout?: string;
}

export interface Sep24SessionStore {
  save(session: Sep24Session, ttlSeconds: number): Promise<void>;
  get(id: string): Promise<Sep24Session | null>;
  /**
   * Atomically record the submission. Resolves to the updated session, or null
   * if the session doesn't exist or was already submitted.
   */
  completeOnce(id: string, sealedPayout: string): Promise<Sep24Session | null>;
}

export type CallbackTarget =
  | { kind: "none" }
  | { kind: "postMessage"; targetOrigin: string | null }
  | { kind: "url"; url: string };

export interface Sep24Config {
  secret: string;
  /** Lifetime of the URL token handed to the wallet. Default 15 minutes. */
  interactiveTokenTtlSeconds: number;
  /** Lifetime of the completion token handed back to the wallet. Default 5 minutes. */
  completionTokenTtlSeconds: number;
  /** How long an unfinished/finished session is retained. Default 1 hour. */
  sessionTtlSeconds: number;
  /** Public origin of this service (no path), used to build interactive URLs. */
  baseUrl: string;
  /** Origins allowed as wallet origins and URL callbacks. */
  allowedCallbackOrigins: string[];
  /** Assets the anchor supports; empty means any well-formed code. */
  supportedAssets: string[];
  /** Permit http://localhost callbacks (development only). */
  allowInsecureLocalhost: boolean;
}

export class Sep24Error extends Error {
  constructor(
    public readonly code:
      | "INVALID_TOKEN"
      | "EXPIRED_TOKEN"
      | "SESSION_NOT_FOUND"
      | "ALREADY_SUBMITTED"
      | "VALIDATION_ERROR"
      | "CALLBACK_NOT_ALLOWED"
      | "UNSUPPORTED_ASSET",
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "Sep24Error";
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns null unless the flow is fully configured: a signing secret of at
 * least 32 characters and an absolute public base URL (SEP-24 requires the
 * interactive URL to be absolute). Failing closed beats guessing a default.
 */
export function sep24ConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): Sep24Config | null {
  const secret = env.SEP24_INTERACTIVE_SECRET;
  if (!secret || secret.length < 32) return null;

  const baseUrl = normalizeOrigin(env.SEP24_INTERACTIVE_BASE_URL ?? "");
  if (!baseUrl) return null;

  const splitList = (raw: string | undefined): string[] =>
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    secret,
    interactiveTokenTtlSeconds: positiveInt(env.SEP24_INTERACTIVE_TOKEN_TTL_SECONDS, 15 * 60),
    completionTokenTtlSeconds: positiveInt(env.SEP24_COMPLETION_TOKEN_TTL_SECONDS, 5 * 60),
    sessionTtlSeconds: positiveInt(env.SEP24_SESSION_TTL_SECONDS, 60 * 60),
    baseUrl,
    allowedCallbackOrigins: splitList(env.SEP24_ALLOWED_CALLBACK_ORIGINS)
      .map(normalizeOrigin)
      .filter((o): o is string => o !== null),
    supportedAssets: splitList(env.SEP24_SUPPORTED_ASSETS).map((a) => a.toUpperCase()),
    allowInsecureLocalhost: env.NODE_ENV !== "production",
  };
}

// ─── Session stores ───────────────────────────────────────────────────────────

/** Process-local store; fine for tests and single-instance development. */
export class InMemorySep24SessionStore implements Sep24SessionStore {
  private readonly sessions = new Map<string, { session: Sep24Session; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async save(session: Sep24Session, ttlSeconds: number): Promise<void> {
    this.sessions.set(session.id, {
      session: { ...session },
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async get(id: string): Promise<Sep24Session | null> {
    const entry = this.sessions.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return { ...entry.session };
  }

  async completeOnce(id: string, sealedPayout: string): Promise<Sep24Session | null> {
    // No await between the check and the write: this is what makes
    // "first submission wins" atomic on a single-threaded event loop.
    const entry = this.sessions.get(id);
    if (!entry || entry.expiresAt <= this.now() || entry.session.sealedPayout) {
      return null;
    }
    entry.session = {
      ...entry.session,
      status: "pending_user_transfer_start",
      sealedPayout,
    };
    return { ...entry.session };
  }
}

/** The subset of the node-redis client the store needs (keeps it mockable). */
export interface RedisLike {
  set(
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean; KEEPTTL?: boolean },
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  ttl(key: string): Promise<number>;
}

/** Shared store so any instance can serve the webview for a session. */
export class RedisSep24SessionStore implements Sep24SessionStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = "sep24:session:",
  ) {}

  private key(id: string): string {
    return `${this.prefix}${id}`;
  }

  async save(session: Sep24Session, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.key(session.id), JSON.stringify(session), {
      EX: ttlSeconds,
    });
  }

  async get(id: string): Promise<Sep24Session | null> {
    const raw = await this.redis.get(this.key(id));
    return raw ? (JSON.parse(raw) as Sep24Session) : null;
  }

  async completeOnce(id: string, sealedPayout: string): Promise<Sep24Session | null> {
    // SET NX on a separate marker gives an atomic "first submission wins".
    const ttl = await this.redis.ttl(this.key(id));
    if (ttl <= 0) return null;
    const claimed = await this.redis.set(`${this.key(id)}:done`, "1", {
      NX: true,
      EX: ttl,
    });
    if (claimed !== "OK") return null;

    const session = await this.get(id);
    if (!session) return null;
    const updated: Sep24Session = {
      ...session,
      status: "pending_user_transfer_start",
      sealedPayout,
    };
    await this.redis.set(this.key(id), JSON.stringify(updated), { EX: ttl });
    return updated;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const ACCOUNT_NUMBER_RE = /^[A-Za-z0-9]{4,34}$/;
const AMOUNT_RE = /^\d{1,15}(\.\d{1,7})?$/;
// Letters (any script), marks, spaces and common name punctuation.
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'’&()/-]*$/u;

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export function validatePayoutDetails(
  input: Record<string, unknown>,
): { ok: true; value: PayoutDetails } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const fullName = str(input.full_name);
  if (fullName.length < 2 || fullName.length > 100 || !NAME_RE.test(fullName)) {
    errors.full_name = "Enter the account holder's full name (2–100 characters).";
  }

  const bankName = str(input.bank_name);
  if (bankName.length < 2 || bankName.length > 100 || !NAME_RE.test(bankName)) {
    errors.bank_name = "Enter your bank's name (2–100 characters).";
  }

  // Spaces and dashes are common in pasted IBANs / account numbers.
  const accountNumber = str(input.account_number).replace(/[\s-]/g, "");
  if (!ACCOUNT_NUMBER_RE.test(accountNumber)) {
    errors.account_number = "Enter a valid account number (4–34 letters or digits).";
  }

  const email = str(input.email);
  if (email && !EMAIL_RE.test(email)) {
    errors.email = "Enter a valid email address or leave it blank.";
  }

  const amount = str(input.amount);
  if (amount && (!AMOUNT_RE.test(amount) || Number(amount) <= 0)) {
    errors.amount = "Enter a positive amount with up to 7 decimal places.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const value: PayoutDetails = { fullName, bankName, accountNumber };
  if (email) value.email = email;
  if (amount) value.amount = amount;
  return { ok: true, value };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface InitiateInput {
  operation: Sep24Operation;
  assetCode: unknown;
  account?: unknown;
  amount?: unknown;
  walletUrl?: unknown;
}

export interface InitiateResult {
  type: "interactive_customer_info_needed";
  url: string;
  id: string;
}

export interface CompletionResult {
  transaction: {
    id: string;
    status: Sep24Status;
    more_info_url: string;
  };
  completionToken: string;
  callback: CallbackTarget;
}

export class Sep24InteractiveService {
  private readonly sealKey: Buffer;

  constructor(
    private readonly store: Sep24SessionStore,
    readonly config: Sep24Config,
    private readonly deps: {
      now?: () => number;
      randomId?: () => string;
    } = {},
  ) {
    this.sealKey = Buffer.from(
      crypto.hkdfSync("sha256", config.secret, "", "sep24-payout-seal", 32),
    );
  }

  private nowSeconds(): number {
    return Math.floor((this.deps.now ?? Date.now)() / 1000);
  }

  // ── Tokens ──────────────────────────────────────────────────────────────

  private sign(
    typ: "sep24-interactive" | "sep24-completion",
    payload: Record<string, unknown>,
    ttlSeconds: number,
  ): string {
    const iat = this.nowSeconds();
    return jwt.sign({ ...payload, typ, iat, exp: iat + ttlSeconds }, this.config.secret, {
      algorithm: "HS256",
      noTimestamp: true,
    });
  }

  private verify(token: string, typ: "sep24-interactive" | "sep24-completion") {
    try {
      const decoded = jwt.verify(token, this.config.secret, {
        algorithms: ["HS256"],
        clockTimestamp: this.nowSeconds(),
      }) as jwt.JwtPayload;
      if (decoded.typ !== typ || typeof decoded.sub !== "string") {
        throw new Sep24Error("INVALID_TOKEN", "Token is not valid for this operation.");
      }
      return decoded as jwt.JwtPayload & { sub: string };
    } catch (err) {
      if (err instanceof Sep24Error) throw err;
      if (err instanceof jwt.TokenExpiredError) {
        throw new Sep24Error("EXPIRED_TOKEN", "This link has expired. Please restart from your wallet.");
      }
      throw new Sep24Error("INVALID_TOKEN", "This link is not valid.");
    }
  }

  /** Verifies a completion token (for the wallet / downstream services). */
  verifyCompletionToken(token: string): { transactionId: string; status: Sep24Status } {
    const decoded = this.verify(token, "sep24-completion");
    return { transactionId: decoded.sub, status: decoded.status as Sep24Status };
  }

  // ── Callback / origin policy ────────────────────────────────────────────

  private isAllowedOrigin(origin: string): boolean {
    const normalized = normalizeOrigin(origin);
    return normalized !== null && this.config.allowedCallbackOrigins.includes(normalized);
  }

  private isSecureOrLocalDev(url: URL): boolean {
    if (url.protocol === "https:") return true;
    return (
      this.config.allowInsecureLocalhost &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  }

  /**
   * Wallet origin from the optional `wallet_url`. Anything not on the allowlist
   * is ignored (the parameter is informational in SEP-24), which simply means
   * no `postMessage` target is available for this session.
   */
  private resolveClientOrigin(walletUrl: unknown): string | undefined {
    const origin = normalizeOrigin(str(walletUrl));
    if (!origin || !this.isAllowedOrigin(origin) || !this.isSecureOrLocalDev(new URL(origin))) {
      return undefined;
    }
    return origin;
  }

  /**
   * Decide where to deliver the completion result.
   *  - `postMessage` needs a known, allow-listed wallet origin so the token is
   *    never broadcast with a wildcard target.
   *  - A URL callback must be https (or localhost in dev) and allow-listed.
   */
  resolveCallback(raw: unknown, session: Sep24Session): CallbackTarget {
    const value = str(raw);
    if (!value) return { kind: "none" };

    if (value === "postMessage") {
      return { kind: "postMessage", targetOrigin: session.clientOrigin ?? null };
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Sep24Error("CALLBACK_NOT_ALLOWED", "callback must be 'postMessage' or an absolute URL.");
    }
    if (url.username || url.password || !this.isSecureOrLocalDev(url) || !this.isAllowedOrigin(url.origin)) {
      throw new Sep24Error("CALLBACK_NOT_ALLOWED", "callback URL is not on the list of permitted origins.");
    }
    return { kind: "url", url: url.toString() };
  }

  // ── Operations ──────────────────────────────────────────────────────────

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const assetCode = str(input.assetCode).toUpperCase();
    if (!ASSET_CODE_RE.test(assetCode)) {
      throw new Sep24Error("VALIDATION_ERROR", "asset_code is required (1–12 letters or digits).", {
        asset_code: "Invalid asset code.",
      });
    }
    if (
      this.config.supportedAssets.length > 0 &&
      !this.config.supportedAssets.includes(assetCode)
    ) {
      throw new Sep24Error("UNSUPPORTED_ASSET", `Asset ${assetCode} is not supported.`);
    }

    const account = str(input.account);
    if (account && !STELLAR_ACCOUNT_RE.test(account)) {
      throw new Sep24Error("VALIDATION_ERROR", "account must be a valid Stellar public key.", {
        account: "Invalid Stellar account.",
      });
    }
    const amount = str(input.amount);
    if (amount && (!AMOUNT_RE.test(amount) || Number(amount) <= 0)) {
      throw new Sep24Error("VALIDATION_ERROR", "amount must be a positive decimal.", {
        amount: "Invalid amount.",
      });
    }

    const clientOrigin = this.resolveClientOrigin(input.walletUrl);

    const id = (this.deps.randomId ?? crypto.randomUUID)();
    const session: Sep24Session = {
      id,
      operation: input.operation,
      assetCode,
      status: "incomplete",
      createdAt: this.nowSeconds(),
    };
    if (account) session.account = account;
    if (amount) session.amount = amount;
    if (clientOrigin) session.clientOrigin = clientOrigin;
    await this.store.save(session, this.config.sessionTtlSeconds);

    const token = this.sign(
      "sep24-interactive",
      { sub: id },
      this.config.interactiveTokenTtlSeconds,
    );
    return {
      type: "interactive_customer_info_needed",
      url: `${this.config.baseUrl}/sep24/interactive?token=${encodeURIComponent(token)}`,
      id,
    };
  }

  /** Loads the session behind an interactive token (for rendering the form). */
  async openSession(token: string): Promise<Sep24Session> {
    const decoded = this.verify(token, "sep24-interactive");
    const session = await this.store.get(decoded.sub);
    if (!session) {
      throw new Sep24Error("SESSION_NOT_FOUND", "This transaction could not be found or has expired.");
    }
    return session;
  }

  async submit(token: string, form: Record<string, unknown>): Promise<CompletionResult & { session: Sep24Session }> {
    const session = await this.openSession(token);
    if (session.sealedPayout) {
      throw new Sep24Error("ALREADY_SUBMITTED", "This form has already been submitted.");
    }

    // Resolve the callback before consuming the one-shot session so a bad
    // callback doesn't burn the user's only submission.
    const callback = this.resolveCallback(form.callback, session);

    const validated = validatePayoutDetails(form);
    if (!validated.ok) {
      throw new Sep24Error("VALIDATION_ERROR", "Some details need attention.", validated.errors);
    }

    const completed = await this.store.completeOnce(
      session.id,
      this.seal(validated.value),
    );
    if (!completed) {
      throw new Sep24Error("ALREADY_SUBMITTED", "This form has already been submitted.");
    }

    const completionToken = this.sign(
      "sep24-completion",
      { sub: completed.id, status: completed.status, op: completed.operation },
      this.config.completionTokenTtlSeconds,
    );

    return {
      session: completed,
      transaction: {
        id: completed.id,
        status: completed.status,
        more_info_url: `${this.config.baseUrl}/sep24/interactive?token=${encodeURIComponent(
          this.sign("sep24-interactive", { sub: completed.id }, this.config.interactiveTokenTtlSeconds),
        )}`,
      },
      completionToken,
      callback,
    };
  }

  /** Server-side access to the submitted payout details (e.g. for payout relay). */
  async getPayoutDetails(id: string): Promise<PayoutDetails | null> {
    const session = await this.store.get(id);
    return session?.sealedPayout ? this.unseal(session.sealedPayout) : null;
  }

  // ── Sealing (AES-256-GCM) ───────────────────────────────────────────────

  private seal(details: PayoutDetails): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.sealKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(details), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  private unseal(sealed: string): PayoutDetails {
    const raw = Buffer.from(sealed, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.sealKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as PayoutDetails;
  }
}

// ─── Callback delivery ────────────────────────────────────────────────────────

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/**
 * POST the transaction + completion token to a URL callback. Best-effort: the
 * user's submission already succeeded, so failures are reported, not thrown.
 * Redirects are refused so an allow-listed host can't bounce us elsewhere.
 */
export async function deliverUrlCallback(
  result: Pick<CompletionResult, "transaction" | "completionToken">,
  url: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 5000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transaction: result.transaction,
        completion_token: result.completionToken,
      }),
      redirect: "error",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
