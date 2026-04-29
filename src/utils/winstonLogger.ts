import { createLogger, format, transports } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import { fileURLToPath } from "url";
import { generateSortableLogId } from "./idGenerator";
import { requestContext } from "../lib/requestContext";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.resolve(__dirname, "../../logs");

const requestContextFormat = format((info) => {
  const store = requestContext.getStore();
  if (store?.requestId) {
    info.requestId = store.requestId;
  }
  if (!info.logId) {
    info.logId = generateSortableLogId();
  }
  return info;
});

const baseFormat = format.combine(
  requestContextFormat(),
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  format.errors({ stack: true }),
  format.splat(),
);

const consoleFormat = format.combine(
  requestContextFormat(),
  format.colorize(),
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  format.printf((info) => {
    const meta = { ...info } as Record<string, unknown>;
    delete meta.level;
    delete meta.message;
    delete meta.timestamp;
    delete meta.logId;
    delete meta.requestId;
    delete meta[Symbol.for("level") as any];

    const metaString = Object.keys(meta).length
      ? ` ${JSON.stringify(meta)}`
      : "";
    const stackString = info.stack ? `\n${info.stack}` : "";
    const requestIdPrefix = info.requestId ? `[req:${info.requestId}] ` : "";

    return `${info.timestamp} ${requestIdPrefix}[${info.logId}] ${info.level}: ${info.message}${metaString}${stackString}`;
  }),
);

const logger = createLogger({
  level: "info",
  format: baseFormat,
  transports: [
    new DailyRotateFile({
      filename: path.join(logDir, "application-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "10",
      zippedArchive: true,
      handleExceptions: true,
      handleRejections: true,
      format: format.combine(baseFormat, format.json()),
    }),
    new transports.Console({
      format: consoleFormat,
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
  exitOnError: false,
});

// Add custom methods for fetcher-specific logging
(logger as any).fetcherError = (message: string, meta?: any) => {
  logger.error(`[FETCHER_ERROR] ${message}`, meta);
};

export default logger;
