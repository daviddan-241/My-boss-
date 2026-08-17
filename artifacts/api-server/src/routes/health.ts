import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getStatusSnapshot } from "../lib/statusRegistry";

const router: IRouter = Router();

/**
 * GET /api/healthz — platform health check (Render/Railway/Fly all use this).
 * Kept zod-validated for API-spec compatibility.
 */
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * GET /api/health/bot — rich diagnostics: server uptime, bot mode/status,
 * session count and per-source lookup stats. Also returns 200 while the bot
 * itself is healthy so it can be used as a keep-alive target.
 */
router.get("/health/bot", (_req, res) => {
  const snapshot = getStatusSnapshot();
  res.json(snapshot);
});

export default router;
