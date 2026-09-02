import { Request, Response, Router } from "express";
import { getOrderDepth } from "../controllers/orderDepthController";

const router = Router();

router.get("/depth", getOrderDepth);

export default router;