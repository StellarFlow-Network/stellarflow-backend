import express from "express";
import { treasuryBurnTracker } from "../services/treasuryBurnTracker";

const router = express.Router();
router.get("/burn-stats", async (_req, res, next) => {
  try { res.json({ success: true, data: await treasuryBurnTracker.getStats() }); } catch (error) { next(error); }
});
export default router;