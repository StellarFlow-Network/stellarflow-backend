/**
 * Utility to validate required environment variables on startup.
 * Prevents the server from crashing mysteriously if a setting is missing.
 */
export function validateEnv() {
    const requiredEnvVars = ["DB_URL", "STELLAR_KEY"];
    const missingEnvVars = [];
    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
            missingEnvVars.push(envVar);
        }
    }
    if (missingEnvVars.length > 0) {
        console.error("❌ [OPS] Missing required environment variables:");
        missingEnvVars.forEach((varName) => {
            console.error(`   - ${varName}`);
        });
        console.error("\nPlease set these variables in your .env file and restart the server.");
        // Exit the process with failure code
        process.exit(1);
    }
}
//# sourceMappingURL=envValidator.js.map