import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { promises as fs } from "fs";
import dotenv from "dotenv";
import { WebhookService } from "./webhook";

dotenv.config();

// Named constant to avoid duplication between parameter default and comment
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BALANCE_THRESHOLD_XLM = 20;
const MIN_ALERT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between alerts
const MAX_CONSECUTIVE_FAILURES = 3;
const LAST_ALERT_TIME_PATH = "/tmp/gas_balance_last_alert_time.json";

/**
 * GasBalanceMonitorService
 * Background service that monitors the admin wallet XLM balance.
 * Sends a Critical webhook alert to Discord/Slack if balance drops below the configured threshold (default: 20 XLM).
 *
 * Prevents running out of XLM for transaction fees by providing early warning.
 */
export class GasBalanceMonitorService {
    private isRunning: boolean = false;
    private checkIntervalMs: number;
    private timer: ReturnType<typeof setInterval> | null = null;
    private server: Horizon.Server;
    private adminKeypair: Keypair;
    private webhookService: WebhookService;
    private lastAlertTime: number = 0;
    private readonly BALANCE_THRESHOLD_XLM: number;
    private lastKnownBalance: number | null = null;
    private consecutiveFailures: number = 0;

    constructor(checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS) {
        const secret =
            process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET;
        if (!secret) {
            throw new Error("Stellar secret key not found in environment variables");
        }

        this.adminKeypair = Keypair.fromSecret(secret);
        this.checkIntervalMs = checkIntervalMs;
        this.webhookService = new WebhookService();

        const network = process.env.STELLAR_NETWORK || "TESTNET";
        const horizonUrl =
            network === "PUBLIC"
                ? "https://horizon.stellar.org"
                : "https://horizon-testnet.stellar.org";

        this.server = new Horizon.Server(horizonUrl);

        // parseFloat returns NaN for non-numeric strings like "abc"; the fallback guards against that.
        // The env var default "20" is a separate concern from the NaN fallback.
        const parsedThreshold = parseFloat(
            process.env.GAS_BALANCE_ALERT_THRESHOLD_XLM ?? "",
        );
        this.BALANCE_THRESHOLD_XLM = isNaN(parsedThreshold)
            ? DEFAULT_BALANCE_THRESHOLD_XLM
            : parsedThreshold;
    }

