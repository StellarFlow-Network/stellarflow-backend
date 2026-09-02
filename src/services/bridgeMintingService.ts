import {
  TransactionBuilder,
  Operation,
  Contract,
  nativeToScVal,
  xdr,
  rpc as SorobanRpc,
  Account,
} from "@stellar/stellar-sdk";
import prisma from "../lib/prisma";
import stellarProvider from "../lib/stellarProvider";
import { getStellarNetworkPassphrase } from "../lib/stellarNetwork";
import { sequenceManager } from "./sequence-manager";
import { signer } from "../signer";
import { Keypair } from "@stellar/stellar-sdk";
import { logger } from "../utils/logger";

export interface StagedTransaction {
  contractId: string;
  amount: string;
  recipient: string;
  transactionXdr: string;
  hash: string;
}

export interface MintingParams {
  bridgeEventId: number;
  sorobanContract: string;
  mintAmount: string;
  recipientAddress: string;
}

/**
 * Stages Soroban minting transactions for verified bridge events
 * Creates unsigned transactions that can be signed and submitted later
 */
export async function stageSorobanMintTransaction(
  bridgeEvent: any,
): Promise<StagedTransaction | null> {
  try {
    // Get the Soroban contract ID from environment or bridge event
    const sorobanContractId =
      process.env.SOROBAN_BRIDGE_CONTRACT_ID || bridgeEvent.destinationChainId;

    if (!sorobanContractId) {
      logger.error("[BridgeMintingService] No Soroban bridge contract configured");
      return null;
    }

    // Parse the mint amount from the bridge event
    const mintAmount = bridgeEvent.tokenAmount;
    const recipientAddress = bridgeEvent.destinationAddress || bridgeEvent.fromAddress;

    // Get the Stellar account for signing
    const publicKey = await signer.getPublicKey();
    const sequence = await sequenceManager.getNextSequence(publicKey);
    const account = new Account(publicKey, sequence);

    // Build the Soroban transaction
    const networkPassphrase = getStellarNetworkPassphrase();
    const server = stellarProvider.getServer();

    const transaction = new TransactionBuilder(account, {
      fee: await server.fetchBaseFee(),
      networkPassphrase,
    })
      .addOperation(
        new Contract(sorobanContractId).call(
          "mint",
          nativeToScVal(recipientAddress, { type: "address" }),
          nativeToScVal(BigInt(mintAmount), { type: "i128" }),
          nativeToScVal(bridgeEvent.transactionHash, { type: "string" }),
          nativeToScVal(bridgeEvent.chainId.toString(), { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    // Simulate the transaction to get auth requirements
    const rpcServer = stellarProvider.getRpcServer();
    const simulation = await rpcServer.simulateTransaction(transaction);

    // Assemble the transaction with simulation results
    const assembledTransaction = SorobanRpc.assembleTransaction(transaction, simulation).build();

    const txHash = assembledTransaction.hash().toString("hex");

    logger.info(
      `[BridgeMintingService] Staged mint transaction for event ${bridgeEvent.id}: ${txHash}`,
    );

    return {
      contractId: sorobanContractId,
      amount: mintAmount,
      recipient: recipientAddress,
      transactionXdr: assembledTransaction.toXDR(),
      hash: txHash,
    };
  } catch (error) {
    logger.error(`[BridgeMintingService] Failed to stage transaction for event ${bridgeEvent.id}:`, error);
    return null;
  }
}

/**
 * Signs and submits a staged Soroban minting transaction
 */
export async function submitStagedMintTransaction(
  bridgeOperationId: string,
): Promise<string | null> {
  try {
    // Get the bridge operation
    const bridgeOperation = await prisma.bridgeOperation.findUnique({
      where: { id: bridgeOperationId },
      include: { bridgeEvent: true },
    });

    if (!bridgeOperation) {
      logger.error(`[BridgeMintingService] Bridge operation ${bridgeOperationId} not found`);
      return null;
    }

    // Update status to processing
    await prisma.bridgeOperation.update({
      where: { id: bridgeOperationId },
      data: {
        queueStatus: "PROCESSING",
        processingStartedAt: new Date(),
      },
    });

    // Get the Stellar account
    const publicKey = await signer.getPublicKey();
    const sequence = await sequenceManager.getNextSequence(publicKey);
    const account = new Account(publicKey, sequence);

    // Rebuild the transaction (in production, you'd store the XDR and rebuild from it)
    const sorobanContractId = bridgeOperation.sorobanContract;
    const networkPassphrase = getStellarNetworkPassphrase();
    const server = stellarProvider.getServer();

    const transaction = new TransactionBuilder(account, {
      fee: await server.fetchBaseFee(),
      networkPassphrase,
    })
      .addOperation(
        new Contract(sorobanContractId).call(
          "mint",
          nativeToScVal(bridgeOperation.recipientAddress, { type: "address" }),
          nativeToScVal(BigInt(bridgeOperation.mintAmount.toString()), { type: "i128" }),
          nativeToScVal(bridgeOperation.bridgeEvent.transactionHash, { type: "string" }),
          nativeToScVal(bridgeOperation.bridgeEvent.chainId.toString(), { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    // Simulate and assemble
    const rpcServer = stellarProvider.getRpcServer();
    const simulation = await rpcServer.simulateTransaction(transaction);
    const assembledTransaction = SorobanRpc.assembleTransaction(transaction, simulation).build();

    // Sign the transaction
    const signature = await signer.sign(assembledTransaction.hash());
    const keypair = Keypair.fromPublicKey(publicKey);

    assembledTransaction.signatures.push(
      new xdr.DecoratedSignature({
        hint: keypair.signatureHint(),
        signature,
      }),
    );

    // Submit to Stellar
    const submitted = await rpcServer.sendTransaction(assembledTransaction);

    // Wait for confirmation
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await rpcServer.getTransaction(submitted.hash);

      if (result.status === "SUCCESS") {
        // Update bridge operation as completed
        await prisma.bridgeOperation.update({
          where: { id: bridgeOperationId },
          data: {
            queueStatus: "COMPLETED",
            stellarTxHash: submitted.hash,
            completedAt: new Date(),
          },
        });

        // Update bridge event as completed
        await prisma.bridgeEvent.update({
          where: { id: bridgeOperation.bridgeEventId },
          data: {
            status: "COMPLETED",
            processedAt: new Date(),
          },
        });

        logger.info(
          `[BridgeMintingService] Successfully submitted mint transaction: ${submitted.hash}`,
        );

        return submitted.hash;
      }

      if (result.status === "FAILED") {
        throw new Error(`Transaction failed: ${result.resultXdr}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error("Transaction confirmation timeout");
  } catch (error) {
    logger.error(`[BridgeMintingService] Failed to submit transaction for operation ${bridgeOperationId}:`, error);

    // Update operation as failed
    await prisma.bridgeOperation.update({
      where: { id: bridgeOperationId },
      data: {
        queueStatus: "FAILED",
        retryCount: { increment: 1 },
      },
    });

    return null;
  }
}

/**
 * Simulates a minting transaction without submitting it
 * Useful for pre-flight checks and fee estimation
 */
export async function simulateMintTransaction(params: MintingParams): Promise<{
  success: boolean;
  fee?: string;
  error?: string;
  authRequired?: string[];
}> {
  try {
    const publicKey = await signer.getPublicKey();
    const sequence = await sequenceManager.getNextSequence(publicKey);
    const account = new Account(publicKey, sequence);

    const networkPassphrase = getStellarNetworkPassphrase();
    const server = stellarProvider.getServer();

    const transaction = new TransactionBuilder(account, {
      fee: await server.fetchBaseFee(),
      networkPassphrase,
    })
      .addOperation(
        new Contract(params.sorobanContract).call(
          "mint",
          nativeToScVal(params.recipientAddress, { type: "address" }),
          nativeToScVal(BigInt(params.mintAmount), { type: "i128" }),
          nativeToScVal("0x0000000000000000000000000000000000000000000000000000000000000000", { type: "string" }),
          nativeToScVal("0", { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const rpcServer = stellarProvider.getRpcServer();
    const simulation = await rpcServer.simulateTransaction(transaction);

    if (simulation.result.status === "SUCCESS") {
      return {
        success: true,
        fee: simulation.transactionData?.resourceFee?.toString(),
        authRequired: simulation.transactionData?.auth?.map((auth: any) => auth.publicKey),
      };
    } else {
      return {
        success: false,
        error: simulation.result?.XDR || "Simulation failed",
      };
    }
  } catch (error) {
    logger.error("[BridgeMintingService] Simulation failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
