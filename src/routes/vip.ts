import { Router, Request, Response } from "express";
import { ipWhitelistService } from "../services/ipWhitelist.service";

const router = Router();

/**
 * GET /api/vip/whitelist
 * Get all whitelisted IPs
 */
router.get("/whitelist", async (req: Request, res: Response) => {
  try {
    const { active } = req.query;

    let ips;
    if (active === "true") {
      ips = await ipWhitelistService.getActiveIPs();
    } else {
      ips = await ipWhitelistService.getAllIPs();
    }

    res.json({
      success: true,
      data: ips,
    });
  } catch (error) {
    console.error("[VIP] Failed to fetch whitelist:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch whitelist",
    });
  }
});

/**
 * GET /api/vip/stats
 * Get VIP pool statistics
 */
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const stats = await ipWhitelistService.getVIPStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("[VIP] Failed to fetch stats:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch VIP stats",
    });
  }
});

/**
 * POST /api/vip/whitelist
 * Add an IP to the whitelist
 */
router.post("/whitelist", async (req: Request, res: Response) => {
  try {
    const { ipAddress, label, priority, rateLimitOverride, notes } = req.body;

    if (!ipAddress || !label) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: ipAddress, label",
      });
    }

    const entry = await ipWhitelistService.addIP({
      ipAddress,
      label,
      priority,
      rateLimitOverride,
      notes,
    });

    res.status(201).json({
      success: true,
      data: entry,
    });
  } catch (error) {
    console.error("[VIP] Failed to add IP:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to add IP to whitelist",
    });
  }
});

/**
 * PUT /api/vip/whitelist/:ipAddress
 * Update a whitelisted IP
 */
router.put("/whitelist/:ipAddress", async (req: Request, res: Response) => {
  try {
    const ipAddress = req.params.ipAddress as string;
    if (!ipAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing ipAddress parameter",
      });
    }

    const { label, priority, rateLimitOverride, notes } = req.body;

    const entry = await ipWhitelistService.updateIP(ipAddress, {
      label,
      priority,
      rateLimitOverride,
      notes,
    });

    if (!entry) {
      return res.status(404).json({
        success: false,
        error: `IP ${ipAddress} not found in whitelist`,
      });
    }

    res.json({
      success: true,
      data: entry,
    });
  } catch (error) {
    console.error("[VIP] Failed to update IP:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to update IP",
    });
  }
});

/**
 * DELETE /api/vip/whitelist/:ipAddress
 * Remove an IP from the whitelist
 */
router.delete("/whitelist/:ipAddress", async (req: Request, res: Response) => {
  try {
    const ipAddress = req.params.ipAddress as string;
    if (!ipAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing ipAddress parameter",
      });
    }

    const deleted = await ipWhitelistService.removeIP(ipAddress);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: `IP ${ipAddress} not found in whitelist`,
      });
    }

    res.json({
      success: true,
      message: `IP ${ipAddress} removed from whitelist`,
    });
  } catch (error) {
    console.error("[VIP] Failed to remove IP:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to remove IP",
    });
  }
});

/**
 * POST /api/vip/whitelist/:ipAddress/deactivate
 * Deactivate an IP (soft delete)
 */
router.post(
  "/whitelist/:ipAddress/deactivate",
  async (req: Request, res: Response) => {
    try {
      const ipAddress = req.params.ipAddress as string;
      if (!ipAddress) {
        return res.status(400).json({
          success: false,
          error: "Missing ipAddress parameter",
        });
      }

      const entry = await ipWhitelistService.deactivateIP(ipAddress);

      if (!entry) {
        return res.status(404).json({
          success: false,
          error: `IP ${ipAddress} not found in whitelist`,
        });
      }

      res.json({
        success: true,
        data: entry,
      });
    } catch (error) {
      console.error("[VIP] Failed to deactivate IP:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to deactivate IP",
      });
    }
  }
);

/**
 * POST /api/vip/whitelist/:ipAddress/reactivate
 * Reactivate an IP
 */
router.post(
  "/whitelist/:ipAddress/reactivate",
  async (req: Request, res: Response) => {
    try {
      const ipAddress = req.params.ipAddress as string;
      if (!ipAddress) {
        return res.status(400).json({
          success: false,
          error: "Missing ipAddress parameter",
        });
      }

      const entry = await ipWhitelistService.reactivateIP(ipAddress);

      if (!entry) {
        return res.status(404).json({
          success: false,
          error: `IP ${ipAddress} not found in whitelist`,
        });
      }

      res.json({
        success: true,
        data: entry,
      });
    } catch (error) {
      console.error("[VIP] Failed to reactivate IP:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to reactivate IP",
      });
    }
  }
);

/**
 * GET /api/vip/check/:ipAddress
 * Check if an IP is in the VIP pool
 */
router.get("/check/:ipAddress", async (req: Request, res: Response) => {
  try {
    const ipAddress = req.params.ipAddress as string;
    if (!ipAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing ipAddress parameter",
      });
    }

    const vipContext = await ipWhitelistService.checkIP(ipAddress);

    res.json({
      success: true,
      data: {
        ipAddress,
        isVIP: vipContext.isVIP,
        priority: vipContext.priority,
        rateLimit: vipContext.customRateLimit,
        entry: vipContext.entry || null,
      },
    });
  } catch (error) {
    console.error("[VIP] Failed to check IP:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to check IP",
    });
  }
});

export default router;
