import { createServer } from "http";
import compression from "compression";
import dotenv from "dotenv";
import { Horizon } from "@stellar/stellar-sdk";
import stellarProvider from "./lib/stellarProvider";
import { getStellarNetwork } from "./lib/stellarNetwork";
import marketRatesRouter from "./routes/marketRates";
import historyRouter from "./routes/history";
import priceUpdatesRouter from "./routes/priceUpdates";
import statsRouter from "./routes/stats";
import vaultRoutes from "./routes/vaults";
import app from "./app";
import prisma from "./lib/prisma";
import { disconnectRedis } from "./lib/redis";
import { initSocket } from "./lib/socket";
import { startLiquidityRebalancingWorker } from "./services/liquidity/bootstrap";
import { SorobanEventListener } from "./services/sorobanEventListener";
import { multiSigSubmissionService } from "./services/multiSigSubmissionService";
import {
  GasBalanceMonitorService,
  getGasBalanceMonitorService,
} from "./services/gasBalanceMonitorService";
import { sanitizeEnvironmentVariables } from "./config/environment";
import { validateEnv } from "./utils/envValidator";
import { refreshAllowedOrigins } from "./middleware/corsMiddleware";
import { enableGlobalLogMasking } from "./utils/logMasker";
import { hourlyAverageService } from "./services/hourlyAverageService";
import { ohlcvAggregator } from "./jobs/ohlcvJob";
import { apyWorker } from "./jobs/apyWorker";
import { watchConfig } from "./config/configWatcher";
import { startEnvFileWatcher } from "./config/envFileWatcher";
import { validateDatabaseSchema } from "./utils/dbValidator";
import { initializeTracing } from "./config/tracingConfig";
import { setupAxiosTracing } from "./lib/tracing";
import { registerTracingShutdownHandlers } from "./utils/shutdownTracing";
import { providerSecretRotationService } from "./services/providerSecretRotationService";
import { priceAggregatorService } from "./services/priceAggregatorService";
import { contractSanityCheckService } from "./services/contractSanityCheckService";
import { getCircuitBreakerService } from "./services/circuitBreakerService";
import { governanceTimelockService } from "./services/governanceTimelockService";
import { getRegionalHealthService } from "./services/regionalHealthService";
import { storageRentBumpService } from "./services/storageRentBumpService";
import { getOrderBookSnapshotEngine } from "./services/orderBookSnapshotEngine";
import { getRegionalHealthService } from "./services/regionalHealthService";
import { redisOperationsWorker } from "./services/redisOperationsWorker";
import { VolatilityService } from "./services/volatility.service";
import { ArbitrageScanner } from "./services/arbitrageScanner";
import { storageMonitorService } from "./services/storageMonitorService";
import { complianceScreeningWorker } from "./services/complianceScreeningWorker";

// Load environment variables
dotenv.config();

// Normalize safe startup environment strings before runtime storage.
// This helps ensure tokens and asset-like values are canonicalized from mixed case.
sanitizeEnvironmentVariables();

// Initialize tracing before other services
initializeTracing();

// Setup axios tracing for HTTP requests
setupAxiosTracing();

// Register tracing shutdown handlers
registerTracingShutdownHandlers();

// Enable log masking to prevent sensitive data leaks
enableGlobalLogMasking();

// Start regional health monitoring before we accept requests.
await getRegionalHealthService().startMonitoring();

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

// Issue #792 – Fail fast when the CORS allowlist is empty in production rather
// than starting a server that rejects every browser client.
const allowedOrigins = refreshAllowedOrigins();

if (allowedOrigins.length === 0) {
  console.error(
    "❌ No CORS origins configured. Set CORS_ALLOWED_ORIGINS (comma-separated) or DASHBOARD_URL.",
  );
  process.exit(1);
}

console.log(`🔒 CORS allowlist: ${allowedOrigins.join(", ")}`);

const PORT = process.env.PORT || 3000;

// Use shared StellarProvider for health checks (supports failover)
const horizonServer = stellarProvider.getServer();

// CORS, security headers and body parsing are configured once in app.ts.
// Re-registering them here previously overwrote the strict allowlist with a
// wildcard Access-Control-Allow-Origin.

