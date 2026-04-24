import swaggerJsdoc from "swagger-jsdoc";
const options = {
    definition: {
        openapi: "3.0.0",
        info: {
            title: "StellarFlow Backend API",
            version: "1.0.0",
            description: "A comprehensive API for managing Stellar market rates and transaction history",
            contact: {
                name: "StellarFlow Team",
                url: "https://github.com/StellarFlow-Network/stellarflow-backend",
            },
        },
        servers: [
            {
                url: process.env.API_URL || "http://localhost:3000",
                description: "Development server",
            },
        ],
        components: {
            schemas: {
                Error: {
                    type: "object",
                    properties: {
                        success: {
                            type: "boolean",
                            example: false,
                        },
                        error: {
                            type: "string",
                            example: "Error message",
                        },
                    },
                },
                SuccessResponse: {
                    type: "object",
                    properties: {
                        success: {
                            type: "boolean",
                            example: true,
                        },
                    },
                },
                MarketRate: {
                    type: "object",
                    properties: {
                        currency: {
                            type: "string",
                            example: "GHS",
                        },
                        rate: {
                            type: "number",
                            example: 24.5,
                            description: "Current exchange rate",
                        },
                        source: {
                            type: "string",
                            example: "API_PROVIDER",
                        },
                        timestamp: {
                            type: "string",
                            format: "date-time",
                            description: "Last updated timestamp",
                        },
                    },
                },
                PriceHistory: {
                    type: "object",
                    properties: {
                        timestamp: {
                            type: "string",
                            format: "date-time",
                        },
                        rate: {
                            type: "number",
                        },
                        source: {
                            type: "string",
                        },
                    },
                },
            },
        },
        tags: [
            {
                name: "Health",
                description: "System health check endpoints",
            },
            {
                name: "Market Rates",
                description: "Market rate endpoints for different currencies",
            },
            {
                name: "History",
                description: "Price history endpoints",
            },
        ],
    },
    apis: ["./src/routes/*.ts", "./src/index.ts"],
};
export const specs = swaggerJsdoc(options);
//# sourceMappingURL=swagger.js.map