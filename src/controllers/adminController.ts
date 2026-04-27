import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Log audit event for admin actions
 */
async function logAuditEvent(event: {
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
  try {
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
  } catch (error) {
    console.error("[Admin] Failed to log audit event:", error);
    // Don't fail the main operation if audit logging fails
  }
}

/**
 * Extract admin info from request (placeholder - would be set by auth middleware)
 */
function extractAdminInfo(req: Request) {
  return {
    publicKey: (req as any).admin?.publicKey || "unknown",
    name: (req as any).admin?.name || "unknown",
    role: (req as any).admin?.role || "ADMIN",
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  };
}

/**
 * Get all relayer registry entries
 * Admin-only endpoint for viewing KYC information
 */
export const getRelayerRegistry = async (req: Request, res: Response) => {
  try {
    const registries = await prisma.relayerRegistry.findMany({
      include: {
        relayer: {
          select: {
            id: true,
            name: true,
            isActive: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      success: true,
      data: registries,
    });
  } catch (error) {
    console.error("[Admin] Failed to fetch relayer registry:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch relayer registry",
    });
  }
};

/**
 * Get a specific relayer registry entry by relayer ID
 * Admin-only endpoint for viewing KYC information for a specific relayer
 */
export const getRelayerRegistryById = async (req: Request, res: Response) => {
  try {
    const relayerId = parseInt(req.params.relayerId);

    if (isNaN(relayerId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid relayer ID",
      });
    }

    const registry = await prisma.relayerRegistry.findUnique({
      where: { relayerId },
      include: {
        relayer: {
          select: {
            id: true,
            name: true,
            isActive: true,
            createdAt: true,
          },
        },
      },
    });

    if (!registry) {
      return res.status(404).json({
        success: false,
        error: "Relayer registry entry not found",
      });
    }

    res.json({
      success: true,
      data: registry,
    });
  } catch (error) {
    console.error("[Admin] Failed to fetch relayer registry by ID:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch relayer registry entry",
    });
  }
};

/**
 * Create or update a relayer registry entry
 * Admin-only endpoint for managing KYC information
 */
export const upsertRelayerRegistry = async (req: Request, res: Response) => {
  try {
    const { relayerId, contactName, email, organizationName } = req.body;

    // Validate required fields
    if (!relayerId || !contactName || !email || !organizationName) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: relayerId, contactName, email, organizationName",
      });
    }

    // Validate relayer exists
    const relayer = await prisma.relayer.findUnique({
      where: { id: relayerId },
    });

    if (!relayer) {
      return res.status(404).json({
        success: false,
        error: "Relayer not found",
      });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: "Invalid email format",
      });
    }

    // Check if this is an update or create
    const existing = await prisma.relayerRegistry.findUnique({
      where: { relayerId },
    });

    const isUpdate = !!existing;

    // Upsert the registry entry
    const registry = await prisma.relayerRegistry.upsert({
      where: { relayerId },
      update: {
        contactName,
        email,
        organizationName,
        updatedAt: new Date(),
      },
      create: {
        relayerId,
        contactName,
        email,
        organizationName,
      },
      include: {
        relayer: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
      },
    });

    // Log audit event
    const adminInfo = extractAdminInfo(req);
    await logAuditEvent({
      eventType: isUpdate ? "RELAYER_REGISTRY_UPDATED" : "RELAYER_REGISTRY_CREATED",
      actionType: "RELAYER_REGISTRY",
      relatedId: registry.id,
      actorPublicKey: adminInfo.publicKey,
      actorName: adminInfo.name,
      actorRole: adminInfo.role,
      eventDetails: `Relayer registry ${isUpdate ? 'updated' : 'created'} for relayer ID ${relayerId}`,
      previousState: isUpdate ? JSON.stringify({
        contactName: existing.contactName,
        email: existing.email,
        organizationName: existing.organizationName,
      }) : null,
      newState: JSON.stringify({
        contactName: registry.contactName,
        email: registry.email,
        organizationName: registry.organizationName,
      }),
      ipAddress: adminInfo.ipAddress,
      userAgent: adminInfo.userAgent,
    });

    res.json({
      success: true,
      data: registry,
      message: `Relayer registry entry ${isUpdate ? 'updated' : 'created'} successfully`,
    });
  } catch (error) {
    console.error("[Admin] Failed to upsert relayer registry:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create/update relayer registry entry",
    });
  }
};

/**
 * Delete a relayer registry entry
 * Admin-only endpoint for removing KYC information
 */
export const deleteRelayerRegistry = async (req: Request, res: Response) => {
  try {
    const relayerId = parseInt(req.params.relayerId);

    if (isNaN(relayerId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid relayer ID",
      });
    }

    // Check if registry entry exists
    const existing = await prisma.relayerRegistry.findUnique({
      where: { relayerId },
      include: {
        relayer: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: "Relayer registry entry not found",
      });
    }

    // Log audit event before deletion
    const adminInfo = extractAdminInfo(req);
    await logAuditEvent({
      eventType: "RELAYER_REGISTRY_DELETED",
      actionType: "RELAYER_REGISTRY",
      relatedId: existing.id,
      actorPublicKey: adminInfo.publicKey,
      actorName: adminInfo.name,
      actorRole: adminInfo.role,
      eventDetails: `Relayer registry deleted for relayer ID ${relayerId}`,
      previousState: JSON.stringify({
        contactName: existing.contactName,
        email: existing.email,
        organizationName: existing.organizationName,
      }),
      newState: null,
      ipAddress: adminInfo.ipAddress,
      userAgent: adminInfo.userAgent,
    });

    await prisma.relayerRegistry.delete({
      where: { relayerId },
    });

    res.json({
      success: true,
      message: "Relayer registry entry deleted successfully",
    });
  } catch (error) {
    console.error("[Admin] Failed to delete relayer registry:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete relayer registry entry",
    });
  }
};