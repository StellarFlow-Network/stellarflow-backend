# Logging with Winston and Log Rotation

This project now uses [Winston](https://github.com/winstonjs/winston) for logging, with daily log rotation and a circular buffer to prevent disk overuse.

## Features
- Logs are written to the `logs/` directory.
- Log files are rotated daily or when they reach 100MB.
- Only the last 10 log files are kept (approx. 1GB total).
- Old logs are compressed automatically.
- Console logging is preserved for development and debugging.

## Configuration
- Log files: `logs/application-YYYY-MM-DD.log`
- Rotation: Daily and/or when file size exceeds 100MB
- Retention: Last 10 files (zipped)

## How it works
- Winston's `DailyRotateFile` transport handles file creation, rotation, and compression.
- The logger is configured in `src/utils/winstonLogger.ts`.
- All logger usage (`logger.info`, `logger.error`, etc.) is routed through Winston.

## Customization
- To change log retention or size, edit the `maxSize` and `maxFiles` options in `src/utils/winstonLogger.ts`.
- To add more transports (e.g., remote logging), extend the Winston configuration.

## Migration Notes
- The old custom logger is replaced by Winston. All previous logger imports remain compatible.
- No breaking changes for existing logger usage.

## Example Usage
```js
import { logger } from './utils/logger';
logger.info('This is an info message');
logger.error('This is an error message');
```

## Troubleshooting
- If the `logs/` directory does not exist, it will be created automatically.
- Check file permissions if logs are not written.




feat(logging): integrate Winston logger with daily rotation and circular buffer


Integrate Winston Logger with Daily Rotation and Circular Buffer (1GB Limit)

This PR replaces the custom logger with Winston, adding robust file-based logging and log rotation to prevent disk overuse.

- Adds Winston and winston-daily-rotate-file as dependencies.
- Logs are written to the logs/ directory.
- Log files are rotated daily or when they reach 100MB.
- Only the last 10 log files are kept (approx. 1GB total), with old logs compressed.
- All logger usage is routed through Winston; existing logger imports remain compatible.
- See LOGGING_WITH_WINSTON.md for details and usage instructions.

No breaking changes for existing logger usage.