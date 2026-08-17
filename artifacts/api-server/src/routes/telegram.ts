import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

/**
 * Telegram webhook endpoint.
 *
 * In webhook mode, index.ts registers a handler via setTelegramUpdateHandler()
 * and Telegram POSTs updates to /api/telegram/:secretPath. The secret path
 * (default "telegram", overridable via WEBHOOK_SECRET_PATH) obscures the
 * endpoint, and WEBHOOK_SECRET_TOKEN (if set) is verified against the
 * X-Telegram-Bot-Api-Secret-Token header.
 */

let updateHandler: ((body: unknown) => Promise<void>) | null = null;
let expectedSecretToken: string | null = null;

export function setTelegramUpdateHandler(
  handler: (body: unknown) => Promise<void>,
  secretToken?: string,
): void {
  updateHandler = handler;
  expectedSecretToken = secretToken ?? null;
}

const router: IRouter = Router();

router.post("/telegram/:secretPath", async (req, res) => {
  if (!updateHandler) {
    logger.warn("Webhook received but no handler registered");
    res.sendStatus(503);
    return;
  }
  if (expectedSecretToken && req.header("X-Telegram-Bot-Api-Secret-Token") !== expectedSecretToken) {
    logger.warn("Webhook rejected: bad secret token");
    res.sendStatus(401);
    return;
  }
  try {
    await updateHandler(req.body);
    res.sendStatus(200);
  } catch (err) {
    logger.error({ err }, "Webhook update processing failed");
    // Telegram retries on non-2xx; failing updates get a few attempts.
    res.sendStatus(500);
  }
});

export default router;
