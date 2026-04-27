import { Request, Response } from "express";
import { signatureValidationService, AdminSignature, ConsensusRequest } from "../services/signatureValidationService";
import { Keypair } from "@stellar/stellar-sdk";
import { TracingService } from "../services/tracingService";
import { sendKillSwitchAlert, sendSystemFailureAlert } from "../services/notificationService";

export interface HaltActionData {
  reason: string;
  duration?: number; // in hours, optional
  emergencyLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface UpgradeActionData {
  version: string;
  upgradeType: "PATCH" | "MINOR" | "MAJOR";
  scheduledAt?: Date;
  rollbackPlan?: string;
  notes?: string;
}

export class SystemControlController {
  /**
   * Initiate a system halt request requiring consensus
   */
  async initiateHaltRequest(req: Request, res: Response): Promise<void> {
    try {
      const { reason, duration, emergencyLevel }: HaltActionData = req.body;
      const adminInfo = this.extractAdminInfo(req);

      // Validate input
      if (!reason || reason.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: "Halt reason is required",
        });
        return;
      }

      // Create tracing span
      const span = TracingService.traceRelayerRequest(req, "system_control", "initiate_halt");

      // Create consensus request
      const consensusRequest: ConsensusRequest = {
        actionType: "HALT",
        actionData: JSON.stringify({
          reason: reason.trim(),
          duration: duration || 24, // default 24 hours
          emergencyLevel: emergencyLevel || "MEDIUM",
        }),
        requestedBy: adminInfo.publicKey,
        requiredSignatures: this.getRequiredSignaturesForAction("HALT", emergencyLevel || "MEDIUM"),
      };

      const result = await signatureValidationService.createConsensusRequest(
        consensusRequest,
        req
      );

      TracingService.addLog(span, "info", `Halt request initiated: ${result.id}`, {
        consensusId: result.id,
        reason,
        emergencyLevel,
      });
      TracingService.finishSpan(span);

