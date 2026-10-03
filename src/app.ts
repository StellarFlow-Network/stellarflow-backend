import dotenv
from "dotenv";
import express from "express";
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
import { graphqlQueryGuard } from "./middleware/graphqlQueryGuard";
import { applyHttpSecurity } from "./middleware/httpSecurity";
import { compressionMiddleware } from "./middleware/compressionMiddleware";
import {
  tracingMiddleware,
  axiosTracingMiddleware,
} from "./middleware/tracingMiddleware";
import { jwtMiddleware } from "./middleware/jwtMiddleware";

import adminRouter from "./routes/admin";
import authRouter from "./routes/auth";
import oidcRouter from "./routes/oidc";
import assetsRouter from "./routes/assets";
import derivedAssetsRouter from "./routes/derivedAssets";
import historyRouter from "./routes/history";
import intelligenceRouter from "./routes/intelligence";
import marketRatesRouter from "./routes/marketRates";
import priceUpdatesRouter from "./routes/priceUpdates";
import sanityCheckRouter from "./routes/sanityCheck";
import statsRouter from "./routes/stats";
import statusRouter from "./routes/status";
import poolsRouter from "./routes/pools";
import systemControlRouter from "./routes/systemControl";
import systemFailoverRouter from "./routes/systemFailover";
import analyticsRouter from "./routes/analytics";
import gasProfileRouter from "./routes/gasProfile";
import zkRouter from "./routes/zk";
import governanceRouter from "./routes/governance";
import governanceWebhooksRouter from "./routes/governanceWebhooks";
import healthRouter from "./routes/health";
import proofRouter from "./routes/proof";
import ordersRouter from "./routes/orders";
import sorobanSimulationRouter from "./routes/sorobanSimulation";
import sorobanRentEstimateRouter from "./routes/sorobanRentEstimate";
import remittanceRouter from "./routes/remittance";
import kycRouter from "./routes/kyc";
import userConversionsRouter from "./routes/userConversions";
import paymentRoutingRouter from "./routes/paymentRouting";
import anchorsRouter from "./routes/anchors";
import sep31Router from "./routes/sep31";
import relayerKeysRouter from "./routes/relayerKeys";
import eventBusRouter from "./routes/eventBus";
import { sendApiError } from "./lib/apiError.js";
import metricsRouter from "./routes/metrics";
import watchlistRouter from "./routes/watchlist";
import treasuryRouter from "./routes/treasury";
import marketStreamRouter from "./routes/marketStream";

dotenv.config();

const app = express();

app.use(morgan("dev"));

// Issue #1015 – SEP-24 interactive webview. Browser-facing HTML opened by end
// users, so it is mounted ahead of the JSON-API security chain below: that chain
// sends `frame-ancestors 'none'` and a CORS allowlist that would block wallets
// from framing it and same-origin form posts. The router applies its own
// nonce-based CSP, rate limiting and signed-token authentication.
app.use("/sep24", sep24InteractiveRouter);

// Issue #792 – Security headers + strict CORS allowlist. Registered before
// everything else so the headers reach every response, including short-circuit
// replies such as CORS 403s, preflight 204s and maintenance 503s.
applyHttpSecurity(app);

// Maintenance mode middleware: must be early in the chain
app.use(maintenanceMiddleware);

// Dynamic payload compression middleware: gzip and brotli (> 1KB threshold)
app.use(compressionMiddleware());

app.use(express.json());

// Issue #924 – GraphQL query depth & complexity guard
// Intercepts POST /graphql requests before they reach any downstream handler.
app.use("/graphql", graphqlQueryGuard());

// Add tracing middleware early in the stack
app.use(tracingMiddleware);
app.use(axiosTracingMiddleware);

app.use("/health", healthRouter);

// Issue #1040 – SEP-01 stellar.toml metadata served from the well-known path.
app.use("/.well-known", stellarTomlRouter);

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

