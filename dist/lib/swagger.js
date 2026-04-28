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
                HourlyVolatilitySnapshotItem: {
                    type: "object",
                    properties: {
                        currency: {
                            type: "string",
                            example: "NGN",
                        },
                        standardDeviation: {
                            type: "number",
                            example: 12.3456,
                            description: "Population standard deviation of rates recorded in the last 60 minutes",
                        },
                        sampleCount: {
                            type: "integer",
                            example: 8,
                        },
                        meanRate: {
                            type: "number",
                            nullable: true,
                            example: 1825.42,
                        },
                        latestRate: {
                            type: "number",
                            nullable: true,
                            example: 1830.1,
                        },
                        latestTimestamp: {
                            type: "string",
                            format: "date-time",
                            nullable: true,
                        },
                    },
                },
                HourlyVolatilitySnapshot: {
                    type: "object",
                    properties: {
                        windowMinutes: {
                            type: "integer",
                            example: 60,
                        },
                        windowStart: {
                            type: "string",
                            format: "date-time",
                        },
                        windowEnd: {
                            type: "string",
                            format: "date-time",
                        },
                        generatedAt: {
                            type: "string",
                            format: "date-time",
                        },
                        currencies: {
                            type: "array",
                            items: {
                                $ref: "#/components/schemas/HourlyVolatilitySnapshotItem",
                            },
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
            {
                name: "Intelligence",
                description: "Derived market intelligence endpoints",
            },
        ],
    },
    apis: ["./src/routes/*.ts", "./src/index.ts"],
};
export const specs = swaggerJsdoc(options);
//# sourceMappingURL=swagger.js.map