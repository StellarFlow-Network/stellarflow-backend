import winstonLogger from "./winstonLogger";
export { generateSortableLogId } from "./idGenerator";

// Export the Winston logger as the default logger
export const logger = winstonLogger;

// For compatibility, export a createFetcherLogger that returns the same logger
export function createFetcherLogger(_fetcherName: string) {
  // Optionally, you can add child loggers or labels here
  return winstonLogger;
}
