import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";

import cacheMetricsRouter from "./cache/CacheMetrics";
import { specs } from "./lib/swagger";
import { adminMiddleware } from "./middleware/adminMiddleware";
import { adminRateLimitMiddleware } from "./middleware/adminRateLimitMiddleware";
import { apiKeyMiddleware } from "./middleware/apiKeyMiddleware";
import { latencyValidationMiddleware } from "./middleware/latencyGuardMiddleware";
import { signatureVerificationMiddleware } from "./middleware/signatureVerificationMiddleware";
import { maintenanceMiddleware } from "./middleware/maintenanceMiddleware";
import { rateLimitMiddleware } from "./middleware/rateLimitMiddleware";
import {
  tracingMiddleware,
  axiosTracingMiddleware,
} from "./middleware/tracingMiddleware";
import { jwtMiddleware } from "./middleware/jwtMiddleware";

import adminRouter from "./routes/admin";
import authRouter from "./routes/auth";
import assetsRouter from "./routes/assets";
import derivedAssetsRouter from "./routes/derivedAssets";
import historyRouter from "./routes/history";
import intelligenceRouter from "./routes/intelligence";
import marketRatesRouter from "./routes/marketRates";
import priceUpdatesRouter from "./routes/priceUpdates";
import sanityCheckRouter from "./routes/sanityCheck";
import statsRouter from "./routes/stats";
import statusRouter from "./routes/status";
import systemControlRouter from "./routes/systemControl";
import systemFailoverRouter from "./routes/systemFailover";
import analyticsRouter from "./routes/analytics";
import zkRouter from "./routes/zk";
import governanceRouter from "./routes/governance";
import proofRouter from "./routes/proof";
import ordersRouter from "./routes/orders";
import sorobanSimulationRouter from "./routes/sorobanSimulation";
import remittanceRouter from "./routes/remittance";
import { sendApiError } from "./lib/apiError.js";
import metricsRouter from "./routes/metrics";

dotenv.config();

const app = express();

const dashboardUrl =
  process.env.DASHBOARD_URL ||
  process.env.FRONTEND_URL ||
  "http://localhost:3000";

app.use(morgan("dev"));

// Maintenance mode middleware: must be early in the chain
app.use(maintenanceMiddleware);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origin === dashboardUrl) return callback(null, true);
      return callback(
        new Error(
          `CORS policy: Access denied from origin ${origin}. Allowed origin: ${dashboardUrl}`,
        ),
      );
    },
    credentials: true,
  }),
);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "https:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    noSniff: true,
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xssFilter: false,
    hidePoweredBy: true,
    hsts: { maxAge: 31536000, includeSubDomains: false, preload: false },
  }),
);

app.use(express.json());

// Add tracing middleware early in the stack
app.use(tracingMiddleware);
app.use(axiosTracingMiddleware);

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

app.use("/api/v1/auth", authRouter);
app.use("/api", rateLimitMiddleware);
app.use("/api", apiKeyMiddleware);
app.use("/api", jwtMiddleware);

// Ed25519 signature verification for relayer payloads (Issue #225)
app.use("/api/v1/price-updates", signatureVerificationMiddleware);

// Latency validation for relayer payloads - validates timestamps to prevent stale data
app.use("/api/v1/price-updates", latencyValidationMiddleware);

app.use("/api/admin", adminMiddleware, adminRateLimitMiddleware, adminRouter);
app.use(
  "/api/admin/system",
  adminMiddleware,
  adminRateLimitMiddleware,
  systemControlRouter,
);
app.use(
  "/api/v1/system",
  adminMiddleware,
  adminRateLimitMiddleware,
  systemFailoverRouter,
);

app.use("/api/v1/market-rates", marketRatesRouter);
app.use("/api/v1/history", historyRouter);
app.use("/api/v1/stats", statsRouter);
app.use("/api/v1/intelligence", intelligenceRouter);
app.use("/api/v1/price-updates", priceUpdatesRouter);
app.use("/api/v1/assets", assetsRouter);
app.use("/api/v1/status", statusRouter);
app.use("/api/v1/derived-assets", derivedAssetsRouter);
app.use("/api/v1/sanity-check", sanityCheckRouter);
app.use("/api/v1/cache", cacheMetricsRouter);

// Issue #208 – Analytics / OHLC time-series endpoint
app.use("/api/v1/analytics", analyticsRouter);

app.use("/api/v1/zk", zkRouter);
app.use("/api/v1/governance", governanceRouter);
app.use("/api/v1/proof", proofRouter);
app.use("/api/v1/orders", ordersRouter);

// Issue #815 – Remittance transaction history endpoint
app.use("/api/v1/remittance", remittanceRouter);

// Issue #836 – Soroban Contract Instruction & Storage Rent Estimator
// eslint-disable-next-line no-undef
app.use("/api/v1/soroban/rent", sorobanRentEstimateRouter);
app.use("/api/v1/soroban/simulate", sorobanSimulationRouter);

// Issue #813 Build Automated Storage Footprint Monitor for Managed PostgreSQL
app.use("/metrics", metricsRouter);

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
      derivedAssets: {
        crossRate: "/api/v1/derived-assets/rate/:base/:quote",
        ngnGhs: "/api/v1/derived-assets/ngn-ghs",
      },
      admin: {
        lockdown: "POST /api/admin/lockdown",
        reportSummary:
          "/api/admin/reports/summary?format=html|pdf&month=YYYY-MM",
        rateLimit: {
          getConfig: "GET /api/admin/rate-limit",
          updateConfig: "PUT /api/admin/rate-limit",
          refreshWhitelist: "POST /api/admin/rate-limit/whitelist/refresh",
        },
      },
      paymentRouting: {
        findRoutes: "POST /api/v1/payment-routing/routes",
        createRoute: "POST /api/v1/payment-routing/routes/create",
        listRoutes: "GET /api/v1/payment-routing/routes",
        getRoute: "GET /api/v1/payment-routing/routes/:id",
        updateRouteStatus: "PATCH /api/v1/payment-routing/routes/:id/status",
        requestQuote: "POST /api/v1/payment-routing/quotes",
        lockQuote: "POST /api/v1/payment-routing/quotes/:id/lock",
        getQuote: "GET /api/v1/payment-routing/quotes/:id",
      },
    },
  });
});

app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Unhandled error:", err);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR");
  },
);

app.use((req, res) => {
  sendApiError(res, 404, "ENDPOINT_NOT_FOUND");
});

export default app;
