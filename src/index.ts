import express from "express";
import { createServer } from "http";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import helmet from "helmet";
import { Horizon } from "@stellar/stellar-sdk";
import swaggerUi from "swagger-ui-express";
import marketRatesRouter from "./routes/marketRates";
import historyRouter from "./routes/history";
import statsRouter from "./routes/stats";
import intelligenceRouter from "./routes/intelligence";
import priceUpdatesRouter from "./routes/priceUpdates";
import assetsRouter from "./routes/assets";
import statusRouter from "./routes/status";
import prisma from "./lib/prisma";
import { initSocket } from "./lib/socket";
import { SorobanEventListener } from "./services/sorobanEventListener";
import { specs } from "./lib/swagger";
import { multiSigSubmissionService } from "./services/multiSigSubmissionService";
import { apiKeyMiddleware } from "./middleware/apiKeyMiddleware";
import { rateLimitMiddleware } from "./middleware/rateLimitMiddleware";
import { validateEnv } from "./utils/envValidator";
import { hourlyAverageService } from "./services/hourlyAverageService";
import { metricsMiddleware, metricsEndpoint } from "./middleware/metrics";

// Load environment variables
dotenv.config();

// [OPS] Implement "Environment Variable" Check on Start
validateEnv();

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

const app = express();
const PORT = process.env.PORT || 3000;

// Horizon server for health checks
const stellarNetwork = process.env.STELLAR_NETWORK || "TESTNET";
const horizonUrl =
  stellarNetwork === "PUBLIC"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
const horizonServer = new Horizon.Server(horizonUrl);

// Middleware
app.use(morgan("dev"));
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser requests (e.g. curl, server-to-server)
      if (!origin) {
        return callback(null, true);
      }

      if (origin === dashboardUrl) {
        return callback(null, true);
      }

      return callback(
        new Error(
          `CORS policy: Access denied from origin ${origin}. Allowed origin: ${dashboardUrl}`,
        ),
      );
    },
    credentials: true,
  }),
);
// Security headers with Helmet - placed early before routes
// Configured for API backend with minimal CSP to avoid breaking Swagger UI or frontend integration
app.use(
  helmet({
    // Content Security Policy - minimal config for API backend
    // Allows Swagger UI to function while providing basic XSS protection
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // 'unsafe-inline' needed for Swagger UI
        styleSrc: ["'self'", "'unsafe-inline'"], // 'unsafe-inline' needed for Swagger UI inline styles
        imgSrc: ["'self'", "data:", "https:"], // Allow data: for Swagger UI icons, https: for external images
        fontSrc: ["'self'", "https:"], // Allow fonts from https (Swagger UI uses cdnjs)
        connectSrc: ["'self'", "https:"], // Allow API calls to any https endpoint
        frameAncestors: ["'none'"], // Prevent clickjacking
      },
    },
    // X-Content-Type-Options: nosniff - prevents MIME type sniffing
    noSniff: true,
    // X-Frame-Options: DENY - prevents clickjacking (also covered by CSP frameAncestors)
    frameguard: { action: "deny" },
    // Referrer-Policy: strict-origin-when-cross-origin - sends referrer only to same-origin
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // X-XSS-Protection is deprecated and not recommended (modern browsers use CSP instead)
    xssFilter: false,
    // Hide X-Powered-By header to reduce fingerprinting
    hidePoweredBy: true,
    // Strict-Transport-Security for HTTPS enforcement (only if behind HTTPS proxy)
    hsts: { maxAge: 31536000, includeSubDomains: false, preload: false },
  }),
);
app.use(express.json());

// Swagger documentation
app.use("/api/v1/docs", swaggerUi.serve);
app.get(
  "/api/v1/docs",
  swaggerUi.setup(specs, {
    swaggerOptions: {
      persistAuthorization: true,
    },
    customCss: `
    .topbar { display: none; }
    .swagger-ui .api-info { margin-bottom: 20px; }
  `,
    customSiteTitle: "StellarFlow API Documentation",
  }),
);

// Expose metrics endpoint early so it's not rate limited, but still want timing
app.use(metricsMiddleware);
app.get("/metrics", metricsEndpoint);

// Apply Rate Limiting to all /api routes
app.use("/api", rateLimitMiddleware);

// Apply API Key Middleware to all /api routes
app.use("/api", apiKeyMiddleware);
// Apply API Key Middleware to all /api/v1 routes
app.use("/api/v1", apiKeyMiddleware);

// Routes
app.use("/api/v1/market-rates", marketRatesRouter);
app.use("/api/v1/history", historyRouter);
app.use("/api/v1/stats", statsRouter);
app.use("/api/v1/intelligence", intelligenceRouter);
app.use("/api/v1/price-updates", priceUpdatesRouter);
app.use("/api/v1/assets", assetsRouter);
app.use("/api/v1/status", statusRouter);

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
    },
  });
});

// Error handling middleware
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  },
);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
  });
});

// Start server
const httpServer = createServer(app);
initSocket(httpServer);
let sorobanEventListener: SorobanEventListener | null = null;
let isShuttingDown = false;

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

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
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

    await closeHttpServer();
    console.log("HTTP server closed.");

    await prisma.$disconnect();
    console.log("Database connections closed cleanly.");

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