    /**
     * Start the background service.
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            console.warn("[GasBalanceMonitor] Service is already running");
            return;
        }

        // Restore persisted lastAlertTime so rate-limiting survives restarts
        await this.loadLastAlertTime();

        this.isRunning = true;
        console.info(
            `[GasBalanceMonitor] Started with ${this.checkIntervalMs}ms check interval (threshold: ${this.BALANCE_THRESHOLD_XLM} XLM)`,
        );

        // Run immediately on start
        await this.checkBalance().catch((err) => {
            console.error("[GasBalanceMonitor] Initial check error:", err);
        });

        // Start periodic checks
        this.timer = setInterval(() => {
            this.checkBalance().catch((err) => {
                console.error("[GasBalanceMonitor] Background check error:", err);
            });
        }, this.checkIntervalMs);
    }

    /**
     * Stop the background service.
     */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.isRunning = false;
        this.lastKnownBalance = null; // Reset stale balance on stop
        console.info("[GasBalanceMonitor] Stopped");
    }

    /**
     * Check the admin wallet balance and alert if below threshold.
     */
    private async checkBalance(): Promise<void> {
        try {
            const account = await this.server.loadAccount(
                this.adminKeypair.publicKey(),
            );

            // Reset failure counter on success
            this.consecutiveFailures = 0;

            // XLM balance is always the native balance
            const xlmBalance = account.balances.find(
                (balance) => balance.asset_type === "native",
            );

            if (!xlmBalance) {
                console.warn(
                    "[GasBalanceMonitor] No native balance (XLM) found for admin account",
                );
                return;
            }

            const balanceAmount = parseFloat(xlmBalance.balance);
            this.lastKnownBalance = balanceAmount;

            // Only log in debug/dev environments to reduce production noise
            if (process.env.DEBUG) {
                console.debug(
                    `[GasBalanceMonitor] Admin wallet balance: ${balanceAmount} XLM (threshold: ${this.BALANCE_THRESHOLD_XLM} XLM)`,
                );
            }

            if (balanceAmount < this.BALANCE_THRESHOLD_XLM) {
                const timeSinceLastAlert = Date.now() - this.lastAlertTime;

                if (timeSinceLastAlert > MIN_ALERT_INTERVAL_MS) {
                    await this.sendBalanceAlert(balanceAmount);
                    this.lastAlertTime = Date.now();
                    await this.persistLastAlertTime();
                } else {
                    console.debug(
                        `[GasBalanceMonitor] Alert rate-limited (next in ${Math.ceil((MIN_ALERT_INTERVAL_MS - timeSinceLastAlert) / 1000)}s)`,
                    );
                }
            }
        } catch (error) {
            this.consecutiveFailures++;
            console.error(
                `[GasBalanceMonitor] Error checking balance (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
                error,
            );

            // Escalate after too many consecutive failures — we may be silently missing a low-balance state
            if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.error(
                    `[GasBalanceMonitor] 🚨 ESCALATING: ${this.consecutiveFailures} consecutive failures. Balance state unknown.`,
                );
                await this.webhookService
                    .sendMonitorFailureAlert({
                        consecutiveFailures: this.consecutiveFailures,
                        lastKnownBalance: this.lastKnownBalance,
                        timestamp: new Date(),
                    })
                    .catch((err) => {
                        console.error(
                            "[GasBalanceMonitor] Failed to send escalation alert:",
                            err,
                        );
                    });
                // Reset counter after escalation to avoid spamming
                this.consecutiveFailures = 0;
            }
        }
    }

    /**
     * Send critical alert webhook notification.
     */
    private async sendBalanceAlert(currentBalance: number): Promise<void> {
        console.warn(
            `[GasBalanceMonitor] 🚨 CRITICAL: Admin wallet balance (${currentBalance} XLM) is below threshold (${this.BALANCE_THRESHOLD_XLM} XLM)`,
        );

        await this.webhookService.sendGasBalanceAlert({
            currentBalance,
            threshold: this.BALANCE_THRESHOLD_XLM,
            // Omit walletAddress from alert payload to avoid surfacing it in external systems
            timestamp: new Date(),
        });
    }

    /**
     * Persist lastAlertTime to disk so rate-limiting survives process restarts.
     */
    private async persistLastAlertTime(): Promise<void> {
        try {
            await fs.writeFile(
                LAST_ALERT_TIME_PATH,
                JSON.stringify({ lastAlertTime: this.lastAlertTime }),
                "utf-8",
            );
        } catch (err) {
            console.warn("[GasBalanceMonitor] Failed to persist lastAlertTime:", err);
        }
    }

    /**
     * Load persisted lastAlertTime from disk on startup.
     */
    private async loadLastAlertTime(): Promise<void> {
        try {
            const raw = await fs.readFile(LAST_ALERT_TIME_PATH, "utf-8");
            const parsed = JSON.parse(raw);
            if (typeof parsed.lastAlertTime === "number") {
                this.lastAlertTime = parsed.lastAlertTime;
                console.info(
                    `[GasBalanceMonitor] Restored lastAlertTime from disk: ${new Date(this.lastAlertTime).toISOString()}`,
                );
            }
        } catch {
            // File doesn't exist yet or is unreadable — safe to start fresh
        }
    }

    /**
     * Get service status and current balance.
     * Note: adminWallet is intentionally omitted to avoid exposing it in monitoring endpoints.
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            checkIntervalMs: this.checkIntervalMs,
            balanceThresholdXLM: this.BALANCE_THRESHOLD_XLM,
            lastKnownBalance: this.lastKnownBalance,
            consecutiveFailures: this.consecutiveFailures,
        };
    }
}

/**
 * Lazy singleton factory — avoids running the constructor (and Keypair.fromSecret)
 * at import time, which would crash the module if env vars are missing.
 */
let _instance: GasBalanceMonitorService | null = null;

export function getGasBalanceMonitorService(): GasBalanceMonitorService {
    if (!_instance) {
        _instance = new GasBalanceMonitorService();
    }
    return _instance;
}
