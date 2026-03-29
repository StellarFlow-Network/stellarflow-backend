import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import winston from "winston";
const { combine, timestamp, errors, json, colorize, printf } = winston.format;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logsDirectory = path.resolve(__dirname, "../../logs");
if (!fs.existsSync(logsDirectory)) {
    fs.mkdirSync(logsDirectory, { recursive: true });
}
const consoleFormat = combine(colorize(), timestamp(), errors({ stack: true }), printf(({ timestamp: time, level, message, stack, ...meta }) => {
    const metadata = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    if (stack) {
        return `${time} ${level}: ${message}\n${stack}${metadata}`;
    }
    return `${time} ${level}: ${message}${metadata}`;
}));
const transports = [
    new winston.transports.File({
        filename: path.join(logsDirectory, "error.log"),
        level: "error",
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
    }),
    new winston.transports.File({
        filename: path.join(logsDirectory, "combined.log"),
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
    }),
    new winston.transports.Console({
        format: consoleFormat,
    }),
];
export const logger = winston.createLogger({
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    format: combine(timestamp(), errors({ stack: true }), json()),
    defaultMeta: { service: "stellarflow-backend" },
    transports,
    exitOnError: false,
});
export const morganStream = {
    write: (message) => {
        logger.http(message.trim());
    },
};
//# sourceMappingURL=logger.js.map