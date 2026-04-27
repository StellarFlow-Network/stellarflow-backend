/**
 * Test suite for GasBalanceMonitorService, WebhookService, and index.ts integration.
 * All external dependencies are mocked — no real network calls, filesystem writes,
 * or webhook posts are made. Safe to run without affecting the live workflow.
 *
 * Run with: npx jest gasMonitor.test.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// ─── Mock external modules before imports ────────────────────────────────────

jest.mock("@stellar/stellar-sdk", () => ({
    Keypair: {
        fromSecret: jest.fn().mockReturnValue({
            publicKey: () => "GADMIN_WALLET_PUBLIC_KEY",
        }),
    },
    Horizon: {
        Server: jest.fn().mockImplementation(() => ({
            loadAccount: jest.fn(),
            root: jest.fn(),
        })),
    },
}));

jest.mock("fs", () => ({
    promises: {
        writeFile: jest.fn().mockResolvedValue(undefined),
        readFile: jest.fn().mockRejectedValue(new Error("File not found")), // No persisted state by default
    },
}));

jest.mock("axios", () => ({
    default: {
        post: jest.fn().mockResolvedValue({ status: 200 }),
    },
}));

jest.mock("../utils/retryUtil.js", () => ({
    withRetry: jest.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
}));

jest.mock("../utils/httpTimeout.js", () => ({
    OUTGOING_HTTP_TIMEOUT_MS: 5000,
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { promises as fs } from "fs";
import { Horizon } from "@stellar/stellar-sdk";
import axios from "axios";
import { GasBalanceMonitorService, getGasBalanceMonitorService } from "./gasBalanceMonitorService";
import { WebhookService, getWebhookService } from "./webhook";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockLoadAccount = (balance: string) => {
    const server = new (Horizon.Server as jest.MockedClass<typeof Horizon.Server>)("");
    (server.loadAccount as jest.Mock).mockResolvedValue({
        balances: [{ asset_type: "native", balance }],
    });
    return server;
};

const mockLoadAccountFailure = () => {
    const server = new (Horizon.Server as jest.MockedClass<typeof Horizon.Server>)("");
    (server.loadAccount as jest.Mock).mockRejectedValue(new Error("Horizon unreachable"));
    return server;
};

// ─── GasBalanceMonitorService ─────────────────────────────────────────────────

describe("GasBalanceMonitorService", () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.ORACLE_SECRET_KEY = "STEST_SECRET_KEY";
        process.env.STELLAR_NETWORK = "TESTNET";
        process.env.GAS_BALANCE_ALERT_THRESHOLD_XLM = "20";
        jest.useFakeTimers();
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    // ── Lazy singleton ──────────────────────────────────────────────────────────

    describe("Lazy singleton", () => {
        it("does not throw at import time when env vars are missing", () => {
            delete process.env.ORACLE_SECRET_KEY;
            delete process.env.SOROBAN_ADMIN_SECRET;

            // Simply importing the module should not throw
            expect(() => require("./gasBalanceMonitorService")).not.toThrow();
        });

        it("throws only when getGasBalanceMonitorService() is called with missing env vars", () => {
            delete process.env.ORACLE_SECRET_KEY;
            delete process.env.SOROBAN_ADMIN_SECRET;

            expect(() => getGasBalanceMonitorService()).toThrow(
                "Stellar secret key not found in environment variables",
            );
        });

        it("returns the same instance on repeated calls", () => {
            const a = getGasBalanceMonitorService();
            const b = getGasBalanceMonitorService();
            expect(a).toBe(b);
        });
    });

    // ── Threshold parsing ───────────────────────────────────────────────────────

    describe("Threshold parsing", () => {
        it("uses the env var threshold when valid", () => {
            process.env.GAS_BALANCE_ALERT_THRESHOLD_XLM = "50";
            const service = new GasBalanceMonitorService();
            expect(service.getStatus().balanceThresholdXLM).toBe(50);
        });

        it("falls back to 20 XLM when env var is not a number", () => {
            process.env.GAS_BALANCE_ALERT_THRESHOLD_XLM = "abc";
            const service = new GasBalanceMonitorService();
            expect(service.getStatus().balanceThresholdXLM).toBe(20);
        });

        it("falls back to 20 XLM when env var is missing", () => {
            delete process.env.GAS_BALANCE_ALERT_THRESHOLD_XLM;
            const service = new GasBalanceMonitorService();
            expect(service.getStatus().balanceThresholdXLM).toBe(20);
        });
    });

    // ── Balance check & alerting ────────────────────────────────────────────────

    describe("Balance check and alerting", () => {
        it("does not alert when balance is above threshold", async () => {
            const service = new GasBalanceMonitorService();
            const sendAlertSpy = jest
                .spyOn(service["webhookService"], "sendGasBalanceAlert")
                .mockResolvedValue(undefined);

            (service["server"].loadAccount as jest.Mock).mockResolvedValue({
                balances: [{ asset_type: "native", balance: "50.0000000" }],
            });

            await service["checkBalance"]();
            expect(sendAlertSpy).not.toHaveBeenCalled();
        });

        it("sends alert when balance is below threshold", async () => {
            const service = new GasBalanceMonitorService();
            const sendAlertSpy = jest
                .spyOn(service["webhookService"], "sendGasBalanceAlert")
                .mockResolvedValue(undefined);

            (service["server"].loadAccount as jest.Mock).mockResolvedValue({
                balances: [{ asset_type: "native", balance: "5.0000000" }],
            });

            await service["checkBalance"]();
            expect(sendAlertSpy).toHaveBeenCalledWith(
                expect.objectContaining({ currentBalance: 5, threshold: 20 }),
            );
        });

        it("rate-limits alerts to once per hour", async () => {
            const service = new GasBalanceMonitorService();
            service["lastAlertTime"] = Date.now(); // Simulate a recent alert

            const sendAlertSpy = jest
                .spyOn(service["webhookService"], "sendGasBalanceAlert")
                .mockResolvedValue(undefined);

            (service["server"].loadAccount as jest.Mock).mockResolvedValue({
                balances: [{ asset_type: "native", balance: "5.0000000" }],
            });

            await service["checkBalance"]();
            expect(sendAlertSpy).not.toHaveBeenCalled();
        });

        it("sends alert again after the rate-limit window has passed", async () => {
            const service = new GasBalanceMonitorService();
            // Set lastAlertTime to 2 hours ago
            service["lastAlertTime"] = Date.now() - 2 * 60 * 60 * 1000;

            const sendAlertSpy = jest
                .spyOn(service["webhookService"], "sendGasBalanceAlert")
                .mockResolvedValue(undefined);

            (service["server"].loadAccount as jest.Mock).mockResolvedValue({
                balances: [{ asset_type: "native", balance: "5.0000000" }],
            });

            await service["checkBalance"]();
            expect(sendAlertSpy).toHaveBeenCalledTimes(1);
        });
    });

    // ── Retry escalation ────────────────────────────────────────────────────────

    describe("Retry escalation", () => {
        it("increments consecutiveFailures on each Horizon error", async () => {
            const service = new GasBalanceMonitorService();
            (service["server"].loadAccount as jest.Mock).mockRejectedValue(
                new Error("Horizon unreachable"),
            );

            await service["checkBalance"]();
            expect(service.getStatus().consecutiveFailures).toBe(1);

            await service["checkBalance"]();
            expect(service.getStatus().consecutiveFailures).toBe(2);
        });

        it("sends monitor failure alert after 3 consecutive failures and resets counter", async () => {
            const service = new GasBalanceMonitorService();
            const failureAlertSpy = jest
                .spyOn(service["webhookService"], "sendMonitorFailureAlert")
                .mockResolvedValue(undefined);

            (service["server"].loadAccount as jest.Mock).mockRejectedValue(
                new Error("Horizon unreachable"),
            );

            await service["checkBalance"]();
            await service["checkBalance"]();
            await service["checkBalance"](); // 3rd failure — should escalate

            expect(failureAlertSpy).toHaveBeenCalledTimes(1);
            expect(failureAlertSpy).toHaveBeenCalledWith(
                expect.objectContaining({ consecutiveFailures: 3 }),
            );
            // Counter resets after escalation
            expect(service.getStatus().consecutiveFailures).toBe(0);
        });

        it("resets consecutiveFailures on a successful check", async () => {
            const service = new GasBalanceMonitorService();
            (service["server"].loadAccount as jest.Mock).mockRejectedValue(
                new Error("Horizon unreachable"),
            );

            await service["checkBalance"]();
            await service["checkBalance"]();
            expect(service.getStatus().consecutiveFailures).toBe(2);

            // Now recover
            (service["server"].loadAccount as jest.Mock).mockResolvedValue({
                balances: [{ asset_type: "native", balance: "50.0000000" }],
            });

            await service["checkBalance"]();
            expect(service.getStatus().consecutiveFailures).toBe(0);
        });
    });

    // ── Persisted alert time ────────────────────────────────────────────────────

    describe("Persisted alert time", () => {
        it("writes lastAlertTime to disk after sending an alert", async () => {
            const service = new GasBalanceMonitorService();
            jest
                .spyOn(service["webhookService"], "sendGasBalanceAlert")
                .mockResolvedValue(undefined);

            (service["server"].loadAccount as jest.Mock).mockResolvedValue({
                balances: [{ asset_type: "native", balance: "5.0000000" }],
            });

            await service["checkBalance"]();
            expect(fs.writeFile).toHaveBeenCalledWith(
                "/tmp/gas_balance_last_alert_time.json",
                expect.stringContaining("lastAlertTime"),
                "utf-8",
            );
        });

        it("restores lastAlertTime from disk on start", async () => {
            const savedTime = Date.now() - 30 * 60 * 1000; // 30 minutes ago
            (fs.readFile as jest.Mock).mockResolvedValueOnce(
                JSON.stringify({ lastAlertTime: savedTime }),
            );

            const service = new GasBalanceMonitorService();
            // Mock loadAccount so start() doesn't error
            (service["server"].loadAccount as jest.Mock).mockResolvedValue({
                balances: [{ asset_type: "native", balance: "50.0000000" }],
            });

            await service["loadLastAlertTime"]();
            expect(service["lastAlertTime"]).toBe(savedTime);
        });

        it("starts fresh if persisted file is missing", async () => {
            (fs.readFile as jest.Mock).mockRejectedValueOnce(new Error("ENOENT"));
            const service = new GasBalanceMonitorService();
            await service["loadLastAlertTime"]();
            expect(service["lastAlertTime"]).toBe(0);
        });
    });

    // ── Stop behaviour ──────────────────────────────────────────────────────────

    describe("Stop behaviour", () => {
        it("clears lastKnownBalance on stop", async () => {
            const service = new GasBalanceMonitorService();
            service["lastKnownBalance"] = 42;
            service.stop();
            expect(service.getStatus().lastKnownBalance).toBeNull();
        });

        it("sets isRunning to false on stop", () => {
            const service = new GasBalanceMonitorService();
            service["isRunning"] = true;
            service.stop();
            expect(service.getStatus().isRunning).toBe(false);
        });
    });

    // ── Debug gating ────────────────────────────────────────────────────────────

    describe("Debug log gating", () => {
        it("does not log balance when DEBUG is not set", async () => {
            delete process.env.DEBUG;
            const service = new GasBalanceMonitorService();
            const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => { });

            (service["server"].loadAccount as jest.Mock).mockResolvedValue({
                balances: [{ asset_type: "native", balance: "50.0000000" }],
            });

            await service["checkBalance"]();
            expect(debugSpy).not.toHaveBeenCalledWith(
                expect.stringContaining("Admin wallet balance"),
            );
            debugSpy.mockRestore();
        });

        it("logs balance when DEBUG is set", async () => {
            process.env.DEBUG = "true";
            const service = new GasBalanceMonitorService();
            const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => { });

            (service["server"].loadAccount as jest.Mock).mockResolvedValue({
                balances: [{ asset_type: "native", balance: "50.0000000" }],
            });

            await service["checkBalance"]();
            expect(debugSpy).toHaveBeenCalledWith(
                expect.stringContaining("Admin wallet balance"),
            );
            debugSpy.mockRestore();
        });
    });
});

// ─── WebhookService ───────────────────────────────────────────────────────────

describe("WebhookService", () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test";
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    // ── Lazy singleton ──────────────────────────────────────────────────────────

    describe("Lazy singleton", () => {
        it("returns the same instance on repeated calls", () => {
            const a = getWebhookService();
            const b = getWebhookService();
            expect(a).toBe(b);
        });
    });

    // ── Gas balance alert formatting ────────────────────────────────────────────

    describe("formatGasBalanceAlert", () => {
        const alertDetails = {
            currentBalance: 5.5,
            threshold: 20,
            timestamp: new Date("2026-01-01T00:00:00Z"),
        };

        it("returns Slack blocks when NOTIFICATION_PLATFORM=slack", () => {
            process.env.NOTIFICATION_PLATFORM = "slack";
            const service = new WebhookService();
            const result = service["formatGasBalanceAlert"](alertDetails) as any;

            expect(result.blocks).toBeDefined();
            expect(result.embeds).toBeUndefined();
            // Check key fields are present in Slack payload
            const allText = JSON.stringify(result.blocks);
            expect(allText).toContain("5.50 XLM");
            expect(allText).toContain("20 XLM");
            expect(allText).toContain("14.50 XLM"); // deficit
        });

        it("returns Discord embed when NOTIFICATION_PLATFORM=discord", () => {
            process.env.NOTIFICATION_PLATFORM = "discord";
            const service = new WebhookService();
            const result = service["formatGasBalanceAlert"](alertDetails) as any;

            expect(result.embeds).toBeDefined();
            expect(result.blocks).toBeUndefined();
            expect(result.embeds[0].color).toBe(0xff0000);
            const allText = JSON.stringify(result.embeds);
            expect(allText).toContain("5.50 XLM");
            expect(allText).toContain("14.50 XLM"); // deficit
        });

        it("omits wallet address field when not provided", () => {
            process.env.NOTIFICATION_PLATFORM = "discord";
            const service = new WebhookService();
            const result = service["formatGasBalanceAlert"](alertDetails) as any;
            const allText = JSON.stringify(result);
            expect(allText).not.toContain("Wallet Address");
        });

        it("includes truncated wallet address when provided", () => {
            process.env.NOTIFICATION_PLATFORM = "discord";
            const service = new WebhookService();
            const result = service["formatGasBalanceAlert"]({
                ...alertDetails,
                walletAddress: "GADMIN_WALLET_PUBLIC_KEY_FULL",
            }) as any;
            const allText = JSON.stringify(result);
            expect(allText).toContain("Wallet Address");
            expect(allText).toContain("...");
        });
    });

    // ── Monitor failure alert formatting ────────────────────────────────────────

    describe("formatMonitorFailureAlert", () => {
        const failureDetails = {
            consecutiveFailures: 3,
            lastKnownBalance: 12.5,
            timestamp: new Date("2026-01-01T00:00:00Z"),
        };

        it("returns Slack blocks when NOTIFICATION_PLATFORM=slack", () => {
            process.env.NOTIFICATION_PLATFORM = "slack";
            const service = new WebhookService();
            const result = service["formatMonitorFailureAlert"](failureDetails) as any;

            expect(result.blocks).toBeDefined();
            expect(result.embeds).toBeUndefined();
            const allText = JSON.stringify(result.blocks);
            expect(allText).toContain("3");
            expect(allText).toContain("12.50 XLM");
        });

        it("returns Discord embed when NOTIFICATION_PLATFORM=discord", () => {
            process.env.NOTIFICATION_PLATFORM = "discord";
            const service = new WebhookService();
            const result = service["formatMonitorFailureAlert"](failureDetails) as any;

            expect(result.embeds).toBeDefined();
            expect(result.blocks).toBeUndefined();
            expect(result.embeds[0].color).toBe(0xff0000);
            const allText = JSON.stringify(result.embeds);
            expect(allText).toContain("12.50 XLM");
        });

        it("shows Unknown when lastKnownBalance is null", () => {
            process.env.NOTIFICATION_PLATFORM = "slack";
            const service = new WebhookService();
            const result = service["formatMonitorFailureAlert"]({
                ...failureDetails,
                lastKnownBalance: null,
            }) as any;
            expect(JSON.stringify(result)).toContain("Unknown");
        });
    });

    // ── No webhook URL ──────────────────────────────────────────────────────────

    describe("Missing webhook URL", () => {
        it("does not call axios when no webhook URL is configured", async () => {
            delete process.env.SLACK_WEBHOOK_URL;
            delete process.env.DISCORD_WEBHOOK_URL;
            const service = new WebhookService();

            await service.sendGasBalanceAlert({
                currentBalance: 5,
                threshold: 20,
                timestamp: new Date(),
            });

            expect(axios.post).not.toHaveBeenCalled();
        });
    });
});
