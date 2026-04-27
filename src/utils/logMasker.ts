/**
 * Log Masking Utility
 * Scrubs sensitive data (secrets, API keys, passwords, private hashes,
 * internal IPs, admin data, webhook URLs, JWTs) from log output before
 * entries are written to any transport or external storage.
 */

// ---------------------------------------------------------------------------
// Pattern groups
// ---------------------------------------------------------------------------

/** Patterns that redact secret values embedded in strings. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  // Env-var-style assignments: KEY=value or KEY: value (captures the value)
  /\b(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|PRIVATE|API_KEY|APIKEY|AUTH|PK)\s*[:=]\s*['"]?([^\s'"&,}\]]{6,})['"]?/gi,

  // Stellar secret keys (S + 55 base32 chars, total 56)
  /\bS[A-Z2-7]{55}\b/g,

  // Ethereum / generic 64-char hex private keys (with or without 0x prefix)
  /\b(0x)?[a-fA-F0-9]{64}\b/g,

  // JWT tokens: three base64url segments separated by dots
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,

  // Bearer tokens
  /Bearer\s+[A-Za-z0-9._\-+/=]{10,}/gi,

  // Database / Redis / AMQP connection strings  — mask the password segment
  /(:\/\/[^:@\s]+:)([^@\s]{1,})(@)/g,

  // AWS-style access keys
  /\bAKIA[0-9A-Z]{16}\b/g,

  // Discord & Slack webhook URLs
  /https:\/\/(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/services)\/[^\s"'<>]+/gi,

  // Generic API-key-looking strings after key/token assignments in JSON or query strings
  /(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|private[_-]?key)\s*[:=]\s*['"]?([A-Za-z0-9_\-+/=]{16,})['"]?/gi,
];

/**
 * Private/internal IP address patterns (RFC 1918, loopback, link-local).
 * These are redacted from log strings to prevent leaking internal topology.
 */
const PRIVATE_IP_PATTERNS: RegExp[] = [
  // Loopback: 127.x.x.x
  /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  // RFC 1918: 10.x.x.x
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  // RFC 1918: 172.16.x.x – 172.31.x.x
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
  // RFC 1918: 192.168.x.x
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
  // Link-local: 169.254.x.x
  /\b169\.254\.\d{1,3}\.\d{1,3}\b/g,
  // IPv6 loopback
  /\b::1\b/g,
  // IPv6 Unique Local Addresses (fd00::/8)
  /\bfd[0-9a-fA-F]{2}:[0-9a-fA-F:]{2,}\b/gi,
];

// Object keys whose values should always be fully redacted regardless of value.
const SENSITIVE_KEY_RE =
  /secret|password|passwd|token|key|credential|private|api|auth|hash|seed|mnemonic|pin|ssn|card/i;

// Object keys that represent admin-specific data.
const ADMIN_KEY_RE = /admin|superuser|root|internal|cluster|node_?ip|server_?ip/i;

// ---------------------------------------------------------------------------
// Core masking helpers
// ---------------------------------------------------------------------------

/**
 * Masks sensitive values and internal IPs in a plain string.
 */
export function maskSensitiveData(input: string): string {
  if (!input || typeof input !== "string") return input;

  let masked = input;

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    // Reset lastIndex for global regexes so successive calls work correctly.
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, (match) => {
      if (/^https?:\/\//i.test(match)) return "[REDACTED_URL]";
      if (match.toLowerCase().startsWith("bearer")) return "Bearer [REDACTED]";
      // Preserve connection-string prefix and host, redact only the password.
      if (match.includes("://")) {
        return match.replace(/(:\/\/[^:@\s]+:)([^@\s]+)(@)/, "$1[REDACTED]$3");
      }
      return "[REDACTED]";
    });
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, "[INTERNAL_IP]");
  }

  return masked;
}

