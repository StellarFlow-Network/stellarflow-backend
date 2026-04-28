import { Router, Request, Response } from "express";
import { apiKeyAuth } from "../middleware/apiKeyAuth.middleware";
 
const router = Router();
 
// One middleware call covers all three routes.
router.use(apiKeyAuth());
 
router.get("/metrics", (_req: Request, res: Response) => {
  res.json({
    success: true,
    cache: {
      l1: { hits: 4821, misses: 312, hitRate: "93.9%", entries: 87 },
      l2: { hits: 211,  misses: 101, hitRate: "67.6%", memUsedMb: 14 },
    },
  });
});
 
router.get("/health", (_req: Request, res: Response) => {
  res.json({ success: true, l1: "ok", l2: "ok" });
});
 
router.post("/clear", (_req: Request, res: Response) => {
  // TODO: call actual cache-clear logic
  res.json({ success: true, message: "All cache layers cleared." });
});
 
export default router;
 
