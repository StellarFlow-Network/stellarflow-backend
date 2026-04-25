import { createServer } from "http";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { Horizon } from "@stellar/stellar-sdk";
import marketRatesRouter from "./routes/marketRates";
import historyRouter from "./routes/history";
import priceUpdatesRouter from "./routes/priceUpdates";
import statsRouter from "./routes/stats";
import app from "./app";
import prisma from "./lib/prisma";
import { disconnectRedis } from "./lib/redis";
import { initSocket } from "./lib/socket";
import { SorobanEventListener } from "./services/sorobanEventListener";
import { multiSigSubmissionService } from "./services/multiSigSubmissionService";
import { validateEnv } from "./utils/envValidator";
import { enableGlobalLogMasking } from "./utils/logMasker";
import { hourlyAverageService } from "./services/hourlyAverageService";
import { metricsMiddleware, metricsEndpoint } from "./middleware/metrics";
import { watchConfig } from "./config/configWatcher";
import { validateDatabaseSchema } from "./utils/dbValidator";

// Load environment variables
dotenv.config();

// Enable log masking to prevent sensitive data leaks
enableGlobalLogMasking();

// [OPS] Implement "Environment Variable" Check on Start
validateEnv();

// [OPS] Validate database schema on startup
await validateDatabaseSchema();

// Validate required environment variables
const requiredEnvVars = ["STELLAR_SECRET", "DATABASE_URL"] as const;
const missingEnvVars: string[] = [];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    missingEnvVars.push(envVar);
  }
}

if (missingEnvVars.length > 0) {
  console.error("❌ Missing required environment variables:");
  missingEnvVars.forEach((varName) => console.error(`   - ${varName}`));
  console.error(
    "\nPlease set these variables in your .env file and restart the server.",
  );
  process.exit(1);
}

const dashboardUrl =
  process.env.DASHBOARD_URL ||
  process.env.FRONTEND_URL ||
  "http://localhost:3000";

if (!dashboardUrl) {
  console.error("❌ Missing required environment variable: DASHBOARD_URL");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

// Horizon server for health checks
const stellarNetwork = process.env.STELLAR_NETWORK || "TESTNET";
const horizonUrl =
  stellarNetwork === "PUBLIC"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
const horizonServer = new Horizon.Server(horizonUrl);

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/market-rates", marketRatesRouter);
app.use("/api/history", historyRouter);
app.use("/api/price-updates", priceUpdatesRouter);
app.use("/api/stats", statsRouter);

// Health check endpoint
/**
 * @swagger
 * /health:
 *   get:
 *     tags:
 *       - Health
 *     summary: System health check
 *     description: Check the health status of the backend including database and Stellar Horizon connectivity
 *     responses:
 *       '200':
 *         description: All systems operational
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: All systems operational
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 checks:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: boolean
 *                     horizon:
 *                       type: boolean
 *       '503':
 *         description: One or more services unavailable
 */
app.get("/health", async (req, res) => {
  const checks: { database: boolean; horizon: boolean } = {
    database: false,
    horizon: false,
  };

  // Check database connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {
    checks.database = false;
  }

  // Check Stellar Horizon reachability
  try {
    await horizonServer.root();
    checks.horizon = true;
  } catch {
    checks.horizon = false;
  }

  const healthy = checks.database && checks.horizon;

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy
      ? "All systems operational"
      : "One or more services unavailable",
    timestamp: new Date().toISOString(),
    checks,
  });
});