/**
 * Recursively masks sensitive data in an object.
 * - Keys matching SENSITIVE_KEY_RE or ADMIN_KEY_RE are fully redacted.
 * - String values are run through maskSensitiveData.
 * - Arrays of strings are individually masked.
 * - Nested objects are processed recursively.
 */
export function maskSensitiveObject(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;

  const masked: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(key) || ADMIN_KEY_RE.test(key)) {
      masked[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      masked[key] = maskSensitiveData(value);
    } else if (Array.isArray(value)) {
      masked[key] = value.map((item) =>
        typeof item === "string"
          ? maskSensitiveData(item)
          : typeof item === "object" && item !== null
            ? maskSensitiveObject(item as Record<string, unknown>)
            : item,
      );
    } else if (typeof value === "object" && value !== null) {
      masked[key] = maskSensitiveObject(value as Record<string, unknown>);
    } else {
      masked[key] = value;
    }
  }

  return masked;
}

// ---------------------------------------------------------------------------
// Winston-level scrubbing
// ---------------------------------------------------------------------------

/**
 * Scrubs a Winston log info object in-place, returning a sanitised copy.
 *
 * The `level` and `timestamp` fields are preserved verbatim.
 * Symbol-keyed properties (Winston internals such as Symbol(level) and
 * Symbol(splat)) are copied across without modification.
 */
export function scrubLogInfo(info: unknown): unknown {
  if (!info || typeof info !== "object") return info;

  const src = info as Record<string | symbol, unknown>;
  const result: Record<string | symbol, unknown> = Object.create(
    Object.getPrototypeOf(src),
  );

  // Own string-keyed properties
  for (const key of Object.getOwnPropertyNames(src)) {
    const value = src[key];

    // Never alter level or timestamp — they are not sensitive.
    if (key === "level" || key === "timestamp") {
      result[key] = value;
      continue;
    }

    if (key === "message" && typeof value === "string") {
      result[key] = maskSensitiveData(value);
    } else if (typeof value === "string") {
      result[key] = maskSensitiveData(value);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = maskSensitiveObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = (value as unknown[]).map((item) =>
        typeof item === "string"
          ? maskSensitiveData(item)
          : typeof item === "object" && item !== null
            ? maskSensitiveObject(item as Record<string, unknown>)
            : item,
      );
    } else {
      result[key] = value;
    }
  }

  // Copy Winston's Symbol-keyed internals (Symbol(level), Symbol(splat), …)
  // without modification — they contain internal state, not user data.
  for (const sym of Object.getOwnPropertySymbols(src)) {
    result[sym] = src[sym];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Global console interception
// ---------------------------------------------------------------------------

/**
 * Masked console wrapper — individual methods apply scrubbing before output.
 */
export const maskedConsole = {
  log: (...args: unknown[]): void =>
    console.log(...args.map((a) => (typeof a === "string" ? maskSensitiveData(a) : a))),
  error: (...args: unknown[]): void =>
    console.error(...args.map((a) => (typeof a === "string" ? maskSensitiveData(a) : a))),
  warn: (...args: unknown[]): void =>
    console.warn(...args.map((a) => (typeof a === "string" ? maskSensitiveData(a) : a))),
  info: (...args: unknown[]): void =>
    console.info(...args.map((a) => (typeof a === "string" ? maskSensitiveData(a) : a))),
  debug: (...args: unknown[]): void =>
    console.debug(...args.map((a) => (typeof a === "string" ? maskSensitiveData(a) : a))),
};

/**
 * Monkey-patches all `console.*` methods so every string argument is scrubbed.
 * Call once at application startup (already wired in index.ts).
 */
export function enableGlobalLogMasking(): void {
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };

  const wrap =
    (fn: (...a: unknown[]) => void) =>
    (...args: unknown[]): void =>
      fn(...args.map((a) => (typeof a === "string" ? maskSensitiveData(a) : a)));

  console.log = wrap(originals.log);
  console.error = wrap(originals.error);
  console.warn = wrap(originals.warn);
  console.info = wrap(originals.info);
  console.debug = wrap(originals.debug);
}
