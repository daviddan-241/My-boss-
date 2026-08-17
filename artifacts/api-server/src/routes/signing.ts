/**
 * Signing API — powers the wallet-connect webapp (public/signing.html).
 *
 *   GET  /api/signing/order/:id   — order details for the connect page
 *   POST /api/signing/build       — build a real burn/lock transaction
 *   POST /api/signing/submit      — verify the signed tx on-chain and
 *                                   fulfill the order end-to-end
 */

import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import {
  buildBurnTransaction,
  buildLockTransaction,
  verifySignedTransaction,
} from "../lib/signing";
import type { OrderStore } from "../lib/orderStore";

let orderStore: OrderStore | null = null;
let onFulfilled: ((orderId: string, signature: string, link: string) => Promise<void>) | null = null;

export function setSigningDeps(
  store: OrderStore,
  fulfilledHook: (orderId: string, signature: string, link: string) => Promise<void>,
): void {
  orderStore = store;
  onFulfilled = fulfilledHook;
}

const router: IRouter = Router();

router.get("/signing/order/:id", async (req, res) => {
  if (!orderStore) {
    res.sendStatus(503);
    return;
  }
  const order = await orderStore.get(req.params.id);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json({
    id: order.id,
    service: order.service,
    packageName: order.packageName,
    token: order.token,
    details: order.details ?? {},
    status: order.status,
    txHash: order.txHash,
    txLink: order.txLink,
  });
});

router.post("/signing/build", async (req, res) => {
  try {
    const { service, mint, owner, pct } = req.body as {
      service?: string;
      mint?: string;
      owner?: string;
      pct?: number;
    };
    if (!service || !mint || !owner || typeof pct !== "number" || pct <= 0 || pct > 100) {
      res.status(400).json({ error: "service, mint, owner and pct (1–100) are required" });
      return;
    }
    const built =
      service === "burn"
        ? await buildBurnTransaction(mint, owner, pct)
        : service === "lock_supply"
          ? await buildLockTransaction(mint, owner, pct)
          : null;
    if (!built) {
      res.status(400).json({ error: "service must be 'burn' or 'lock_supply'" });
      return;
    }
    res.json(built);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "signing/build failed");
    res.status(400).json({ error: message });
  }
});

router.post("/signing/submit", async (req, res) => {
  try {
    const { orderId, signature } = req.body as { orderId?: string; signature?: string };
    if (!orderId || !signature || !orderStore || !onFulfilled) {
      res.status(400).json({ error: "orderId and signature are required" });
      return;
    }
    const order = await orderStore.get(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (order.service !== "burn" && order.service !== "lock_supply") {
      res.status(400).json({ error: "This order does not use wallet signing" });
      return;
    }
    if (order.status === "fulfilled") {
      res.json({ ok: true, alreadyFulfilled: true, link: order.txLink });
      return;
    }

    // Verify the signature is a real, successful on-chain transaction.
    const verified = await verifySignedTransaction(signature);
    if (!verified.ok) {
      res.status(400).json({ error: `Transaction failed on-chain: ${verified.err}` });
      return;
    }

    await onFulfilled(order.id, verified.signature, verified.link);
    res.json({ ok: true, link: verified.link });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "signing/submit failed");
    res.status(400).json({ error: message });
  }
});

export default router;