      res.status(201).json({
        success: true,
        message: "Halt request created and pending approval",
        data: {
          consensusId: result.id,
          status: result.status,
          requiredSignatures: consensusRequest.requiredSignatures,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        },
      });
    } catch (error) {
      console.error("[SystemControl] Failed to initiate halt request:", error);
      res.status(500).json({
        success: false,
        error: "Failed to create halt request",
      });
    }
  }

  /**
   * Initiate a system upgrade request requiring consensus
   */
  async initiateUpgradeRequest(req: Request, res: Response): Promise<void> {
    try {
      const { version, upgradeType, scheduledAt, rollbackPlan, notes }: UpgradeActionData = req.body;
      const adminInfo = this.extractAdminInfo(req);

      // Validate input
      if (!version || version.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: "Upgrade version is required",
        });
        return;
      }

      if (!upgradeType || !["PATCH", "MINOR", "MAJOR"].includes(upgradeType)) {
        res.status(400).json({
          success: false,
          error: "Valid upgrade type (PATCH, MINOR, MAJOR) is required",
        });
        return;
      }

      // Create tracing span
      const span = TracingService.traceRelayerRequest(req, "system_control", "initiate_upgrade");

      // Create consensus request
      const consensusRequest: ConsensusRequest = {
        actionType: "UPGRADE",
        actionData: JSON.stringify({
          version: version.trim(),
          upgradeType,
          scheduledAt: scheduledAt || new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
          rollbackPlan: rollbackPlan || "",
          notes: notes || "",
        }),
        requestedBy: adminInfo.publicKey,
        requiredSignatures: this.getRequiredSignaturesForAction("UPGRADE", upgradeType),
      };

      const result = await signatureValidationService.createConsensusRequest(
        consensusRequest,
        req
      );

      TracingService.addLog(span, "info", `Upgrade request initiated: ${result.id}`, {
        consensusId: result.id,
        version,
        upgradeType,
      });
      TracingService.finishSpan(span);

      res.status(201).json({
        success: true,
        message: "Upgrade request created and pending approval",
        data: {
          consensusId: result.id,
          status: result.status,
          requiredSignatures: consensusRequest.requiredSignatures,
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours for upgrades
        },
      });
    } catch (error) {
      console.error("[SystemControl] Failed to initiate upgrade request:", error);
      res.status(500).json({
        success: false,
        error: "Failed to create upgrade request",
      });
    }
  }

  /**
   * Add admin signature to a pending consensus request
   */
  async addSignature(req: Request, res: Response): Promise<void> {
    try {
      const { consensusId } = req.params;
      const { signature }: { signature: string } = req.body;
      const adminInfo = this.extractAdminInfo(req);

      // Validate input
      if (!consensusId || isNaN(Number(consensusId))) {
        res.status(400).json({
          success: false,
          error: "Valid consensus ID is required",
        });
        return;
      }

      if (!signature || signature.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: "Signature is required",
        });
        return;
      }

      // Create tracing span
      const span = TracingService.traceRelayerRequest(req, "system_control", "add_signature");

      // Prepare admin signature
      const adminSignature: AdminSignature = {
        adminPublicKey: adminInfo.publicKey,
        adminName: adminInfo.name,
        adminRole: adminInfo.role,
        signature: signature.trim(),
        ipAddress: req.ip || "unknown",
        userAgent: req.get("User-Agent") || undefined,
      };

      // Add signature
      const result = await signatureValidationService.addSignature(
        Number(consensusId),
        adminSignature,
        req
      );

      TracingService.addLog(span, "info", `Signature added for consensus: ${consensusId}`, {
        consensusId,
        valid: result.valid,
        canExecute: result.canExecute,
        missingSignatures: result.missingSignatures,
      });
      TracingService.finishSpan(span);

      res.status(200).json({
        success: result.valid,
        message: result.message,
        data: {
          consensusId: Number(consensusId),
          canExecute: result.canExecute,
          pendingSignatures: result.pendingSignatures,
          missingSignatures: result.missingSignatures,
        },
      });
    } catch (error) {
      console.error("[SystemControl] Failed to add signature:", error);
      res.status(500).json({
        success: false,
        error: "Failed to add signature",
      });
    }
  }

  /**
   * Execute a consensus request that has been approved
   */
  async executeConsensus(req: Request, res: Response): Promise<void> {
    try {
      const { consensusId } = req.params;
      const adminInfo = this.extractAdminInfo(req);

      // Validate input
      if (!consensusId || isNaN(Number(consensusId))) {
        res.status(400).json({
          success: false,
          error: "Valid consensus ID is required",
        });
        return;
      }

      // Create tracing span
      const span = TracingService.traceRelayerRequest(req, "system_control", "execute_consensus");

      // Validate consensus
      const validation = await signatureValidationService.validateConsensus(
        Number(consensusId)
      );

      if (!validation.canExecute) {
        TracingService.finishSpan(span, new Error(validation.message));
        res.status(400).json({
          success: false,
          error: validation.message,
        });
        return;
      }

      // Get consensus details
      const consensus = await signatureValidationService.getConsensusRequest(
        Number(consensusId)
      );

      if (!consensus) {
        TracingService.finishSpan(span, new Error("Consensus request not found"));
        res.status(404).json({
          success: false,
          error: "Consensus request not found",
        });
        return;
      }

      // Execute the action
      let executionResult: string;
      try {
        executionResult = await this.executeAction(consensus.actionType, consensus.actionData);
      } catch (error) {
        executionResult = `Execution failed: ${error instanceof Error ? error.message : String(error)}`;
        
        await signatureValidationService.markAsExecuted(
          Number(consensusId),
          executionResult,
          req
        );

        TracingService.finishSpan(span, new Error(executionResult));
        res.status(500).json({
          success: false,
          error: "Action execution failed",
          details: executionResult,
        });
        return;
      }

      // Mark as executed
      await signatureValidationService.markAsExecuted(
        Number(consensusId),
        executionResult,
        req
      );

      TracingService.addLog(span, "info", `Consensus executed successfully: ${consensusId}`, {
        consensusId,
        actionType: consensus.actionType,
        result: executionResult,
      });
      TracingService.finishSpan(span);

      res.status(200).json({
        success: true,
        message: "Action executed successfully",
        data: {
          consensusId: Number(consensusId),
          actionType: consensus.actionType,
          executedAt: new Date(),
          result: executionResult,
        },
      });
    } catch (error) {
      console.error("[SystemControl] Failed to execute consensus:", error);
      res.status(500).json({
        success: false,
        error: "Failed to execute consensus",
      });
    }
  }

  /**
   * Get pending consensus requests
   */
  async getPendingRequests(req: Request, res: Response): Promise<void> {
    try {
      const requests = await signatureValidationService.getPendingRequests();

      res.status(200).json({
        success: true,
        data: {
          pendingRequests: requests,
          count: requests.length,
        },
      });
    } catch (error) {
      console.error("[SystemControl] Failed to get pending requests:", error);
      res.status(500).json({
        success: false,
        error: "Failed to retrieve pending requests",
      });
    }
  }

  /**
   * Get consensus request details
   */
  async getConsensusDetails(req: Request, res: Response): Promise<void> {
    try {
      const { consensusId } = req.params;

      if (!consensusId || isNaN(Number(consensusId))) {
        res.status(400).json({
          success: false,
          error: "Valid consensus ID is required",
        });
        return;
      }

      const consensus = await signatureValidationService.getConsensusRequest(
        Number(consensusId)
      );

      if (!consensus) {
        res.status(404).json({
          success: false,
          error: "Consensus request not found",
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: consensus,
      });
    } catch (error) {
      console.error("[SystemControl] Failed to get consensus details:", error);
      res.status(500).json({
        success: false,
        error: "Failed to retrieve consensus details",
      });
    }
  }

  /**
   * Execute the actual system action
   */
  private async executeAction(actionType: string, actionData: string): Promise<string> {
    switch (actionType) {
      case "HALT":
        return this.executeHaltAction(JSON.parse(actionData));
      case "UPGRADE":
        return this.executeUpgradeAction(JSON.parse(actionData));
      default:
        throw new Error(`Unknown action type: ${actionType}`);
    }
  }

  /**
   * Execute system halt
   */
  private async executeHaltAction(data: HaltActionData): Promise<string> {
    console.warn(`[SystemControl] EXECUTING SYSTEM HALT: ${data.reason}`);
    
    // Send kill switch alert before executing halt
    try {
      await sendKillSwitchAlert({
        reason: data.reason,
        service: "system-control",
        correlationId: `halt_${Date.now()}`
      });
    } catch (notificationError) {
      console.error("[SystemControl] Failed to send kill switch alert:", notificationError);
    }
    
    // In a real implementation, this would:
    // 1. Stop accepting new requests
    // 2. Gracefully shutdown services
    // 3. Set system status to HALTED
    // 4. Notify monitoring systems
    
    // For now, we'll simulate the halt
    process.env.SYSTEM_STATUS = "HALTED";
    
    return `System halted successfully. Reason: ${data.reason}. Duration: ${data.duration || 24} hours. Emergency Level: ${data.emergencyLevel || "MEDIUM"}`;
  }

  /**
   * Execute system upgrade
   */
  private async executeUpgradeAction(data: UpgradeActionData): Promise<string> {
    console.warn(`[SystemControl] EXECUTING SYSTEM UPGRADE: ${data.version}`);
    
    // In a real implementation, this would:
    // 1. Prepare for upgrade (backup, maintenance mode)
    // 2. Download and verify new version
    // 3. Apply upgrade
    // 4. Restart services
    // 5. Verify health after upgrade
    
    // For now, we'll simulate the upgrade
    process.env.SYSTEM_VERSION = data.version;
    process.env.UPGRADE_STATUS = "COMPLETED";
    
    return `System upgraded successfully to version ${data.version}. Type: ${data.upgradeType}. Scheduled: ${data.scheduledAt || "Immediate"}`;
  }

  /**
   * Get required signatures based on action type and severity
   */
  private getRequiredSignaturesForAction(actionType: string, severity: string): number {
    const baseSignatures = 2;
    
    switch (actionType) {
      case "HALT":
        if (severity === "CRITICAL") return 2; // Emergency halts need quick approval
        if (severity === "HIGH") return 3;
        return baseSignatures;
        
      case "UPGRADE":
        if (severity === "MAJOR") return 4;
        if (severity === "MINOR") return 3;
        return baseSignatures;
        
      default:
        return baseSignatures;
    }
  }

  /**
   * Extract admin information from request
   */
  private extractAdminInfo(req: Request): {
    publicKey: string;
    name: string;
    role: string;
  } {
    // This would typically come from authentication middleware
    return {
      publicKey: (req as any).admin?.publicKey || "unknown",
      name: (req as any).admin?.name || "unknown",
      role: (req as any).admin?.role || "unknown",
    };
  }
}

// Export singleton instance
export const systemControlController = new SystemControlController();
