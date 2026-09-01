import { Router } from "express";
import { metricsEndpoint } from "../middleware/metrics";

const router = Router();

router.get("/", metricsEndpoint);

export default router;
