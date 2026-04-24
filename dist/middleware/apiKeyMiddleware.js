export const apiKeyMiddleware = (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    const expectedKey = process.env.API_KEY;
    if (!expectedKey) {
        console.error("Critical: API_KEY not set in environment");
        return res.status(500).json({
            success: false,
            error: "Authentication configuration error",
        });
    }
    if (apiKey !== expectedKey) {
        return res.status(401).json({
            success: false,
            error: "Invalid or missing API key",
        });
    }
    next();
};
//# sourceMappingURL=apiKeyMiddleware.js.map