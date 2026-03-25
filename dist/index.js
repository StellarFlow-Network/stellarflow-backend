import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import marketRatesRouter from './routes/marketRates';
// Load environment variables
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
// Middleware
app.use(cors());
app.use(express.json());
// Routes
app.use('/api/market-rates', marketRatesRouter);
// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'StellarFlow Backend is running',
        timestamp: new Date().toISOString()
    });
});
// Root endpoint
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'StellarFlow Backend API',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            marketRates: {
                allRates: '/api/market-rates/rates',
                singleRate: '/api/market-rates/rate/:currency',
                health: '/api/market-rates/health',
                currencies: '/api/market-rates/currencies',
                cache: '/api/market-rates/cache',
                clearCache: 'POST /api/market-rates/cache/clear'
            }
        }
    });
});
// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});
// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});
// Start server
app.listen(PORT, () => {
    console.log(`🌊 StellarFlow Backend running on port ${PORT}`);
    console.log(`📊 Market Rates API available at http://localhost:${PORT}/api/market-rates`);
    console.log(`🏥 Health check at http://localhost:${PORT}/health`);
});
export default app;
//# sourceMappingURL=index.js.map