import prisma from "../lib/prisma";
import { Keypair } from "@stellar/stellar-sdk";
import * as crypto from "crypto";
import { Request } from "express";

export interface AdminSignature {
  adminPublicKey: string;
  adminName: string;
  adminRole: string;
  signature: string;
  ipAddress: string;
  userAgent?: string | undefined;
}

export interface ConsensusRequest {
  actionType: string;
  actionData?: string;
  requestedBy: string;
  requiredSignatures?: number;
  expiresAt?: Date;
}

export interface ValidationResult {
  valid: boolean;
  canExecute: boolean;
  message: string;
  pendingSignatures?: AdminSignature[];
  missingSignatures?: number;
}

export class SignatureValidationService {
  private readonly CONSENSUS_EXPIRY_HOURS = 24;
  private readonly MIN_REQUIRED_SIGNATURES = 2;
  private readonly MAX_REQUIRED_SIGNATURES = 5;

  /**
   * Create a new pending consensus request
   */
  async createConsensusRequest(
    request: ConsensusRequest,
    req: Request
  ): Promise<{ id: number; status: string }> {
    const requiredSignatures = Math.min(
      Math.max(request.requiredSignatures || this.MIN_REQUIRED_SIGNATURES, this.MIN_REQUIRED_SIGNATURES),
      this.MAX_REQUIRED_SIGNATURES
    );

    const expiresAt = request.expiresAt || new Date(Date.now() + this.CONSENSUS_EXPIRY_HOURS * 60 * 60 * 1000);

    const pendingConsensus = await prisma.pendingConsensus.create({
      data: {
        actionType: request.actionType,
        actionData: request.actionData,
        status: "PENDING",
        requiredSignatures,
        collectedSignatures: 0,
        requestedBy: request.requestedBy,
        requestedAt: new Date(),
        expiresAt,
      },
    });

    // Log the consensus initiation
    await this.logAuditEvent({
      eventType: "CONSENSUS_INITIATED",
      actionType: request.actionType,
      relatedId: pendingConsensus.id,
      actorPublicKey: request.requestedBy,
      actorName: this.extractAdminName(req),
      actorRole: this.extractAdminRole(req),
      eventDetails: JSON.stringify({
        actionData: request.actionData,
        requiredSignatures,
        expiresAt,
      }),
      ipAddress: this.extractIpAddress(req),
      userAgent: req.get("User-Agent") || undefined,
    });

    console.info(
      `[SignatureValidation] Created consensus request ${pendingConsensus.id} for ${request.actionType} by ${request.requestedBy}`
    );

    return {
      id: pendingConsensus.id,
      status: pendingConsensus.status,
    };
  }

