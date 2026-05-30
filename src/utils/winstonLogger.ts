import { createLogger, format, transports } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";

const logDir = path.resolve(__dirname, "../../logs");

// Nanosecond-precision timestamp generator
const getHrTimeNanoSeconds = (): { ns: bigint; formattedTime: string } => {
  const hrtime = process.hrtime.bigint();
  const now = new Date();
  const iso = now.toISOString();
  const formattedTime = iso.replace("Z", "").split(".")[0] ?? "";
  return {
    ns: hrtime,
    formattedTime: formattedTime as string,
  };
};

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({
      format: () => {
        const { formattedTime } = getHrTimeNanoSeconds();
        return formattedTime;
      },
    }),
    format.errors({ stack: true }),
    format.splat(),
    // Add nanosecond precision to metadata
    format.printf((info) => {
      const { ns } = getHrTimeNanoSeconds();
      const { timestamp, level: msgLevel, message, ...rest } = info;

      return JSON.stringify({
        timestamp,
        level: msgLevel,
        message,
        timestampNs: ns.toString(),
        ...rest,
      });
    }),
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logDir, "application-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "10",
      zippedArchive: true,
      handleExceptions: true,
      handleRejections: true,
    }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf((info) => {
          const { ns } = getHrTimeNanoSeconds();
          return `${info.timestamp} [${info.level}] [ns:${ns.toString()}] ${info.message}`;
        }),
      ),
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
  exitOnError: false,
  defaultMeta: {
    service: "stellarflow-api",
  },
});

export default logger;
