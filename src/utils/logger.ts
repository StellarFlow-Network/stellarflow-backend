import winstonLogger from './winstonLogger';

// Export the Winston logger as the default logger
export const logger = winstonLogger;

// For compatibility, export a createFetcherLogger that returns the same logger
export function createFetcherLogger(fetcherName: string) {
  // Optionally, you can add child loggers or labels here
  return winstonLogger;
}
