import { getBridgeEventListener } from "./bridgeEventListener";
import { getBridgeQueueService } from "./bridgeQueueService";
import { logger } from "../utils/logger";
import dotenv from "dotenv";

dotenv.config();

/**
 * Initializes and starts the cross-chain bridge services
 * This should be called during application startup
 */
export async function initializeBridgeServices(): Promise<void> {
  const bridgeEnabled = process.env.BRIDGE_EVENT_LISTENER_ENABLED === "true";

  if (!bridgeEnabled) {
    logger.info("[BridgeIntegration] Cross-chain bridge services are disabled");
    return;
  }

  try {
    logger.info("[BridgeIntegration] Initializing cross-chain bridge services");

    // Start the bridge event listener
    const eventListener = getBridgeEventListener();
    const pollInterval = parseInt(process.env.BRIDGE_EVENT_POLL_INTERVAL_MS || "15000", 10);
    await eventListener.start();

    // Start the bridge queue processor
    const queueService = getBridgeQueueService();
    const queueInterval = parseInt(process.env.BRIDGE_QUEUE_PROCESS_INTERVAL_MS || "5000", 10);
    await queueService.start();

    logger.info("[BridgeIntegration] Cross-chain bridge services started successfully");
  } catch (error) {
    logger.error("[BridgeIntegration] Failed to initialize bridge services:", error);
    throw error;
  }
}

/**
 * Stops the cross-chain bridge services
 * This should be called during application shutdown
 */
export async function stopBridgeServices(): Promise<void> {
  try {
    logger.info("[BridgeIntegration] Stopping cross-chain bridge services");

    const eventListener = getBridgeEventListener();
    eventListener.stop();

    const queueService = getBridgeQueueService();
    queueService.stop();

    logger.info("[BridgeIntegration] Cross-chain bridge services stopped");
  } catch (error) {
    logger.error("[BridgeIntegration] Failed to stop bridge services:", error);
  }
}