  /**
   * Add an admin signature to a pending consensus request
   */
  async addSignature(
    consensusId: number,
    adminSignature: AdminSignature,
    req: Request
  ): Promise<ValidationResult> {
    // Validate the consensus request exists and is pending
    const consensus = await prisma.pendingConsensus.findUnique({
      where: { id: consensusId },
      include: {
        pendingSignatures: true,
      },
    });

    if (!consensus) {
      return {
        valid: false,
        canExecute: false,
        message: "Consensus request not found",
      };
    }

    if (consensus.status !== "PENDING") {
      return {
        valid: false,
        canExecute: false,
        message: `Consensus request is ${consensus.status}`,
      };
    }

    if (new Date() > consensus.expiresAt) {
      await this.updateConsensusStatus(consensusId, "EXPIRED");
      return {
        valid: false,
        canExecute: false,
        message: "Consensus request has expired",
      };
    }

    // Check if admin has already signed
    const existingSignature = consensus.pendingSignatures.find(
      (sig: any) => sig.adminPublicKey === adminSignature.adminPublicKey
    );

    if (existingSignature) {
      return {
        valid: false,
        canExecute: false,
        message: "Admin has already signed this request",
      };
    }

    // Validate the signature
    const isSignatureValid = await this.validateSignature(
      consensusId,
      consensus.actionType,
      adminSignature.signature,
      adminSignature.adminPublicKey
    );

    if (!isSignatureValid) {
      await this.logAuditEvent({
        eventType: "SIGNATURE_INVALID",
        actionType: consensus.actionType,
        relatedId: consensusId,
        actorPublicKey: adminSignature.adminPublicKey,
        actorName: adminSignature.adminName,
        actorRole: adminSignature.adminRole,
        eventDetails: JSON.stringify({
          signature: adminSignature.signature,
          reason: "Invalid cryptographic signature",
        }),
        ipAddress: adminSignature.ipAddress,
        userAgent: adminSignature.userAgent,
      });

      return {
        valid: false,
        canExecute: false,
        message: "Invalid signature",
      };
    }

    // Add the signature
    await prisma.pendingSignature.create({
      data: {
        pendingConsensusId: consensusId,
        adminPublicKey: adminSignature.adminPublicKey,
        adminName: adminSignature.adminName,
        adminRole: adminSignature.adminRole,
        signature: adminSignature.signature,
        ipAddress: adminSignature.ipAddress,
        userAgent: adminSignature.userAgent,
        signedAt: new Date(),
      },
    });

    // Update collected signatures count
    const updatedConsensus = await prisma.pendingConsensus.update({
      where: { id: consensusId },
      data: {
        collectedSignatures: {
          increment: 1,
        },
      },
      include: {
        pendingSignatures: true,
      },
    });

    // Log the signature addition
    await this.logAuditEvent({
      eventType: "SIGNATURE_ADDED",
      actionType: consensus.actionType,
      relatedId: consensusId,
      actorPublicKey: adminSignature.adminPublicKey,
      actorName: adminSignature.adminName,
      actorRole: adminSignature.adminRole,
      eventDetails: JSON.stringify({
        collectedSignatures: updatedConsensus.collectedSignatures,
        requiredSignatures: updatedConsensus.requiredSignatures,
      }),
      ipAddress: adminSignature.ipAddress,
      userAgent: adminSignature.userAgent,
    });

    console.info(
      `[SignatureValidation] Added signature ${updatedConsensus.collectedSignatures}/${updatedConsensus.requiredSignatures} for consensus ${consensusId}`
    );

    // Check if consensus is reached
    const canExecute = updatedConsensus.collectedSignatures >= updatedConsensus.requiredSignatures;

    if (canExecute) {
      await this.updateConsensusStatus(consensusId, "APPROVED");
      
      await this.logAuditEvent({
        eventType: "CONSENSUS_APPROVED",
        actionType: consensus.actionType,
        relatedId: consensusId,
        actorPublicKey: adminSignature.adminPublicKey,
        actorName: adminSignature.adminName,
        actorRole: adminSignature.adminRole,
        eventDetails: JSON.stringify({
          finalSignatures: updatedConsensus.collectedSignatures,
          requiredSignatures: updatedConsensus.requiredSignatures,
        }),
        ipAddress: adminSignature.ipAddress,
        userAgent: adminSignature.userAgent,
      });
    }

    return {
      valid: true,
      canExecute,
      message: canExecute
        ? "Consensus reached - action can be executed"
        : `Signature added. Need ${updatedConsensus.requiredSignatures - updatedConsensus.collectedSignatures} more signatures`,
      pendingSignatures: updatedConsensus.pendingSignatures.map((sig) => ({
        adminPublicKey: sig.adminPublicKey,
        adminName: sig.adminName,
        adminRole: sig.adminRole,
        signature: sig.signature,
        ipAddress: sig.ipAddress,
        userAgent: sig.userAgent || undefined,
      })),
      missingSignatures: Math.max(0, updatedConsensus.requiredSignatures - updatedConsensus.collectedSignatures),
    };
  }

  /**
   * Validate if a consensus request can be executed
   */
  async validateConsensus(consensusId: number): Promise<ValidationResult> {
    const consensus = await prisma.pendingConsensus.findUnique({
      where: { id: consensusId },
      include: {
        pendingSignatures: true,
      },
    });

    if (!consensus) {
      return {
        valid: false,
        canExecute: false,
        message: "Consensus request not found",
      };
    }

    if (consensus.status !== "APPROVED") {
      return {
        valid: false,
        canExecute: false,
        message: `Consensus request is ${consensus.status}`,
      };
    }

    // Verify we have the required number of valid signatures
    const validSignatures = await this.verifyAllSignatures(consensus);

    if (validSignatures.length < consensus.requiredSignatures) {
      return {
        valid: false,
        canExecute: false,
        message: "Insufficient valid signatures",
        pendingSignatures: consensus.pendingSignatures.map((sig) => ({
          adminPublicKey: sig.adminPublicKey,
          adminName: sig.adminName,
          adminRole: sig.adminRole,
          signature: sig.signature,
          ipAddress: sig.ipAddress,
          userAgent: sig.userAgent || undefined,
        })),
        missingSignatures: consensus.requiredSignatures - validSignatures.length,
      };
    }

    // Check for distinct admin signatures
    const distinctAdmins = new Set(validSignatures.map((sig) => sig.adminPublicKey));
    if (distinctAdmins.size < this.MIN_REQUIRED_SIGNATURES) {
      return {
        valid: false,
        canExecute: false,
        message: "Requires signatures from at least 2 distinct admins",
      };
    }

    return {
      valid: true,
      canExecute: true,
      message: "Consensus validated - action can be executed",
      pendingSignatures: validSignatures.map((sig) => ({
        adminPublicKey: sig.adminPublicKey,
        adminName: sig.adminName,
        adminRole: sig.adminRole,
        signature: sig.signature,
        ipAddress: sig.ipAddress,
        userAgent: sig.userAgent || undefined,
      })),
    };
  }

