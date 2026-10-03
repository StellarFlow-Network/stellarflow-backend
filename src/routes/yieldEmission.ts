import { Router } from "express";
import { sendApiError } from "../lib/apiError.js";
import { getEmissions, getCurrentEmissionRate, getEmissionSchedule } from "../controllers/yieldEmissionController";
import { cacheMiddleware } from "../cache/CacheMiddleware";
import { CACHE_CONFIG, CACHE_KEYS } from "../config/redis.config";

const router = Router();

// GET /api/v1/yield/emissions - Get complete emission data
router.get(
  "/emissions",
  cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.yieldEmissions,
    keyGenerator: () => CACHE_KEYS.yieldEmissions.complete(),
  }),
  getEmissions,
);

// GET /api/v1/yield/emissions/rate - Get current emission rate only
router.get(
  "/emissions/rate",
  cacheMiddleware({
    ttl: 60, // 1 minute cache for emission rate
    keyGenerator: () => CACHE_KEYS.yieldEmissions.rate(),
  }),
  getCurrentEmissionRate,
);

// GET /api/v1/yield/emissions/schedule - Get emission schedule only
router.get(
  "/emissions/schedule",
  cacheMiddleware({
    ttl: 3600, // 1 hour cache for schedule (changes rarely)
    keyGenerator: () => CACHE_KEYS.yieldEmissions.schedule(),
  }),
  getEmissionSchedule,
);

export default router;
