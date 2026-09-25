import express from "express";
import { watchlistService } from "../services/watchlistService";

const router = express.Router();
function userId(req: express.Request): number | null { return req.user?.userId ?? req.sessionId ?? null; }
router.use((req, res, next) => { if (!userId(req)) { res.status(401).json({ success: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required" } }); return; } next(); });
router.get("/", async (req, res, next) => { try { res.json({ success: true, data: await watchlistService.list(userId(req)!) }); } catch (error) { next(error); } });
router.post("/", async (req, res, next) => {
  try {
    const { token, targetPrice, direction } = req.body;
    if (typeof token !== "string" || !Number.isFinite(Number(targetPrice)) || ![undefined, "ABOVE", "BELOW"].includes(direction)) { res.status(400).json({ success: false, error: { code: "INVALID_WATCHLIST_ITEM", message: "token, targetPrice and direction (ABOVE or BELOW) are required" } }); return; }
    res.status(201).json({ success: true, data: await watchlistService.create(userId(req)!, { token, targetPrice: Number(targetPrice), direction }) });
  } catch (error) { next(error); }
});
router.patch("/:id", async (req, res, next) => { try { res.json({ success: true, data: await watchlistService.update(userId(req)!, req.params.id, req.body) }); } catch (error) { next(error); } });
router.delete("/:id", async (req, res, next) => { try { res.json({ success: true, data: await watchlistService.delete(userId(req)!, req.params.id) }); } catch (error) { next(error); } });
export default router;