  /**
   * Mark a consensus request as executed
   */
  async markAsExecuted(
    consensusId: number,
    executionResult: string,
    req: Request
  ): Promise<void> {
    const consensus = await prisma.pendingConsensus.findUnique({
      where: { id: consensusId },
    });

    if (!consensus) {
      throw new Error("Consensus request not found");
    }

    await prisma.pendingConsensus.update({
      where: { id: consensusId },
      data: {
        status: "EXECUTED",
        executedAt: new Date(),
        executionResult,
      },
    });

    await this.logAuditEvent({
      eventType: "ACTION_EXECUTED",
      actionType: consensus.actionType,
      relatedId: consensusId,
      actorPublicKey: this.extractAdminPublicKey(req),
      actorName: this.extractAdminName(req),
      actorRole: this.extractAdminRole(req),
      eventDetails: JSON.stringify({
        executionResult,
        executedAt: new Date(),
      }),
      ipAddress: this.extractIpAddress(req),
      userAgent: req.get("User-Agent") || undefined,
    });

    console.info(
      `[SignatureValidation] Consensus ${consensusId} for ${consensus.actionType} executed successfully`
    );
  }

  /**
   * Get pending consensus requests
   */
  async getPendingRequests(): Promise<any[]> {
    return prisma.pendingConsensus.findMany({
      where: { status: "PENDING" },
      include: {
        pendingSignatures: {
          select: {
            adminPublicKey: true,
            adminName: true,
            adminRole: true,
            signedAt: true,
          },
        },
      },
      orderBy: { requestedAt: "desc" },
    });
  }

  /**
   * Get consensus request details
   */
  async getConsensusRequest(consensusId: number): Promise<any> {
    return prisma.pendingConsensus.findUnique({
      where: { id: consensusId },
      include: {
        pendingSignatures: true,
      },
    });
  }

  /**
   * Clean up expired consensus requests
   */
  async cleanupExpiredRequests(): Promise<number> {
    const result = await prisma.pendingConsensus.updateMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: new Date() },
      },
      data: {
        status: "EXPIRED",
      },
    });

    if (result.count > 0) {
      console.warn(`[SignatureValidation] Expired ${result.count} consensus requests`);
    }

    return result.count;
  }

  /**
   * Validate cryptographic signature
   */
  private async validateSignature(
    consensusId: number,
    actionType: string,
    signature: string,
    publicKey: string
  ): Promise<boolean> {
    try {
      const message = await this.createSignatureMessage(consensusId, actionType);
      const publicKeyObj = Keypair.fromPublicKey(publicKey);
      const signatureBuffer = Buffer.from(signature, "hex");
      const messageBuffer = Buffer.from(message, "utf-8");

      return publicKeyObj.verify(messageBuffer, signatureBuffer);
    } catch (error) {
      console.error(`[SignatureValidation] Signature validation failed:`, error);
      return false;
    }
  }

  /**
   * Verify all signatures for a consensus request
   */
  private async verifyAllSignatures(consensus: any): Promise<any[]> {
    const validSignatures = [];

    for (const sig of consensus.pendingSignatures) {
      const isValid = await this.validateSignature(
        consensus.id,
        consensus.actionType,
        sig.signature,
        sig.adminPublicKey
      );

      if (isValid) {
        validSignatures.push(sig);
      }
    }

    return validSignatures;
  }

  /**
   * Create deterministic signature message
   */
  private async createSignatureMessage(consensusId: number, actionType: string): Promise<string> {
    const consensus = await prisma.pendingConsensus.findUnique({
      where: { id: consensusId },
      select: { expiresAt: true }
    });
    
    if (!consensus) {
      throw new Error(`Consensus ${consensusId} not found`);
    }
    
    return `SF-CONSENSUS-${consensusId}-${actionType}-${new Date(consensus.expiresAt).getTime()}`;
  }

  /**
   * Update consensus status
   */
  private async updateConsensusStatus(consensusId: number, status: string): Promise<void> {
    await prisma.pendingConsensus.update({
      where: { id: consensusId },
      data: { status },
    });
  }

  /**
   * Log audit event
   */
  private async logAuditEvent(event: {
    eventType: string;
    actionType?: string;
    relatedId?: number;
    actorPublicKey: string;
    actorName: string;
    actorRole?: string;
    eventDetails?: string;
    previousState?: string;
    newState?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await prisma.auditLog.create({
      data: {
        eventType: event.eventType,
        actionType: event.actionType,
        relatedId: event.relatedId,
        actorPublicKey: event.actorPublicKey,
        actorName: event.actorName,
        actorRole: event.actorRole,
        eventDetails: event.eventDetails,
        previousState: event.previousState,
        newState: event.newState,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        occurredAt: new Date(),
      },
    });
  }

  /**
   * Extract admin public key from request
   */
  private extractAdminPublicKey(req: Request): string {
    // This would typically come from authentication middleware
    return (req as any).admin?.publicKey || "unknown";
  }

  /**
   * Extract admin name from request
   */
  private extractAdminName(req: Request): string {
    return (req as any).admin?.name || "unknown";
  }

  /**
   * Extract admin role from request
   */
  private extractAdminRole(req: Request): string {
    return (req as any).admin?.role || "unknown";
  }

  /**
   * Extract IP address from request
   */
  private extractIpAddress(req: Request): string {
    return req.ip || req.connection.remoteAddress || "unknown";
  }
}

// Export singleton instance
export const signatureValidationService = new SignatureValidationService();
