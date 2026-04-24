import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const logDir = path.resolve(__dirname, '../../logs');

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logDir, 'application-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '100m',
      maxFiles: '10',
      zippedArchive: true,
      handleExceptions: true,
      handleRejections: true,
    }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      ),
      handleExceptions: true,
      handleRejections: true,
    })
  ],
  exitOnError: false,
});

export default logger;
