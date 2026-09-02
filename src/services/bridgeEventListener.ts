import { ethers } from "ethers";
import prisma from "../lib/prisma";
import { logger } from "../utils/logger";
import { BackpressureManager, PacketPriority } from "../queue/backpressure";
import { verifyBridgeEventSignatures } from "./bridgeSignatureVerification";
import { stageSorobanMintTransaction } from "./bridgeMintingService";
import { enqueueBridgeOperation } from "./bridgeQueueService";

export interface BridgeEventData {
  chainId: number;
  chainType: string;
  eventType: string;
  transactionHash: string;
  blockNumber?: bigint;
  logIndex?: number;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenAmount: bigint;
  fromAddress: string;
  toAddress?: string;
  destinationChainId?: string;
  destinationAddress?: string;
  eventTimestamp: Date;
}

export interface ChainConfig {
  chainId: string;
  chainName: string;
  chainType: string;
  rpcUrl?: string;
  bridgeContract?: string;
  isActive: boolean;
}

export class BridgeEventListener {
  private bpManager = new BackpressureManager();
  private isRunning: boolean = false;
  private pollIntervalMs: number;
  private providers: Map<string, ethers.JsonRpcProvider> = new Map();
  private pollTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastProcessedBlocks: Map<string, number> = new Map();

  constructor(pollIntervalMs: number = 15000) {
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("[BridgeEventListener] Service is already running");
      return;
    }

    this.isRunning = true;
    logger.info("[BridgeEventListener] Starting cross-chain bridge event listener");

    // Load active chains from database
    const chains = await prisma.bridgeChain.findMany({
      where: { isActive: true },
      include: { bridgeValidators: true },
    });

    if (chains.length === 0) {
      logger.warn("[BridgeEventListener] No active bridge chains configured");
      return;
    }

    // Initialize providers for EVM chains
    for (const chain of chains) {
      if (chain.chainType === "EVM" && chain.rpcUrl) {
        try {
          const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
          this.providers.set(chain.chainId, provider);

          // Get last processed block for this chain
          const lastEvent = await prisma.bridgeEvent.findFirst({
            where: { chainId: chain.id },
            orderBy: { blockNumber: "desc" },
          });

          const lastBlock = lastEvent?.blockNumber
            ? Number(lastEvent.blockNumber)
            : await provider.getBlockNumber() - 1000;

          this.lastProcessedBlocks.set(chain.chainId, lastBlock);
          logger.info(
            `[BridgeEventListener] Initialized ${chain.chainName} (chainId: ${chain.chainId}) from block ${lastBlock}`,
          );
        } catch (error) {
          logger.error(
            `[BridgeEventListener] Failed to initialize provider for ${chain.chainName}:`,
            error,
          );
        }
      }
    }

    // Start polling for each chain
    for (const chain of chains) {
      if (chain.chainType === "EVM" && chain.rpcUrl && chain.bridgeContract) {
        this.startChainPolling(chain);
      }
    }

    // Start the background worker to process the backpressure queue
    this.startWorker();

