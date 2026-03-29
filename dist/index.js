import express from "express";
import { createServer } from "http";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import { Horizon } from "@stellar/stellar-sdk";
import swaggerUi from "swagger-ui-express";
import marketRatesRouter from "./routes/marketRates";
import historyRouter from "./routes/history";
import statsRouter from "./routes/stats";
import intelligenceRouter from "./routes/intelligence";
import priceUpdatesRouter from "./routes/priceUpdates";
import assetsRouter from "./routes/assets";
import prisma from "./lib/prisma";
import { initSocket } from "./lib/socket";
import { logger, morganStream } from "./lib/logger";
import { SorobanEventListener } from "./services/sorobanEventListener";
import { specs } from "./lib/swagger";
import { multiSigSubmissionService } from "./services/multiSigSubmissionService";
import { apiKeyMiddleware } from "./middleware/apiKeyMiddleware";
// Load environment variables
dotenv.config();
logger.level =
    process.env.LOG_LEVEL ||
        (process.env.NODE_ENV === "production" ? "info" : "debug");
const getErrorDetails = (error) => {
    if (error instanceof Error) {
        return { message: error.message, stack: error.stack };
    }
    return { message: String(error) };
};
// Validate required environment variables
const requiredEnvVars = ["STELLAR_SECRET", "DATABASE_URL"];
const missingEnvVars = [];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        missingEnvVars.push(envVar);
    }
}
if (missingEnvVars.length > 0) {
    logger.error("Missing required environment variables", {
        missingVariables: missingEnvVars,
    });
    logger.error("Please set these variables in your .env file and restart the server.");
    process.exit(1);
}
const dashboardUrl = process.env.DASHBOARD_URL || process.env.FRONTEND_URL || "http://localhost:3000";
if (!dashboardUrl) {
    logger.error("Missing required environment variable: DASHBOARD_URL");
    process.exit(1);
}
const app = express();
const PORT = process.env.PORT || 3000;
// Horizon server for health checks
const stellarNetwork = process.env.STELLAR_NETWORK || "TESTNET";
const horizonUrl = stellarNetwork === "PUBLIC"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
const horizonServer = new Horizon.Server(horizonUrl);
// Middleware
app.use(morgan(":method :url :status :response-time ms - :res[content-length] bytes", {
    stream: morganStream,
    skip: (req) => req.path === "/health",
}));
app.use(cors({
    origin: (origin, callback) => {
        // Allow non-browser requests (e.g. curl, server-to-server)
        if (!origin) {
            return callback(null, true);
        }
        if (origin === dashboardUrl) {
            return callback(null, true);
        }
        return callback(new Error(`CORS policy: Access denied from origin ${origin}. Allowed origin: ${dashboardUrl}`));
    },
    credentials: true,
}));
app.use(express.json());
// Swagger documentation
app.use("/api/docs", swaggerUi.serve);
app.get("/api/docs", swaggerUi.setup(specs, {
    swaggerOptions: {
        persistAuthorization: true,
    },
    customCss: `
    .topbar { display: none; }
    .swagger-ui .api-info { margin-bottom: 20px; }
  `,
    customSiteTitle: "StellarFlow API Documentation",
}));
// Apply API Key Middleware to all /api routes
app.use("/api", apiKeyMiddleware);
// Routes
app.use("/api/market-rates", marketRatesRouter);
app.use("/api/history", historyRouter);
app.use("/api/stats", statsRouter);
app.use("/api/intelligence", intelligenceRouter);
app.use("/api/price-updates", priceUpdatesRouter);
app.use("/api/assets", assetsRouter);
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
    const checks = {
        database: false,
        horizon: false,
    };
    // Check database connectivity
    try {
        await prisma.$queryRaw `SELECT 1`;
        checks.database = true;
    }
    catch {
        checks.database = false;
    }
    // Check Stellar Horizon reachability
    try {
        await horizonServer.root();
        checks.horizon = true;
    }
    catch {
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
                allRates: "/api/market-rates/rates",
                singleRate: "/api/market-rates/rate/:currency",
                health: "/api/market-rates/health",
                currencies: "/api/market-rates/currencies",
                cache: "/api/market-rates/cache",
                clearCache: "POST /api/market-rates/cache/clear",
            },
            stats: {
                volume: "/api/stats/volume?date=YYYY-MM-DD",
            },
            history: {
                assetHistory: "/api/history/:asset?range=1d|7d|30d|90d",
            },
        },
    });
});
// Error handling middleware
app.use((err, req, res, _next) => {
    logger.error("Unhandled error", {
        message: err.message,
        stack: err.stack,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
    });
    res.status(500).json({
        success: false,
        error: "Internal server error",
    });
});
// 404 handler
app.use("*", (req, res) => {
    res.status(404).json({
        success: false,
        error: "Endpoint not found",
    });
});
process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", getErrorDetails(reason));
});
process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", getErrorDetails(error));
});
// Start server
const httpServer = createServer(app);
initSocket(httpServer);
httpServer.listen(PORT, () => {
    logger.info(`StellarFlow Backend running on port ${PORT}`);
    logger.info(`Market Rates API available at http://localhost:${PORT}/api/market-rates`);
    logger.info(`API Documentation available at http://localhost:${PORT}/api/docs`);
    logger.info(`Health check at http://localhost:${PORT}/health`);
    logger.info("Socket.io ready for dashboard connections");
    // Start Soroban event listener to track confirmed on-chain prices
    try {
        const eventListener = new SorobanEventListener();
        eventListener.start().catch((err) => {
            logger.error("Failed to start event listener", getErrorDetails(err));
        });
        logger.info("Soroban event listener started");
    }
    catch (err) {
        logger.warn("Event listener not started", {
            message: err instanceof Error ? err.message : String(err),
        });
    }
    // Start multi-sig submission service if enabled
    if (process.env.MULTI_SIG_ENABLED === "true") {
        try {
            multiSigSubmissionService.start().catch((err) => {
                logger.error("Failed to start multi-sig submission service", getErrorDetails(err));
            });
            logger.info("Multi-Sig submission service started");
        }
        catch (err) {
            logger.warn("Multi-sig submission service not started", {
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }
    else {
        logger.info("Multi-Sig submission service is disabled");
    }
});
export default app;
//# sourceMappingURL=index.js.map