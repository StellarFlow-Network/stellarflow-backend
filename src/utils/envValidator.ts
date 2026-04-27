/**
 * Utility to validate required environment variables on startup.
 * Prevents the server from crashing mysteriously if a setting is missing.
 */

export function validateEnv() {
  const requiredEnvVars = ["DB_URL", "STELLAR_KEY"] as const;
  const missingEnvVars: string[] = [];

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
    console.error(
      "\nPlease set these variables in your .env file and restart the server.",
    );
    // Exit the process with failure code
    process.exit(1);
  }

  // Log optional but recommended environment variables
  const recommendedEnvVars = ["MAX_LATENCY_MS", "REDIS_URL", "TRUST_PROXY"];
  for (const envVar of recommendedEnvVars) {
    if (!process.env[envVar]) {
      console.warn(
        `⚠️ [OPS] Recommended environment variable not set: ${envVar}`,
      );
    } else {
      console.info(`✅ [OPS] ${envVar} = ${process.env[envVar]}`);
    }
  }
}

/**
 * Get the MAX_LATENCY_MS value from environment variables.
 * @returns The latency threshold in milliseconds, or default 30000ms (30 seconds)
 */
export function getMaxLatencyMs(): number {
  const envValue = process.env.MAX_LATENCY_MS;
  if (envValue === undefined || envValue === "") {
    return 30000; // Default: 30 seconds
  }
  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(
      `⚠️ [OPS] Invalid MAX_LATENCY_MS value: "${envValue}". Using default 30000ms.`,
    );
    return 30000;
  }
  return parsed;
}
