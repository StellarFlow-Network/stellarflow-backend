/* global AbortSignal */
/**
 * Unit tests for the SEP-24 interactive flow service and views (Issue #1015).
 */
import { describe, it, expect, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import {
  InMemorySep24SessionStore,
  RedisSep24SessionStore,
  Sep24Error,
  Sep24InteractiveService,
  deliverUrlCallback,
  sep24ConfigFromEnv,
  validatePayoutDetails,
  type RedisLike,
  type Sep24Config,
  type Sep24Session,
} from "../src/services/sep24Interactive";
import {
  escapeHtml,
  jsonForScript,
  renderComplete,
  renderForm,
} from "../src/services/sep24InteractiveView";

const SECRET = "s".repeat(40);
const WALLET = "https://wallet.example.com";
const ACCOUNT = "G" + "A".repeat(55);

const baseConfig = (over: Partial<Sep24Config> = {}): Sep24Config => ({
  secret: SECRET,
  interactiveTokenTtlSeconds: 900,
  completionTokenTtlSeconds: 300,
  sessionTtlSeconds: 3600,
  baseUrl: "https://anchor.example.com",
  allowedCallbackOrigins: [WALLET, "https://hooks.example.com"],
  supportedAssets: [],
  allowInsecureLocalhost: false,
  ...over,
});

function makeService(over: Partial<Sep24Config> = {}) {
  let nowMs = 1_800_000_000_000;
  const store = new InMemorySep24SessionStore(() => nowMs);
  let n = 0;
  const service = new Sep24InteractiveService(store, baseConfig(over), {
    now: () => nowMs,
    randomId: () => `tx-${++n}`,
  });
  return { service, store, advance: (s: number) => (nowMs += s * 1000) };
}

const tokenFrom = (url: string) => new URL(url).searchParams.get("token")!;

const goodForm = {
  full_name: "Ada Lovelace",
  bank_name: "First Bank",
  account_number: "0123 4567-89",
  email: "ada@example.com",
  amount: "100.50",
};

describe("sep24ConfigFromEnv", () => {
  const env = {
    SEP24_INTERACTIVE_SECRET: SECRET,
    SEP24_INTERACTIVE_BASE_URL: "https://anchor.example.com/",
  };

  it("fails closed without a strong secret or a base URL", () => {
    expect(sep24ConfigFromEnv({})).toBeNull();
    expect(sep24ConfigFromEnv({ ...env, SEP24_INTERACTIVE_SECRET: "short" })).toBeNull();
    expect(sep24ConfigFromEnv({ ...env, SEP24_INTERACTIVE_BASE_URL: "" })).toBeNull();
    expect(sep24ConfigFromEnv({ ...env, SEP24_INTERACTIVE_BASE_URL: "not a url" })).toBeNull();
  });

  it("normalises origins, lists and defaults", () => {
    const cfg = sep24ConfigFromEnv({
      ...env,
      SEP24_ALLOWED_CALLBACK_ORIGINS: " https://Wallet.example.com/path , ftp://bad , https://b.example ",
      SEP24_SUPPORTED_ASSETS: "usdc, ngn",
      NODE_ENV: "production",
    })!;

    expect(cfg.baseUrl).toBe("https://anchor.example.com");
    expect(cfg.allowedCallbackOrigins).toEqual(["https://wallet.example.com", "https://b.example"]);
    expect(cfg.supportedAssets).toEqual(["USDC", "NGN"]);
    expect(cfg.interactiveTokenTtlSeconds).toBe(900);
    expect(cfg.allowInsecureLocalhost).toBe(false);
  });
});

describe("validatePayoutDetails", () => {
  it("accepts and normalises good input", () => {
    const result = validatePayoutDetails(goodForm);
    expect(result).toEqual({
      ok: true,
      value: {
        fullName: "Ada Lovelace",
        bankName: "First Bank",
        accountNumber: "0123456789",
        email: "ada@example.com",
        amount: "100.50",
      },
    });
  });

  it("treats email and amount as optional", () => {
    const result = validatePayoutDetails({ ...goodForm, email: "", amount: "" });
    expect(result.ok && result.value).toEqual({
      fullName: "Ada Lovelace",
      bankName: "First Bank",
      accountNumber: "0123456789",
    });
  });

  it("supports non-latin names", () => {
    expect(validatePayoutDetails({ ...goodForm, full_name: "Chukwuemeka Ọkọ́nkwọ" }).ok).toBe(true);
    expect(validatePayoutDetails({ ...goodForm, full_name: "李 小龙" }).ok).toBe(true);
  });

  it.each([
    ["full_name", { full_name: "A" }],
    ["full_name", { full_name: "<script>alert(1)</script>" }],
    ["bank_name", { bank_name: "" }],
    ["account_number", { account_number: "12" }],
    ["account_number", { account_number: "12 34 !!" }],
    ["email", { email: "nope" }],
    ["amount", { amount: "-5" }],
    ["amount", { amount: "0" }],
    ["amount", { amount: "1.123456789" }],
    ["amount", { amount: "1e9" }],
  ])("rejects a bad %s: %j", (field, override) => {
    const result = validatePayoutDetails({ ...goodForm, ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toContain(field);
  });

  it("ignores non-string input instead of throwing", () => {
    const result = validatePayoutDetails({ full_name: ["a"], bank_name: { x: 1 } });
    expect(result.ok).toBe(false);
  });
});

describe("initiate", () => {
  it("creates a session and returns a SEP-24 interactive URL", async () => {
    const { service, store } = makeService();

    const result = await service.initiate({
      operation: "withdraw",
      assetCode: "usdc",
      account: ACCOUNT,
      amount: "25",
      walletUrl: `${WALLET}/app`,
    });

    expect(result.type).toBe("interactive_customer_info_needed");
    expect(result.id).toBe("tx-1");
    expect(result.url).toMatch(/^https:\/\/anchor\.example\.com\/sep24\/interactive\?token=/);
    expect(await store.get("tx-1")).toMatchObject({
      operation: "withdraw",
      assetCode: "USDC",
      account: ACCOUNT,
      amount: "25",
      clientOrigin: WALLET,
      status: "incomplete",
    });
  });

  it("ignores a wallet_url that is not allow-listed", async () => {
    const { service, store } = makeService();
    await service.initiate({ operation: "deposit", assetCode: "USDC", walletUrl: "https://evil.example" });
    expect((await store.get("tx-1"))!.clientOrigin).toBeUndefined();
  });

  it.each([
    [{ assetCode: undefined }, "VALIDATION_ERROR"],
    [{ assetCode: "US-DC" }, "VALIDATION_ERROR"],
    [{ assetCode: "USDC", account: "GBAD" }, "VALIDATION_ERROR"],
    [{ assetCode: "USDC", amount: "-1" }, "VALIDATION_ERROR"],
  ])("rejects %j", async (input, code) => {
    const { service } = makeService();
    await expect(service.initiate({ operation: "deposit", ...input })).rejects.toMatchObject({ code });
  });

  it("enforces the supported-asset list", async () => {
    const { service } = makeService({ supportedAssets: ["USDC"] });
    await expect(service.initiate({ operation: "deposit", assetCode: "XLM" })).rejects.toMatchObject({
      code: "UNSUPPORTED_ASSET",
    });
    await expect(service.initiate({ operation: "deposit", assetCode: "usdc" })).resolves.toBeDefined();
  });
});

describe("tokens", () => {
  it("opens the session behind a valid token", async () => {
    const { service } = makeService();
    const { url } = await service.initiate({ operation: "deposit", assetCode: "USDC" });
    expect((await service.openSession(tokenFrom(url))).id).toBe("tx-1");
  });

  it("rejects an expired token with a distinct error", async () => {
    const { service, advance } = makeService();
    const { url } = await service.initiate({ operation: "deposit", assetCode: "USDC" });

    advance(901);

    await expect(service.openSession(tokenFrom(url))).rejects.toMatchObject({ code: "EXPIRED_TOKEN" });
  });

  it("rejects tampered, foreign-secret and garbage tokens", async () => {
    const { service } = makeService();
    const { url } = await service.initiate({ operation: "deposit", assetCode: "USDC" });
    const token = tokenFrom(url);

    await expect(service.openSession(token.slice(0, -2) + "xx")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    await expect(service.openSession("garbage")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    const foreign = jwt.sign({ sub: "tx-1", typ: "sep24-interactive" }, "x".repeat(40));
    await expect(service.openSession(foreign)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("rejects alg=none tokens", async () => {
    const { service } = makeService();
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "tx-1", typ: "sep24-interactive" }),
    ).toString("base64url")}.`;
    await expect(service.openSession(none)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("does not accept a completion token where an interactive token is required", async () => {
    const { service } = makeService();
    const { url } = await service.initiate({ operation: "deposit", assetCode: "USDC" });
    const done = await service.submit(tokenFrom(url), goodForm);

    await expect(service.openSession(done.completionToken)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("reports a missing session for a validly signed token", async () => {
    const { service } = makeService();
    // The service under test runs on a fake clock (1_800_000_000 s), so sign relative to it.
    const orphan = jwt.sign({ sub: "ghost", typ: "sep24-interactive", exp: 1_800_000_000 + 60 }, SECRET);
    await expect(service.openSession(orphan)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});

describe("submit", () => {
  async function started(over: Partial<Sep24Config> = {}, walletUrl: string | undefined = WALLET) {
    const ctx = makeService(over);
    const { url } = await ctx.service.initiate({
      operation: "withdraw",
      assetCode: "USDC",
      ...(walletUrl ? { walletUrl } : {}),
    });
    return { ...ctx, token: tokenFrom(url) };
  }

  it("stores sealed details, advances status and issues a verifiable completion token", async () => {
    const { service, store, token } = await started();

    const result = await service.submit(token, goodForm);

    expect(result.transaction).toMatchObject({ id: "tx-1", status: "pending_user_transfer_start" });
    expect(service.verifyCompletionToken(result.completionToken)).toEqual({
      transactionId: "tx-1",
      status: "pending_user_transfer_start",
    });

    const stored = (await store.get("tx-1")) as Sep24Session;
    expect(stored.status).toBe("pending_user_transfer_start");
    // PII must not be stored in the clear.
    expect(stored.sealedPayout).toBeDefined();
    expect(stored.sealedPayout).not.toContain("Lovelace");
    expect(stored.sealedPayout).not.toContain("0123456789");
    expect(await service.getPayoutDetails("tx-1")).toMatchObject({
      fullName: "Ada Lovelace",
      accountNumber: "0123456789",
    });
  });

  it("uses a fresh IV per seal", async () => {
    const a = await started();
    const b = await started();
    await a.service.submit(a.token, goodForm);
    await b.service.submit(b.token, goodForm);
    expect((await a.store.get("tx-1"))!.sealedPayout).not.toBe((await b.store.get("tx-1"))!.sealedPayout);
  });

  it("detects tampering with sealed data", async () => {
    const { service, store, token } = await started();
    await service.submit(token, goodForm);
    const session = (await store.get("tx-1"))!;
    const raw = Buffer.from(session.sealedPayout!, "base64url");
    raw[raw.length - 1]! ^= 0xff;
    await store.save({ ...session, sealedPayout: raw.toString("base64url") }, 60);

    await expect(service.getPayoutDetails("tx-1")).rejects.toThrow();
  });

  it("accepts only the first of two concurrent submissions", async () => {
    const { service, token } = await started();

    const results = await Promise.allSettled([
      service.submit(token, goodForm),
      service.submit(token, goodForm),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "ALREADY_SUBMITTED" });
  });

  it("rejects a repeat submission", async () => {
    const { service, token } = await started();
    await service.submit(token, goodForm);
    await expect(service.submit(token, goodForm)).rejects.toMatchObject({ code: "ALREADY_SUBMITTED" });
  });

  it("returns per-field errors and leaves the session open for a retry", async () => {
    const { service, token } = await started();

    const err = await service.submit(token, { ...goodForm, account_number: "1", email: "x" }).catch((e) => e);

    expect(err).toBeInstanceOf(Sep24Error);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(err.fieldErrors)).toEqual(expect.arrayContaining(["account_number", "email"]));
    await expect(service.submit(token, goodForm)).resolves.toBeDefined();
  });

  it("does not burn the session when the callback is refused", async () => {
    const { service, token } = await started();

    await expect(
      service.submit(token, { ...goodForm, callback: "https://evil.example/hook" }),
    ).rejects.toMatchObject({ code: "CALLBACK_NOT_ALLOWED" });

    await expect(service.submit(token, goodForm)).resolves.toBeDefined();
  });

  it("expires the completion token quickly", async () => {
    const { service, advance, token } = await started();
    const { completionToken } = await service.submit(token, goodForm);

    advance(301);

    expect(() => service.verifyCompletionToken(completionToken)).toThrow(/expired/i);
  });
});

describe("resolveCallback", () => {
  const session = (clientOrigin?: string): Sep24Session => ({
    id: "tx-1",
    operation: "deposit",
    assetCode: "USDC",
    status: "incomplete",
    createdAt: 0,
    ...(clientOrigin ? { clientOrigin } : {}),
  });
  const { service } = makeService();

  it("treats an empty callback as none", () => {
    expect(service.resolveCallback(undefined, session())).toEqual({ kind: "none" });
    expect(service.resolveCallback("  ", session())).toEqual({ kind: "none" });
  });

  it("targets postMessage at the known wallet origin, never a wildcard", () => {
    expect(service.resolveCallback("postMessage", session(WALLET))).toEqual({
      kind: "postMessage",
      targetOrigin: WALLET,
    });
    expect(service.resolveCallback("postMessage", session())).toEqual({
      kind: "postMessage",
      targetOrigin: null,
    });
  });

  it("accepts an allow-listed https URL", () => {
    expect(service.resolveCallback("https://hooks.example.com/sep24?x=1", session())).toEqual({
      kind: "url",
      url: "https://hooks.example.com/sep24?x=1",
    });
  });

  it.each([
    "https://evil.example/hook",
    "http://hooks.example.com/hook", // downgrade
    "https://user:pw@hooks.example.com/hook", // credentials in URL
    "javascript:alert(1)",
    "//hooks.example.com/hook",
    "not a url",
    "https://hooks.example.com.evil.example/hook", // suffix trick
  ])("refuses %s", (callback) => {
    expect(() => service.resolveCallback(callback, session())).toThrow(Sep24Error);
  });

  it("allows http://localhost only outside production", () => {
    const dev = makeService({ allowedCallbackOrigins: ["http://localhost:3000"], allowInsecureLocalhost: true }).service;
    const prod = makeService({ allowedCallbackOrigins: ["http://localhost:3000"], allowInsecureLocalhost: false }).service;

    expect(dev.resolveCallback("http://localhost:3000/cb", session())).toMatchObject({ kind: "url" });
    expect(() => prod.resolveCallback("http://localhost:3000/cb", session())).toThrow(Sep24Error);
  });
});

describe("session stores", () => {
  const session: Sep24Session = {
    id: "s1",
    operation: "deposit",
    assetCode: "USDC",
    status: "incomplete",
    createdAt: 1,
  };

  it("in-memory store expires sessions", async () => {
    let now = 0;
    const store = new InMemorySep24SessionStore(() => now);
    await store.save(session, 10);
    expect(await store.get("s1")).not.toBeNull();
    now = 10_001;
    expect(await store.get("s1")).toBeNull();
    expect(await store.completeOnce("s1", "x")).toBeNull();
  });

  it("redis store round-trips and lets exactly one completion win", async () => {
    const data = new Map<string, string>();
    const redis: RedisLike = {
      async set(key, value, options) {
        if (options?.NX && data.has(key)) return null;
        data.set(key, value);
        return "OK";
      },
      async get(key) {
        return data.get(key) ?? null;
      },
      async ttl(key) {
        return data.has(key) ? 3000 : -2;
      },
    };
    const store = new RedisSep24SessionStore(redis);
    await store.save(session, 3600);

    expect(await store.get("s1")).toEqual(session);
    const [a, b] = await Promise.all([store.completeOnce("s1", "sealed-a"), store.completeOnce("s1", "sealed-b")]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await store.get("s1"))!.status).toBe("pending_user_transfer_start");
    expect(await store.completeOnce("missing", "x")).toBeNull();
  });
});

describe("deliverUrlCallback", () => {
  const payload = {
    transaction: { id: "tx-1", status: "pending_user_transfer_start" as const, more_info_url: "https://a/b" },
    completionToken: "tok",
  };

  it("POSTs the transaction and completion token without following redirects", async () => {
    const fetchImpl = jest.fn(async (..._args: unknown[]) => ({ ok: true, status: 200 }));

    const ok = await deliverUrlCallback(payload, "https://hooks.example.com/cb", fetchImpl as never);

    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("https://hooks.example.com/cb");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      transaction: payload.transaction,
      completion_token: "tok",
    });
  });

  it("reports failure for non-2xx and network errors instead of throwing", async () => {
    expect(await deliverUrlCallback(payload, "https://x.example/cb", (async () => ({ ok: false, status: 500 })) as never)).toBe(false);
    expect(
      await deliverUrlCallback(payload, "https://x.example/cb", (async () => {
        throw new Error("boom");
      }) as never),
    ).toBe(false);
  });

  it("aborts a hanging callback after the timeout", async () => {
    jest.useFakeTimers();
    try {
      const hanging = (async (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        })) as never;

      const pending = deliverUrlCallback(payload, "https://x.example/cb", hanging, 5000);
      await jest.advanceTimersByTimeAsync(5001);

      expect(await pending).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("views", () => {
  const session = { operation: "withdraw" as const, assetCode: "USDC" };

  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("keeps script-embedded JSON from breaking out of the script element", () => {
    // Built with fromCharCode: raw U+2028/U+2029 are line terminators in JS source.
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const value = { a: "</script><script>alert(1)</script>", b: `${ls}${ps} & <!--` };

    const out = jsonForScript(value);

    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain(ls);
    expect(out).not.toContain(ps);
    expect(JSON.parse(out)).toEqual(value);
  });

  it("renders a labelled, accessible form and never reflects raw input", () => {
    const html = renderForm({
      nonce: "N0nce",
      token: 'tok"><script>x</script>',
      session,
      values: { full_name: '"><img src=x onerror=alert(1)>' },
      errors: { account_number: "Enter a valid account number." },
      bannerError: "Please fix the highlighted fields.",
    });

    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain('<style nonce="N0nce">');
    expect(html).toMatch(/<label for="full_name">/);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('name="viewport"');
    // CSP forbids inline style attributes, so none may be emitted.
    expect(html.replace(/<style[\s\S]*?<\/style>/, "")).not.toMatch(/\sstyle=/);
  });

  it("uses operation-specific wording", () => {
    expect(renderForm({ nonce: "n", token: "t", session })).toContain("Withdraw to your bank");
    expect(renderForm({ nonce: "n", token: "t", session: { ...session, operation: "deposit" } })).toContain(
      "Refund account",
    );
  });

  const payload = {
    transaction: { id: "tx-1", status: "pending_user_transfer_start", more_info_url: "https://a/b" },
    completion_token: "tok",
  };

  it("posts the completion to the wallet with an explicit target origin", () => {
    const html = renderComplete({
      nonce: "N0nce",
      payload,
      callback: { kind: "postMessage", targetOrigin: WALLET },
    });
    expect(html).toContain('<script nonce="N0nce">');
    expect(html).toContain(`postMessage(payload,target)`);
    expect(html).toContain(JSON.stringify(WALLET));
    expect(html).not.toContain('"*"');
    expect(html).toContain('"completion_token":"tok"');
  });

  it("emits no script (and so no token exposure) without a known wallet origin or for other callbacks", () => {
    for (const callback of [
      { kind: "postMessage" as const, targetOrigin: null },
      { kind: "none" as const },
      { kind: "url" as const, url: "https://hooks.example.com/cb" },
    ]) {
      const html = renderComplete({ nonce: "n", payload, callback });
      expect(html).not.toContain("<script");
      expect(html).not.toContain("tok");
    }
  });

  it("tells the user whether the URL callback was delivered", () => {
    const cb = { kind: "url" as const, url: "https://hooks.example.com/cb" };
    expect(renderComplete({ nonce: "n", payload, callback: cb, urlCallbackDelivered: true })).toContain(
      "Your wallet has been notified.",
    );
    expect(renderComplete({ nonce: "n", payload, callback: cb, urlCallbackDelivered: false })).toContain(
      "Return to your wallet",
    );
  });
});
