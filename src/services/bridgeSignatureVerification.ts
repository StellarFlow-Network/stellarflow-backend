import { ethers, verifyMessage } from "ethers";
import prisma from "../lib/prisma";
import { logger } from "../utils/logger";

export interface SignatureVerificationResult {
  isValid: boolean;
  thresholdMet: boolean;
  totalWeight: number;
  requiredThreshold: number;
  signatures: Array<{
    validatorAddress: string;
    signature: string;
    weight: number;
  }>;
}

/**
 * Verifies validator signatures for bridge events
 * Checks that the required threshold of validator signatures is met
 */
export async function verifyBridgeEventSignatures(
  bridgeEventId: number,
): Promise<boolean> {
  try {
    // Fetch the bridge event with chain information
    const bridgeEvent = await prisma.bridgeEvent.findUnique({
      where: { id: bridgeEventId },
      include: {
        chain: {
          include: {
            bridgeValidators: {
              where: { isActive: true },
            },
          },
        },
      },
    });

    if (!bridgeEvent) {
      logger.error(`[BridgeSignatureVerification] Bridge event ${bridgeEventId} not found`);
      return false;
    }

    const validators = bridgeEvent.chain.bridgeValidators;
    if (validators.length === 0) {
      logger.warn(`[BridgeSignatureVerification] No active validators for chain ${bridgeEvent.chain.chainName}`);
      return false;
    }

    // Calculate required threshold (e.g., 2/3 of total weight)
    const totalWeight = validators.reduce((sum, v) => sum + v.weight, 0);
    const requiredThreshold = Math.ceil((totalWeight * 2) / 3);

    // Fetch existing signatures for this event
    const existingSignatures = await prisma.bridgeValidatorSignature.findMany({
      where: { bridgeEventId },
      include: { validator: true },
    });

    // Verify each signature
    let verifiedWeight = 0;
    const validSignatures: Array<{ validatorAddress: string; signature: string; weight: number }> = [];

    for (const sigRecord of existingSignatures) {
      const isValid = await verifyValidatorSignature(
        bridgeEvent,
        sigRecord.validator.validatorAddress,
        sigRecord.signature,
      );

      if (isValid) {
        verifiedWeight += sigRecord.validator.weight;
        validSignatures.push({
          validatorAddress: sigRecord.validator.validatorAddress,
          signature: sigRecord.signature,
          weight: sigRecord.validator.weight,
        });
      } else {
        logger.warn(
          `[BridgeSignatureVerification] Invalid signature from validator ${sigRecord.validator.validatorAddress}`,
        );
      }
    }

    const thresholdMet = verifiedWeight >= requiredThreshold;

    logger.info(
      `[BridgeSignatureVerification] Event ${bridgeEventId}: ${verifiedWeight}/${totalWeight} weight verified, threshold: ${requiredThreshold}, met: ${thresholdMet}`,
    );

    // Update bridge event status based on verification
    if (thresholdMet) {
      await prisma.bridgeEvent.update({
        where: { id: bridgeEventId },
        data: { status: "VERIFIED" },
      });
    }

    return thresholdMet;
  } catch (error) {
    logger.error(`[BridgeSignatureVerification] Failed to verify signatures for event ${bridgeEventId}:`, error);
    return false;
  }
}

/**
 * Verifies a single validator signature for a bridge event
 */
async function verifyValidatorSignature(
  bridgeEvent: any,
  validatorAddress: string,
  signature: string,
): Promise<boolean> {
  try {
    // Construct the message that was signed
    // Message format: "BridgeEvent:{eventType}:{txHash}:{fromAddress}:{amount}:{destinationChain}"
    const message = `BridgeEvent:${bridgeEvent.eventType}:${bridgeEvent.transactionHash}:${bridgeEvent.fromAddress}:${bridgeEvent.tokenAmount}:${bridgeEvent.destinationChainId || "stellar"}`;

    // For EVM chains, use ECDSA signature verification
    if (bridgeEvent.chain.chainType === "EVM") {
      const recoveredAddress = verifyMessage(message, signature);
      return recoveredAddress.toLowerCase() === validatorAddress.toLowerCase();
    }

    // For Stellar chains, use Ed25519 signature verification
    if (bridgeEvent.chain.chainType === "Stellar") {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const keypair = Keypair.fromPublicKey(validatorAddress);
      const messageBuffer = Buffer.from(message, "utf-8");
      const signatureBuffer = Buffer.from(signature, "hex");
      return keypair.verify(messageBuffer, signatureBuffer);
    }

    return false;
  } catch (error) {
    logger.error(`[BridgeSignatureVerification] Signature verification failed for ${validatorAddress}:`, error);
    return false;
  }
}

/**
 * Adds a validator signature to a bridge event
 */
export async function addValidatorSignature(
  bridgeEventId: number,
  validatorAddress: string,
  signature: string,
): Promise<SignatureVerificationResult> {
  try {
    // Check if validator exists and is active
    const validator = await prisma.bridgeValidator.findUnique({
      where: { validatorAddress },
      include: { chain: true },
    });

    if (!validator || !validator.isActive) {
      throw new Error(`Validator ${validatorAddress} not found or inactive`);
    }

    // Check if signature already exists
    const existingSig = await prisma.bridgeValidatorSignature.findUnique({
      where: {
        bridgeEventId_validatorId: {
          bridgeEventId,
          validatorId: validator.id,
        },
      },
    });

    if (existingSig) {
      throw new Error("Validator has already signed this event");
    }

    // Verify the signature before storing
    const bridgeEvent = await prisma.bridgeEvent.findUnique({
      where: { id: bridgeEventId },
      include: { chain: true },
    });

    if (!bridgeEvent) {
      throw new Error("Bridge event not found");
    }

    const isValid = await verifyValidatorSignature(bridgeEvent, validatorAddress, signature);
    if (!isValid) {
      throw new Error("Invalid signature");
    }

    // Store the signature
    await prisma.bridgeValidatorSignature.create({
      data: {
        bridgeEventId,
        validatorId: validator.id,
        signature,
      },
    });

    // Re-verify the event with updated signatures
    const thresholdMet = await verifyBridgeEventSignatures(bridgeEventId);

    // Get updated signature count
    const allSignatures = await prisma.bridgeValidatorSignature.findMany({
      where: { bridgeEventId },
      include: { validator: true },
    });

    const totalWeight = allSignatures.reduce((sum, sig) => sum + sig.validator.weight, 0);
    const validators = await prisma.bridgeValidator.findMany({
      where: { chainId: bridgeEvent.chainId, isActive: true },
    });
    const requiredThreshold = Math.ceil((validators.reduce((sum, v) => sum + v.weight, 0) * 2) / 3);

    return {
      isValid: true,
      thresholdMet,
      totalWeight,
      requiredThreshold,
      signatures: allSignatures.map((sig) => ({
        validatorAddress: sig.validator.validatorAddress,
        signature: sig.signature,
        weight: sig.validator.weight,
      })),
    };
  } catch (error) {
    logger.error(`[BridgeSignatureVerification] Failed to add signature:`, error);
    throw error;
  }
}