app.use("/api/v1/auth/oidc", oidcRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api", apiKeyMiddleware);
app.use("/api", rateLimitMiddleware);
app.use("/api", jwtMiddleware);

// Ed25519 signature verification for relayer payloads (Issue #225)
app.use("/api/v1/price-updates", signatureVerificationMiddleware);

// Latency validation for relayer payloads - validates timestamps to prevent stale data
app.use("/api/v1/price-updates", latencyValidationMiddleware);

app.use("/api/admin", adminMiddleware, adminRateLimitMiddleware, adminRouter);
app.use(
  "/api/admin",
  adminMiddleware,
  adminRateLimitMiddleware,
  relayerKeysRouter,
);
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

// Issue #1082 – Governance Proposal Execution Status Webhook Broadcaster
app.use(
  "/api/v1/admin/governance/webhooks",
  adminMiddleware,
  adminRateLimitMiddleware,
  governanceWebhooksRouter,
);

// Issue #1055 – Internal event bus metrics and queue backpressure alert bot
app.use(
  "/api/v1/admin/event-bus",
  adminMiddleware,
  adminRateLimitMiddleware,
  eventBusRouter,
);

app.use("/api/v1/market-rates", marketRatesRouter);
app.use("/api/v1/history", historyRouter);
app.use("/api/v1/stats", statsRouter);
app.use("/api/v1/intelligence", intelligenceRouter);
app.use("/api/v1/price-updates", priceUpdatesRouter);
app.use("/api/v1/assets", assetsRouter);
app.use("/api/v1/status", statusRouter);
app.use("/api/v1/pools", poolsRouter);
app.use("/api/v1/derived-assets", derivedAssetsRouter);
app.use("/api/v1/sanity-check", sanityCheckRouter);
app.use("/api/v1/cache", cacheMetricsRouter);

// Issue #208 – Analytics / OHL  time-series endpoint
app.use("/api/v1/analytics", analyticsRouter);

// Issue #786 – Gas & CPU instruction profiler daily averages
app.use("/api/v1/gas-profile", gasProfileRouter);

app.use("/api/v1/zk", zkRouter);
app.use("/api/v1/governance", governanceRouter);
app.use("/api/v1/proof", proofRouter);
// Issue #967 – verify Soroban storage inclusion proofs against ledger headers.
app.use("/api/v1/state", stateRouter);
app.use("/api/v1/orders", ordersRouter);
app.use("/api/v1/users/watchlist", watchlistRouter);
app.use("/api/v1/treasury", treasuryRouter);

// Issue #815 – Remittance transaction history endpoint
app.use("/api/v1/remittance", remittanceRouter);

// Issue #990 – SEP-12 customer information transfer (KYC) endpoints
app.use("/api/v1/kyc", kycRouter);

app.use("/api/v1/users", userConversionsRouter);
app.use("/api/v1/payment-routing", paymentRoutingRouter);

// Issue #931 – Anchor SEP-24 / SEP-31 Webhook Ingestion Service
app.use("/api/v1/anchors", anchorsRouter);
app.use("/api/v1/sep31", sep31Router);

// Issue #1015 – SEP-24 interactive session initiation (authenticated by the /api chain)
app.use("/api/v1/sep24", sep24InitiationRouter);

// Issue #1046 – Yield Farming Token Emission Schedule Calculator
app.use("/api/v1/yield", yieldEmissionRouter);

// Issue #1003 – Dynamic vault collateral valuation factors
app.use("/api/v1/risk", riskRouter);

// Issue #1067 – Soroban state root inspection status
app.use("/api/v1/security", securityRouter);

// Issue #1009 – Tax-compliant user transaction history exports
app.use("/api/v1/users", taxReportRouter);

// Issue #836 – Soroban Contract Instruction & Storage Rent Estimator
// eslint-disable-next-line no-undef
app.use("/api/v1/soroban/rent", sorobanRentEstimateRouter);
app.use("/api/v1/soroban/simulate", sorobanSimulationRouter);

// Issue #813 Build Automated Storage Footprint Monitor for Managed PostgreSQL
app.use("/metrics", metricsRouter);

// Issue #1091 – High-Frequency Market Stream Aggregator
app.use("/api/v1/market-stream", marketStreamRouter);

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
        ngnGhs: "/api/v1/derived-assets/njn-ghs",
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
marketStream: {
        websocket: "ws://.../v1/market-stream?pairs=USDC-XLM,BTC-USDC",
        metrics: "GET /api/v1/market-stream/metrics",
        publish: "POST /api/v1/market-stream/publish",
      },
      yield: {
        emissions: "/api/v1/yield/emissions",
        emissionRate: "/api/v1/yield/emissions/rate",
        emissionSchedule: "/api/v1/yield/emissions/schedule",
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
