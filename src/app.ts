import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import cacheMetricsRouter from "./cache/CacheMetrics";
import { specs } from "./lib/swagger";
import { apiKeyMiddleware } from "./middleware/apiKeyMiddleware";
import { maintenanceMiddleware } from "./middleware/maintenanceMiddleware";
import { rateLimitMiddleware } from "./middleware/rateLimitMiddleware";
import adminRouter from "./routes/admin";
import assetsRouter from "./routes/assets";
import derivedAssetsRouter from "./routes/derivedAssets";
import historyRouter from "./routes/history";
import intelligenceRouter from "./routes/intelligence";
import marketRatesRouter from "./routes/marketRates";
import priceUpdatesRouter from "./routes/priceUpdates";
import sanityCheckRouter from "./routes/sanityCheck";
import statsRouter from "./routes/stats";
import statusRouter from "./routes/status";

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

app.use("/api", rateLimitMiddleware);
app.use("/api", apiKeyMiddleware);
app.use("/api/v1", apiKeyMiddleware);

app.use("/api/admin", adminMiddleware, adminRouter);
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
      derivedAssets: {
        crossRate: "/api/v1/derived-assets/rate/:base/:quote",
        ngnGhs: "/api/v1/derived-assets/ngn-ghs",
      },
      admin: {
        lockdown: "POST /api/admin/lockdown",
        reportSummary:
          "/api/admin/reports/summary?format=html|pdf&month=YYYY-MM",
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
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  },
);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
  });
});

export default app;