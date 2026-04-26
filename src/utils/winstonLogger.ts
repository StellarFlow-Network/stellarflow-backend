/**
 * Winston logger with two-layer PII/secret redaction.
 *
 * Layer 1 — redactFormat (format pipeline):
 *   Applied globally before any transport sees a log entry.
 *   Catches secrets, private IPs, JWTs, webhook URLs, and admin data
 *   by running scrubLogInfo() inside a custom Winston format.
 *
 * Layer 2 — RedactingTransport (transport layer):
 *   Wraps the DailyRotateFile transport that writes to external storage.
 *   Applies scrubLogInfo() a second time as a defense-in-depth measure,
 *   ensuring that even data added after format processing is sanitised
 *   before it reaches disk or any remote log aggregator.
 *
 * The Console transport is covered by Layer 1 (global format) and by the
 * enableGlobalLogMasking() call in index.ts which patches console.* methods.
 */

import { createLogger, format, transports } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import { scrubLogInfo } from "./logMasker";
import { RedactingTransport } from "./redactingTransport";

const logDir = path.resolve(__dirname, "../../logs");

// ---------------------------------------------------------------------------
// Layer 1: redactFormat
// A custom Winston format that sanitises every log info object before it
// reaches any transport. This is the first line of defence.
// ---------------------------------------------------------------------------
const redactFormat = format((info) => scrubLogInfo(info) as ReturnType<typeof scrubLogInfo>)();

// ---------------------------------------------------------------------------
// Inner file transport (not exposed directly — wrapped by RedactingTransport)
// ---------------------------------------------------------------------------
const dailyRotateFileTransport = new DailyRotateFile({
  filename: path.join(logDir, "application-%DATE%.log"),
  datePattern: "YYYY-MM-DD",
  maxSize: "100m",
  maxFiles: "10",
  zippedArchive: true,
  handleExceptions: true,
  handleRejections: true,
  // Per-transport format: timestamp + JSON. Redaction is handled by the
  // wrapping RedactingTransport, so we only need structural formatting here.
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.json(),
  ),
});

// ---------------------------------------------------------------------------
// Layer 2: RedactingTransport
// Wraps the file transport so every entry is scrubbed a second time before
// it is written to the log file (external storage).
// ---------------------------------------------------------------------------
const safeFileTransport = new RedactingTransport({
  inner: dailyRotateFileTransport,
  label: "FileTransport",
  // Inherit the same exception/rejection handling flags so unhandled errors
  // and promise rejections are still captured.
  handleExceptions: true,
  handleRejections: true,
});

// ---------------------------------------------------------------------------
// Console transport (format-level redaction via redactFormat is sufficient;
// enableGlobalLogMasking() in index.ts provides an additional fallback)
// ---------------------------------------------------------------------------
const consoleTransport = new transports.Console({
  format: format.combine(format.colorize(), format.simple()),
  handleExceptions: true,
  handleRejections: true,
});

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: format.combine(
    // Layer 1: scrub before any transport sees the entry.
    redactFormat,
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.splat(),
    format.json(),
  ),
  transports: [
    // External storage: file transport wrapped in the redacting layer.
    safeFileTransport,
    // Console: covered by global format + console monkey-patch.
    consoleTransport,
  ],
  exitOnError: false,
});

// Convenience method kept for backwards compatibility with existing callers.
(logger as typeof logger & { fetcherError: (msg: string, meta?: unknown) => void }).fetcherError =
  (message: string, meta?: unknown) => {
    logger.error(`[FETCHER_ERROR] ${message}`, meta as object | undefined);
  };

export default logger;