// Routes
app.use("/api/market-rates", marketRatesRouter);
app.use("/api/history", historyRouter);
app.use("/api/price-updates", priceUpdatesRouter);
app.use("/api/stats", statsRouter);
app.use("/api/v1/vaults", vaultRoutes);

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
app.get("/health", async (_req, res) => {
  const watchdog = await systemHealthWatchdog.runOnce();
  const checks = {
    database: watchdog.checks.database?.status === "healthy",
    horizon: watchdog.checks.horizon?.status === "healthy",
    soroban: watchdog.checks.soroban?.status === "healthy",
  };
  const healthy = watchdog.status === "healthy";

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy
      ? "All systems operational"
      : "One or more services unavailable",
    timestamp: new Date().toISOString(),
    checks,
    watchdog,
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
      liveness: "/health/liveness",
      readiness: "/health/readiness",
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
        relayers: "/api/stats/relayers",
      },
      history: {
        assetHistory: "/api/v1/history/:asset?range=1d|7d|30d|90d",
      },
      intelligence: {
        hourlyVolatility: "/api/v1/intelligence/hourly-volatility",
        priceChange: "/api/v1/intelligence/price-change/:currency",
        staleCurrencies: "/api/v1/intelligence/stale",
      },
    },
  });
});

// Start server
const httpServer = createServer(app);
initSocket(httpServer);
const liquidityRebalancingWorker = startLiquidityRebalancingWorker();
let sorobanEventListener: SorobanEventListener | null = null;

systemHealthWatchdog.registerWorker({
  name: "redis-operations",
  getLastHeartbeatAt: () => redisOperationsWorker.getLastHeartbeatAt(),
  heartbeatTimeoutMs: redisOperationsWorker.getHeartbeatTimeoutMs(),
  restart: () => {
    redisOperationsWorker.stop();
    redisOperationsWorker.start();
  },
});

if (liquidityRebalancingWorker) {
  systemHealthWatchdog.registerWorker({
    name: "liquidity-rebalancing",
    getLastHeartbeatAt: () => liquidityRebalancingWorker.getLastHeartbeatAt(),
    heartbeatTimeoutMs: liquidityRebalancingWorker.getHeartbeatTimeoutMs(),
    restart: () => {
      liquidityRebalancingWorker.stop();
      liquidityRebalancingWorker.start();
    },
  });
}

// FIX 1: Typed as nullable — constructor is not called at module level,
// so a missing secret env var won't crash the process before the server starts.
let gasBalanceMonitorService: GasBalanceMonitorService | null = null;
const circuitBreakerService = getCircuitBreakerService();