// Root endpoint
/**
 * @swagger
 * /:
 *   get:
 *     tags:
 *       - Health
 *     summary: API root endpoint
 *     description: Get information about available API endpoints
 *     responses:
 *       '200':
 *         description: API information with available endpoints
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: StellarFlow Backend API
 *                 version:
 *                   type: string
 *                   example: 1.0.0
 *                 endpoints:
 *                   type: object
 */
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "StellarFlow Backend API",
    version: "1.0.0",
    endpoints: {
      health: "/health",
      marketRates: {
        allRates: "/api/v1/market-rates/rates",
        singleRate: "/api/v1/market-rates/rate/:currency",
        health: "/api/v1/market-rates/health",
        currencies: "/api/v1/market-rates/currencies",
        cache: "/api/v1/market-rates/cache",
        clearCache: "POST /api/v1/market-rates/cache/clear",
      },
      system: {
        metrics: "/metrics",
      },
      stats: {
        volume: "/api/v1/stats/volume?date=YYYY-MM-DD",
      },
      history: {
        assetHistory: "/api/v1/history/:asset?range=1d|7d|30d|90d",
      },
      intelligence: {
        hourlyVolatility: "/api/v1/intelligence/hourly-volatility",
        priceChange: "/api/v1/intelligence/price-change/:currency",
        staleCurrencies: "/api/v1/intelligence/stale",
      },
      stats: {
        relayers: "/api/stats/relayers",
      },
    },
  });
});

// Start server
const httpServer = createServer(app);
initSocket(httpServer);
let sorobanEventListener: SorobanEventListener | null = null;
let isShuttingDown = false;
let stopEnvFileWatcher: (() => void) | undefined;
const stopConfigWatcher = watchConfig((cfg) => {
  sorobanEventListener?.restart(cfg.sorobanPollIntervalMs);
  multiSigSubmissionService.restart(cfg.multiSigPollIntervalMs);
  hourlyAverageService.restart(cfg.hourlyAverageCheckIntervalMs);
});

if (process.env.ENABLE_ENV_FILE_WATCHER === "true") {
  stopEnvFileWatcher = startEnvFileWatcher();
}

const closeHttpServer = (): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!httpServer.listening) {
      resolve();
      return;
    }

    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

const shutdown = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
  if (isShuttingDown) {
    console.log(
      `Shutdown already in progress. Received duplicate ${signal} signal.`,
    );
    return;
  }

  isShuttingDown = true;
  console.log(`${signal} received. Starting graceful shutdown...`);

  try {
    sorobanEventListener?.stop();
    multiSigSubmissionService.stop();
    hourlyAverageService.stop();
    stopConfigWatcher();
    stopEnvFileWatcher?.();

    await closeHttpServer();
    console.log("HTTP server closed.");

    await prisma.$disconnect();
    console.log("Database connections closed cleanly.");

    await disconnectRedis();
    console.log("Redis connections closed cleanly.");

    process.exit(0);
  } catch (error) {
    console.error("Graceful shutdown failed:", error);
    process.exit(1);
  }
};

process.once("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error("Unhandled SIGINT shutdown error:", error);
    process.exit(1);
  });
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error("Unhandled SIGTERM shutdown error:", error);
    process.exit(1);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🌊 StellarFlow Backend running on port ${PORT}`);
  console.log(
    `📊 Market Rates API available at http://localhost:${PORT}/api/market-rates`,
  );
  console.log(
    `📚 API Documentation available at http://localhost:${PORT}/api/docs`,
  );
  console.log(`🏥 Health check at http://localhost:${PORT}/health`);
  console.log(`🔌 Socket.io ready for dashboard connections`);

  // Start Soroban event listener to track confirmed on-chain prices
  try {
    sorobanEventListener = new SorobanEventListener();
    sorobanEventListener.start().catch((err) => {
      console.error("Failed to start event listener:", err);
    });
    console.log(`👂 Soroban event listener started`);
  } catch (err) {
    console.warn(
      "Event listener not started:",
      err instanceof Error ? err.message : err,
    );
    sorobanEventListener = null;
  }

  // Start multi-sig submission service if enabled
  if (process.env.MULTI_SIG_ENABLED === "true") {
    try {
      multiSigSubmissionService.start().catch((err: Error) => {
        console.error("Failed to start multi-sig submission service:", err);
      });
      console.log(`🔐 Multi-Sig submission service started`);
    } catch (err) {
      console.warn(
        "Multi-sig submission service not started:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Start background hourly average job
  try {
    hourlyAverageService.start().catch((err: Error) => {
      console.error("Failed to start hourly average service:", err);
    });
    console.log(`📊 Hourly average service started`);
  } catch (err) {
    console.warn(
      "Hourly average service not started:",
      err instanceof Error ? err.message : err,
    );
  }
});

export default app;