    logger.info(
      `[BridgeEventListener] Started listening to ${chains.length} bridge chains`,
    );
  }

  private startChainPolling(chain: ChainConfig & { bridgeValidators: any[] }): void {
    const timer = setInterval(() => {
      this.pollChainEvents(chain).catch((err) => {
        logger.error(`[BridgeEventListener] Poll error for ${chain.chainName}:`, {
          err,
        });
      });
    }, this.pollIntervalMs);

    this.pollTimers.set(chain.chainId, timer);
  }

  private async pollChainEvents(chain: ChainConfig & { bridgeValidators: any[] }): Promise<void> {
    try {
      const provider = this.providers.get(chain.chainId);
      if (!provider) {
        logger.error(`[BridgeEventListener] No provider found for ${chain.chainName}`);
        return;
      }

      const currentBlock = await provider.getBlockNumber();
      const lastProcessed = this.lastProcessedBlocks.get(chain.chainId) || currentBlock - 1000;

      // Process blocks in batches to avoid overwhelming the RPC
      const batchSize = 100;
      const fromBlock = lastProcessed + 1;
      const toBlock = Math.min(fromBlock + batchSize - 1, currentBlock);

      if (fromBlock > toBlock) {
        return; // No new blocks to process
      }

      logger.info(
        `[BridgeEventListener] Polling ${chain.chainName} blocks ${fromBlock} to ${toBlock}`,
      );

      // Get logs for the bridge contract
      const contract = new ethers.Contract(
        chain.bridgeContract!,
        [
          "event TokensLocked(address indexed from, address indexed to, uint256 amount, uint256 destinationChainId, bytes32 nonce)",
          "event TokensReleased(address indexed to, uint256 amount, uint256 sourceChainId, bytes32 nonce)",
          "event TokensBurned(address indexed from, uint256 amount, uint256 destinationChainId, bytes32 nonce)",
        ],
        provider,
      );

      const filter = contract.filters;
      const logs = await provider.getLogs({
        address: chain.bridgeContract,
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        try {
          const eventData = await this.parseLog(log, chain);
          if (eventData) {
            // Wrap event in a packet and send to queue
            const packet = {
              priority: PacketPriority.STANDARD,
              data: eventData,
              timestamp: Date.now(),
            };

            const accepted = await this.bpManager.enqueue(packet);
            if (accepted) {
              const blockNumber = Number(log.blockNumber);
              if (blockNumber > (this.lastProcessedBlocks.get(chain.chainId) || 0)) {
                this.lastProcessedBlocks.set(chain.chainId, blockNumber);
              }
            }
          }
        } catch (error) {
          logger.error(`[BridgeEventListener] Failed to parse log ${log.logIndex}:`, error);
        }
      }
    } catch (error) {
      logger.error(`[BridgeEventListener] Poll failed for ${chain.chainName}:`, error);
    }
  }

  private async parseLog(log: any, chain: ChainConfig): Promise<BridgeEventData | null> {
    try {
      const block = await this.providers.get(chain.chainId)?.getBlock(log.blockNumber);
      if (!block) return null;

      // Decode the log based on the event signature
      const eventSignature = log.topics[0];
      let eventType: string;
      let decoded: any;

      // Event signatures (simplified for example)
      const TOKENS_LOCKED = ethers.id("TokensLocked(address,address,uint256,uint256,bytes32)");
      const TOKENS_RELEASED = ethers.id("TokensReleased(address,uint256,uint256,bytes32)");
      const TOKENS_BURNED = ethers.id("TokensBurned(address,uint256,uint256,bytes32)");

      if (eventSignature === TOKENS_LOCKED) {
        eventType = "TOKEN_LOCK";
        decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "address", "uint256", "uint256", "bytes32"],
          log.data,
        );
      } else if (eventSignature === TOKENS_RELEASED) {
        eventType = "TOKEN_RELEASE";
        decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint256", "uint256", "bytes32"],
          log.data,
        );
      } else if (eventSignature === TOKENS_BURNED) {
        eventType = "TOKEN_BURN";
        decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint256", "uint256", "bytes32"],
          log.data,
        );
      } else {
        return null; // Unknown event type
      }

      return {
        chainId: chain.id,
        chainType: chain.chainType,
        eventType,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        tokenAmount: decoded[2] || decoded[1], // Amount is at different indices for different events
        fromAddress: decoded[0] || log.topics[1],
        toAddress: decoded[1] || log.topics[2],
        destinationChainId: decoded[3]?.toString(),
        destinationAddress: decoded[1] || log.topics[2],
        eventTimestamp: new Date(block.timestamp * 1000),
      };
    } catch (error) {
      logger.error("[BridgeEventListener] Failed to parse log:", error);
      return null;
    }
  }

  private async startWorker(): Promise<void> {
    logger.info("[BridgeEventListener] Backpressure consumer loop started.");
    while (this.isRunning) {
      const packet = await this.bpManager.dequeue();

      if (packet) {
        try {
          const eventData = packet.data as BridgeEventData;

          // Insert bridge event record
          const bridgeEvent = await prisma.bridgeEvent.create({
            data: {
              chainId: eventData.chainId,
              eventType: eventData.eventType,
              transactionHash: eventData.transactionHash,
              blockNumber: eventData.blockNumber,
              logIndex: eventData.logIndex,
              tokenAmount: eventData.tokenAmount.toString(),
              fromAddress: eventData.fromAddress,
              toAddress: eventData.toAddress,
              destinationChainId: eventData.destinationChainId,
              destinationAddress: eventData.destinationAddress,
              eventTimestamp: eventData.eventTimestamp,
              status: "PENDING",
            },
          });

          logger.info(
            `[BridgeEventListener] Recorded bridge event ${bridgeEvent.id} (${eventData.eventType})`,
          );

          // Verify validator signatures
          const isVerified = await verifyBridgeEventSignatures(bridgeEvent.id);

          if (isVerified) {
            // Stage Soroban mint transaction
            const stagedTx = await stageSorobanMintTransaction(bridgeEvent);

            if (stagedTx) {
              // Enqueue for processing
              await enqueueBridgeOperation({
                bridgeEventId: bridgeEvent.id,
                sorobanContract: stagedTx.contractId,
                mintAmount: stagedTx.amount,
                recipientAddress: stagedTx.recipient,
                priority: 5,
              });

              await prisma.bridgeEvent.update({
                where: { id: bridgeEvent.id },
                data: { status: "STAGED" },
              });
            }
          }
        } catch (err) {
          logger.error("[BridgeEventListener] Failed to process queued event:", err);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  stop(): void {
    this.isRunning = false;

    // Clear all polling timers
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    // Clear providers
    this.providers.clear();

    logger.info("[BridgeEventListener] Stopped");
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

let bridgeEventListenerInstance: BridgeEventListener | null = null;

export function getBridgeEventListener(): BridgeEventListener {
  if (!bridgeEventListenerInstance) {
    bridgeEventListenerInstance = new BridgeEventListener();
  }
  return bridgeEventListenerInstance;
}