let isShuttingDown = false;
let stopEnvFileWatcher: (() => void) | undefined;
const stopConfigWatcher = watchConfig((cfg) => {
  sorobanEventListener?.stop();
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
    governanceTimelockService.stop();
    liquidityRebalancingWorker?.stop();
    apyWorker.stop();
    storageMonitorService.stop(); // <--- ADDED
    systemHealthWatchdog.stop();
    // FIX 2: Optional chaining — safe to call even if service never started
    gasBalanceMonitorService?.stop();
    circuitBreakerService.stop();
    hourlyAverageService.stop();
    priceAggregatorService.stop();
    providerSecretRotationService.stop();
    storageRentBumpService.stop();
    redisOperationsWorker.stop();
    complianceScreeningWorker.stop();
    getOrderBookSnapshotEngine().stop();
    VolatilityService.stop();
    ArbitrageScanner.stop();
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

httpServer.listen(PORT, async () => {
  console.log(`🌊 StellarFlow Backend running on port ${PORT}`);
  console.log(
    `📊 Market Rates API available at http://localhost:${PORT}/api/market-rates`,
  );
  console.log(
    `📚 API Documentation available at http://localhost:${PORT}/api/docs`,
  );
  console.log(`🏥 Health check at http://localhost:${PORT}/health`);
  console.log(`💓 Liveness probe at http://localhost:${PORT}/health/liveness`);
  console.log(
    `✅ Readiness probe at http://localhost:${PORT}/health/readiness`,
  );
  console.log(`🔌 Socket.io ready for dashboard connections`);

  redisOperationsWorker.start();
  console.log(`🧹 Redis operations worker started`);

  complianceScreeningWorker.start();
  console.log(`🛡️ Compliance screening worker started`);

  // Start PostgreSQL storage footprint monitor (Issue #813)
  try {
    storageMonitorService.start();
    console.log(`💾 Storage monitor service started`);
  } catch (err) {
    console.warn(
      "Storage monitor service not started:",
      err instanceof Error ? err.message : err,
    );
  }

  // Start the order book snapshot engine (Issue #796)
  try {
    getOrderBookSnapshotEngine()
      .start()
      .catch((err) => {
        console.error("Failed to start order book snapshot engine:", err);
      });
    console.log(`📖 Order book snapshot engine started`);
  } catch (err) {
    console.warn(
      "Order book snapshot engine not started:",
      err instanceof Error ? err.message : err,
    );
  }

  // Perform contract sanity check before starting ingestion loop
  let contractSanityPassed = true;
  if (contractSanityCheckService.isConfigured()) {
    try {
      const sanityResult =
        await contractSanityCheckService.performSanityCheck();
      if (!sanityResult.success) {
        console.error(`❌ Contract sanity check failed: ${sanityResult.error}`);
        console.error(
          "⛔ Preventing ingestion loop from starting due to contract failure",
        );
        contractSanityPassed = false;
      }
    } catch (err) {
      console.error(
        "❌ Contract sanity check error:",
        err instanceof Error ? err.message : err,
      );
      console.error(
        "⛔ Preventing ingestion loop from starting due to contract check error",
      );
      contractSanityPassed = false;
    }
  } else {
    console.log(
      "ℹ️ CONTRACT_ID not configured - skipping contract sanity check (ingestion loop will start)",
    );
  }

  // Start Soroban event listener to track confirmed on-chain prices
  // Only start if contract sanity check passed or if check is not configured
  if (contractSanityPassed) {
    try {
      sorobanEventListener = new SorobanEventListener();
      systemHealthWatchdog.registerQueue({
        name: "soroban-event-ingestion",
        getDepth: () => sorobanEventListener?.getQueueDepth() ?? 0,
        maxHealthyDepth:
          Number(process.env.WATCHDOG_INGESTION_QUEUE_MAX_DEPTH) > 0
            ? Number(process.env.WATCHDOG_INGESTION_QUEUE_MAX_DEPTH)
            : 800,
      });
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
  } else {
    console.warn(
      "⚠️ Soroban event listener NOT started due to failed contract sanity check",
    );
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

  try {
    governanceTimelockService.start().catch((err: Error) => {
      console.error("Failed to start governance timelock service:", err);
    });
    console.log("Governance timelock service started");
  } catch (err) {
    console.warn(
      "Governance timelock service not started:",
      err instanceof Error ? err.message : err,
    );
  }

  // Start background hourly average job
  try {
    hourlyAverageService.start().catch((err: Error) => {
      console.error(`Failed to start hourly average service:`, err);
    });
    console.log(`📊 Hourly average service started`);
    // Start OHLCV aggregator
    ohlcvAggregator.start();
    console.log(`📈 OHLCV aggregator started`);
    // Start APY Calculation Worker
    apyWorker.start();
    console.log(`🏦 APY Calculation Worker started`);
  } catch (err) {
    console.warn(
      "Hourly average service not started:",
      err instanceof Error ? err.message : err,
    );
  }

  // Issue #208 – Start OHLC price aggregation worker
  try {
    priceAggregatorService.start().catch((err: Error) => {
      console.error("Failed to start OHLC price aggregator:", err);
    });
    console.log(`📈 OHLC price aggregator started (MINUTE / HOUR / DAY)`);
  } catch (err) {
    console.warn(
      "OHLC price aggregator not started:",
      err instanceof Error ? err.message : err,
    );
  }

  // FIX 3: getGasBalanceMonitorService() moved inside the listen callback so
  // the constructor (and Keypair.fromSecret) only runs after the server is up.
  // A missing secret env var now warns gracefully instead of crashing the process.
  try {
    gasBalanceMonitorService = getGasBalanceMonitorService();
    gasBalanceMonitorService.start().catch((err: Error) => {
      console.error("Failed to start gas balance monitor service:", err);
    });
    console.log(`⛽ Gas balance monitor service started`);
  } catch (err) {
    console.warn(
      "Gas balance monitor service not started:",
      err instanceof Error ? err.message : err,
    );
  }

  // Invariant Violation Automated Circuit Breaker (Issue #829):
  // monitors balance invariants off-chain and auto-submits a pause()
  // transaction signed by the emergency keeper key when a CRITICAL breach
  // is detected. Opt-in via CIRCUIT_BREAKER_ENABLED=true.
  try {
    circuitBreakerService.start().catch((err: Error) => {
      console.error("Failed to start circuit breaker service:", err);
    });
    console.log(`🚨 Circuit breaker service started`);
  } catch (err) {
    console.warn(
      "Circuit breaker service not started:",
      err instanceof Error ? err.message : err,
    );
  }

  // Start storage rent bump service
  try {
    storageRentBumpService.start().catch((err: Error) => {
      console.error("Failed to start storage rent bump service:", err);
    });
  } catch (err) {
    console.warn(
      "Storage rent bump service not started:",
      err instanceof Error ? err.message : err,
    );
  }

  // Start Volatility Service
  try {
    VolatilityService.start();
  } catch (err) {
    console.error("Failed to start volatility service:", err);
  }

  // Start Arbitrage Scanner
  try {
    ArbitrageScanner.start();
  } catch (err) {
    console.error("Failed to start arbitrage scanner:", err);
  }
});

export default app;
