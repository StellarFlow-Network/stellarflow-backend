/**
 * HTTP-level tests for the SEP-24 interactive routes (Issue #1015).
 *
 * The real routers run behind supertest with an in-memory session store, so
 * this exercises body parsing, headers, status codes and the full
 * initiate -> render -> submit -> callback journey.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  InMemorySep24SessionStore,
  Sep24InteractiveService,
  type Sep24Config,
} from "../src/services/sep24Interactive";
import {
  createSep24InitiationRouter,
  createSep24InteractiveRouter,
} from "../src/routes/sep24";

const WALLET = "https://wallet.example.com";
const HOOKS = "https://hooks.example.com";
const ACCOUNT = "G" + "A".repeat(55);

const config: Sep24Config = {
  secret: "s".repeat(40),
  interactiveTokenTtlSeconds: 900,
  completionTokenTtlSeconds: 300,
  sessionTtlSeconds: 3600,
  baseUrl: "https://anchor.example.com",
  allowedCallbackOrigins: [WALLET, HOOKS],
  supportedAssets: [],
  allowInsecureLocalhost: false,
};

const goodForm = {
  full_name: "Ada Lovelace",
  bank_name: "First Bank",
  account_number: "0123456789",
  email: "ada@example.com",
};

function build(service: Sep24InteractiveService | null, fetchImpl?: unknown) {
  const app = express();
  app.use(express.json());
  const opts = {
    getService: () => service,
    rateLimit: false,
    ...(fetchImpl ? { fetchImpl: fetchImpl as never } : {}),
  };
  app.use("/sep24", createSep24InteractiveRouter(opts));
  app.use("/api/v1/sep24", createSep24InitiationRouter(opts));
  return app;
}

async function initiate(app: express.Express, body: Record<string, unknown> = {}, op = "withdraw") {
  const res = await request(app)
    .post(`/api/v1/sep24/transactions/${op}/interactive`)
    .send({ asset_code: "USDC", account: ACCOUNT, wallet_url: WALLET, ...body });
  return res;
}

const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

describe("SEP-24 interactive routes", () => {
  let app: express.Express;
  let fetchImpl: jest.Mock<(...args: unknown[]) => Promise<{ ok: boolean; status: number }>>;

  beforeEach(() => {
    fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
    app = build(new Sep24InteractiveService(new InMemorySep24SessionStore(), config), fetchImpl);
  });

  describe("POST /api/v1/sep24/transactions/:operation/interactive", () => {
    it("returns the SEP-24 interactive response", async () => {
      const res = await initiate(app);

      expect(res.status).toBe(200);
      expect(res.body.type).toBe("interactive_customer_info_needed");
      expect(res.body.id).toEqual(expect.any(String));
      expect(res.body.url).toMatch(/^https:\/\/anchor\.example\.com\/sep24\/interactive\?token=/);
    });

    it("supports both deposit and withdraw and rejects other operations", async () => {
      expect((await initiate(app, {}, "deposit")).status).toBe(200);
      expect((await initiate(app, {}, "withdraw")).status).toBe(200);
      expect((await initiate(app, {}, "transfer")).status).toBe(404);
    });

    it("answers SEP-24 style errors for bad input", async () => {
      const res = await initiate(app, { asset_code: "not valid!" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining("asset_code") });
    });

    it("answers 503 when the flow is not configured", async () => {
      const res = await initiate(build(null));
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/);
    });
  });

  describe("GET /sep24/interactive", () => {
    it("renders the form with a strict, nonce-based CSP that lets the wallet frame it", async () => {
      const { url } = (await initiate(app)).body;

      const res = await request(app).get(new URL(url).pathname + new URL(url).search);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("Withdraw to your bank");
      expect(res.text).toContain('name="account_number"');

      const csp = res.headers["content-security-policy"]!;
      const nonce = /style-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(res.text).toContain(`<style nonce="${nonce}">`);
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).toContain(`frame-ancestors 'self' ${WALLET} ${HOOKS}`);
      expect(csp).toContain("form-action 'self'");
      expect(res.headers["x-frame-options"]).toBeUndefined();
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("uses a fresh nonce per response", async () => {
      const { url } = (await initiate(app)).body;
      const path = new URL(url).pathname + new URL(url).search;

      const nonce = (r: request.Response) => /nonce-([^']+)'/.exec(r.headers["content-security-policy"]!)![1];
      expect(nonce(await request(app).get(path))).not.toBe(nonce(await request(app).get(path)));
    });

    it.each([
      ["missing token", "/sep24/interactive", 400],
      ["bad token", "/sep24/interactive?token=nope", 400],
    ])("rejects %s", async (_label, path, status) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(status);
      expect(res.text).toContain("Unable to continue");
    });

    it("rejects a disallowed callback before showing the form", async () => {
      const { url } = (await initiate(app)).body;

      const res = await request(app).get(
        `/sep24/interactive?token=${encodeURIComponent(tokenOf(url))}&callback=${encodeURIComponent("https://evil.example/x")}`,
      );

      expect(res.status).toBe(400);
      expect(res.text).not.toContain("<form");
    });

    it("answers 503 (HTML) when not configured", async () => {
      const res = await request(build(null)).get("/sep24/interactive?token=x");
      expect(res.status).toBe(503);
      expect(res.text).toContain("Service unavailable");
    });
  });

  describe("POST /sep24/interactive", () => {
    const submit = (a: express.Express, token: string, extra: Record<string, string> = {}) =>
      request(a).post("/sep24/interactive").type("form").send({ token, ...goodForm, ...extra });

    it("completes the flow and posts the token to the wallet window with an explicit origin", async () => {
      const { url } = (await initiate(app)).body;

      const res = await submit(app, tokenOf(url), { callback: "postMessage" });

      expect(res.status).toBe(200);
      expect(res.text).toContain("Details received");
      const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers["content-security-policy"]!)![1];
      expect(res.text).toContain(`<script nonce="${nonce}">`);
      expect(res.text).toContain(JSON.stringify(WALLET));
      expect(res.text).toContain('"status":"pending_user_transfer_start"');
      expect(res.text).toContain('"completion_token":"');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("delivers a URL callback server-side", async () => {
      const { url, id } = (await initiate(app)).body;

      const res = await submit(app, tokenOf(url), { callback: `${HOOKS}/sep24/done` });

      expect(res.status).toBe(200);
      expect(res.text).toContain("Your wallet has been notified.");
      expect(res.text).not.toContain("<script");
      const [target, init] = fetchImpl.mock.calls[0] as [string, { body: string; redirect: string }];
      expect(target).toBe(`${HOOKS}/sep24/done`);
      expect(init.redirect).toBe("error");
      const body = JSON.parse(init.body);
      expect(body.transaction).toMatchObject({ id, status: "pending_user_transfer_start" });
      expect(body.completion_token).toEqual(expect.any(String));
    });

    it("still succeeds for the user when the URL callback fails", async () => {
      fetchImpl.mockRejectedValueOnce(new Error("down"));
      const { url } = (await initiate(app)).body;

      const res = await submit(app, tokenOf(url), { callback: `${HOOKS}/cb` });

      expect(res.status).toBe(200);
      expect(res.text).toContain("Return to your wallet");
    });

    it("completes without any callback", async () => {
      const { url } = (await initiate(app)).body;
      const res = await submit(app, tokenOf(url));
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("<script");
    });

    it("re-renders the form with errors and keeps what the user typed", async () => {
      const { url } = (await initiate(app)).body;
      const token = tokenOf(url);

      const bad = await submit(app, token, { account_number: "1", full_name: "Grace Hopper" });

      expect(bad.status).toBe(422);
      expect(bad.text).toContain("Please fix the highlighted fields.");
      expect(bad.text).toContain("Enter a valid account number");
      expect(bad.text).toContain('value="Grace Hopper"');
      expect(bad.text).toContain(`value="${token}"`);

      // The corrected resubmission works with the same token.
      expect((await submit(app, token)).status).toBe(200);
    });

    it("escapes hostile input when re-rendering", async () => {
      const { url } = (await initiate(app)).body;

      const res = await submit(app, tokenOf(url), { full_name: '"><script>alert(1)</script>' });

      expect(res.status).toBe(422);
      expect(res.text).not.toContain("<script>alert(1)</script>");
    });

    it("accepts a submission only once", async () => {
      const { url } = (await initiate(app)).body;
      const token = tokenOf(url);

      expect((await submit(app, token)).status).toBe(200);
      const again = await submit(app, token);

      expect(again.status).toBe(409);
      expect(again.text).toContain("already been submitted");
      // ...and the form is no longer offered.
      const view = await request(app).get(`/sep24/interactive?token=${encodeURIComponent(token)}`);
      expect(view.status).toBe(409);
    });

    it("refuses a forged or missing token", async () => {
      expect((await submit(app, "forged")).status).toBe(400);
      expect((await request(app).post("/sep24/interactive").type("form").send(goodForm)).status).toBe(400);
    });

    it("refuses a disallowed callback without consuming the session", async () => {
      const { url } = (await initiate(app)).body;
      const token = tokenOf(url);

      const res = await submit(app, token, { callback: "https://evil.example/steal" });

      expect(res.status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect((await submit(app, token)).status).toBe(200);
    });

    it("rejects oversized bodies", async () => {
      const { url } = (await initiate(app)).body;
      const res = await submit(app, tokenOf(url), { full_name: "x".repeat(20_000) });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("answers 503 when not configured", async () => {
      const res = await submit(build(null), "x");
      expect(res.status).toBe(503);
    });
  });
});
