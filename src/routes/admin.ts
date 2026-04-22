import express from "express";
import { lockdownService } from "../common/lockdown/lockdown.service";

const router = express.Router();

// Simple admin guard (can be replaced with proper auth later)
const adminMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ success: false, error: "Unauthorized" });
  }
  next();
};

/**
 * POST /api/admin/lockdown
 * Toggles lockdown state
 */
router.post("/lockdown", adminMiddleware, (req, res) => {
  const status = lockdownService.toggle();

  res.json({
    success: true,
    lockdown: status,
    message: `Lockdown ${status ? "enabled" : "disabled"}`,
  });
});

/**
 * GET /api/admin/lockdown
 * Check current status
 */
router.get("/lockdown", adminMiddleware, (req, res) => {
  res.json({
    success: true,
    lockdown: lockdownService.status(),
  });
});

export default router;
