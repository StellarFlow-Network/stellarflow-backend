import express from "express";
import { createServer } from "http";
import cors from "cors";
import dotenv from "dotenv";
import { Horizon } from "@stellar/stellar-sdk";
import marketRatesRouter from "./routes/marketRates";
import historyRouter from "./routes/history";
import priceUpdatesRouter from "./routes/priceUpdates";
import prisma from "./lib/prisma";
import { initSocket } from "./lib/socket";
import { SorobanEventListener } from "./services/sorobanEventListener";
import { multiSigSubmissionService } from "./services/multiSigSubmissionService";
// Load environment variables
dotenv.config();
// Validate required environment variables
const requiredEnvVars = ["STELLAR_SECRET", "DATABASE_URL"];
const missingEnvVars = [];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        missingEnvVars.push(envVar);
    }
}
if (missingEnvVars.length > 0) {
    console.error("❌ Missing required environment variables:");
    missingEnvVars.forEach((varName) => console.error(`   - ${varName}`));
    console.error("\nPlease set these variables in your .env file and restart the server.");
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
app.use(cors());
app.use(express.json());
// Routes
app.use("/api/market-rates", marketRatesRouter);
app.use("/api/history", historyRouter);
app.use("/api/price-updates", priceUpdatesRouter);
// Health check endpoint
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
        },
    });
});
// Error handling middleware
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
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
// Start server
const httpServer = createServer(app);
initSocket(httpServer);
httpServer.listen(PORT, () => {
    console.log(`🌊 StellarFlow Backend running on port ${PORT}`);
    console.log(`📊 Market Rates API available at http://localhost:${PORT}/api/market-rates`);
    console.log(`🏥 Health check at http://localhost:${PORT}/health`);
    console.log(`🔌 Socket.io ready for dashboard connections`);
    // Start Soroban event listener to track confirmed on-chain prices
    try {
        const eventListener = new SorobanEventListener();
        eventListener.start().catch((err) => {
            console.error("Failed to start event listener:", err);
        });
        console.log(`👂 Soroban event listener started`);
    }
    catch (err) {
        console.warn("Event listener not started:", err instanceof Error ? err.message : err);
    }
    // Start multi-sig submission service if enabled
    if (process.env.MULTI_SIG_ENABLED === "true") {
        try {
            multiSigSubmissionService.start().catch((err) => {
                console.error("Failed to start multi-sig submission service:", err);
            });
            console.log(`🔐 Multi-Sig submission service started`);
        }
        catch (err) {
            console.warn("Multi-sig submission service not started:", err instanceof Error ? err.message : err);
        }
    }
});
export default app;
//# sourceMappingURL=index.js.map