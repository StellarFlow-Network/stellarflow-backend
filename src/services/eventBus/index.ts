/**
 * src/services/eventBus/index.ts
 *
 * Barrel export for the internal event bus metrics and queue backpressure
 * alert bot (Issue #1055).
 */

export * from "./types";
export * from "./config";
export * from "./queueDepthCollector";
export * from "./queueBackpressureBot";
export * from "./workerAutoscaler";
export * from "./scaleProviders";
export * from "./alertDispatcher";
export * from "./readers";
export * from "./eventBusService";
