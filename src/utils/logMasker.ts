/**
 * Log Masking Utility
 * Scrubs sensitive data (secrets, API keys, passwords, etc.) from log output
 * to prevent leaking confidential information to stdout/stderr.
 */

// Patterns for detecting sensitive values
const SENSITIVE_PATTERNS = [
  // Environment variable names that contain sensitive data
  /\b(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|PRIVATE|API_KEY|APIKEY|AUTH|PK)\b/gi,

  // Stellar secret keys (start with 'S' and are 56 characters base32, typically A-Z and 2-7)
  /\bS[A-Z2-7]{48,56}\b/g,

  // Ethereum-style private keys (64 hex chars or 66 with 0x prefix)
  /\b(0x)?[a-fA-F0-9]{64}\b/g,

  // Common Bearer tokens
  /Bearer\s+[A-Za-z0-9._-]+/gi,

  // Database connection strings with passwords
  /(:\/\/[^:]+:)([^@]+)(@)/g,

  // AWS-style access keys (AKIA followed by 16 alphanumeric chars)
  /AKIA[0-9A-Z]{16}/g,
];

/**
 * Masks sensitive values in a string by replacing them with [REDACTED]
 * @param input - The string to mask
 * @returns The masked string with sensitive data replaced
 */
export function maskSensitiveData(input: string): string {
  if (!input || typeof input !== "string") {
    return input;
  }

  let masked = input;

  // Apply each pattern
  for (const pattern of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      // For database connection strings, preserve the connection type
      if (match.includes("://")) {
        return match.replace(/(:\/\/[^:]+:)([^@]+)(@)/, "$1[REDACTED]$3");
      }
      // For Bearer tokens, preserve the scheme
      if (match.toLowerCase().startsWith("bearer")) {
        return "Bearer [REDACTED]";
      }
      // For other matches, just redact
      return "[REDACTED]";
    });
  }

  return masked;
}

/**
 * Masks sensitive data in an object (recursively)
 * @param obj - The object to mask
 * @returns A new object with sensitive values masked
 */
export function maskSensitiveObject(
  obj: Record<string, any>,
): Record<string, any> {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  const masked: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Check if the key name suggests sensitive data
    if (/secret|password|token|key|credential|private|api|auth/i.test(key)) {
      masked[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      masked[key] = maskSensitiveData(value);
    } else if (Array.isArray(value)) {
      masked[key] = value.map((item) =>
        typeof item === "string" ? maskSensitiveData(item) : item,
      );
    } else if (typeof value === "object" && value !== null) {
      masked[key] = maskSensitiveObject(value);
    } else {
      masked[key] = value;
    }
  }

  return masked;
}

/**
 * Creates a masked console object that automatically scrubs logs
 * Replace console.log, console.error, etc. with these versions
 */
export const maskedConsole = {
  log: (...args: any[]): void => {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    console.log(...maskedArgs);
  },

  error: (...args: any[]): void => {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    console.error(...maskedArgs);
  },

  warn: (...args: any[]): void => {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    console.warn(...maskedArgs);
  },

  info: (...args: any[]): void => {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    console.info(...maskedArgs);
  },

  debug: (...args: any[]): void => {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    console.debug(...maskedArgs);
  },
};

/**
 * Intercepts all console methods and applies masking
 * Call this once at application startup to enable global log masking
 */
export function enableGlobalLogMasking(): void {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  console.log = function (...args: any[]): void {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    originalLog(...maskedArgs);
  };

  console.error = function (...args: any[]): void {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    originalError(...maskedArgs);
  };

  console.warn = function (...args: any[]): void {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    originalWarn(...maskedArgs);
  };

  console.info = function (...args: any[]): void {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    originalInfo(...maskedArgs);
  };

  console.debug = function (...args: any[]): void {
    const maskedArgs = args.map((arg) =>
      typeof arg === "string" ? maskSensitiveData(arg) : arg,
    );
    originalDebug(...maskedArgs);
  };
}
