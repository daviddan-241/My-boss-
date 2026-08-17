/**
 * API server + Telegram bot entrypoint.
 *
 * Responsibilities:
 *   - Validate all env vars at boot and fail fast with actionable messages
 *   - Boot Express (health endpoints, webhook route)
 *   - Start the Telegram bot (webhook mode if WEBHOOK_URL is set, else polling)
 *   - Start the on-chain payment watcher (verifies real deposits per order)
 *   - Keep-alive self-ping when KEEPALIVE_URL is configured
 *   - Graceful shutdown on SIGTERM/SIGINT
 */

import app from "./app";
import { logger } from "./lib/logger";
import { loadEnv } from "./lib/env";
import { createSessionStore } from "./lib/sessionStore";
import { createOrderStore } from "./lib/orderStore";
import { PaymentWatcher } from "./lib/paymentVerifier";
import { setTelegramUpdateHandler } from "./routes/telegram";
import { startTelegramBot, type BotHandle } from "./lib/telegramBot";
import { setBotStatus, setServerStartedAt } from "./lib/statusRegistry";

async function main(): Promise<void> {
  const serverStartedAt = new Date();
  setServerStartedAt(serverStartedAt);

  // 1. Fail fast on bad configuration.
  const env = loadEnv();
  logger.info(
    {
      nodeEnv: env.nodeEnv,
      port: env.port,
      botMode: env.webhookUrl ? "webhook" : "polling",
      database: env.databaseUrl ? "postgres" : env.dataDir ? "file" : "memory",
      wallets: Object.fromEntries(
        Object.entries(env.paymentWallets).map(([k, v]) => [k, v ? "set" : "missing"]),
      ),
    },
    "Boot: configuration validated",
  );

  // 2. Stores: sessions + orders (Postgres when DATABASE_URL is set).
  const store = await createSessionStore(env.databaseUrl);
  const orderStore = await createOrderStore(env.databaseUrl, env.dataDir);

  // 3. HTTP server.
  const server = app.listen(env.port, () => {
    logger.info({ port: env.port }, "Server listening");
  });

  // 4. Telegram bot.
  let botHandle: BotHandle | null = null;
  if (env.telegramBotToken) {
    botHandle = startTelegramBot(env.telegramBotToken, {
      mode: env.webhookUrl ? "webhook" : "polling",
      webhookUrl: env.webhookUrl,
      webhookSecretPath: env.webhookSecretPath,
      webhookSecretToken: env.webhookSecretToken,
      adminChatId: env.adminChatId,
      store,
      orderStore,
      payment: {
        wallets: env.paymentWallets,
        dexUpdateUsd: env.dexUpdateUsd,
        dexUpdatePrices: env.dexUpdatePrices,
        orderExpiryHours: env.orderExpiryHours,
      },
    });
    setBotStatus({ enabled: true });
    if (env.webhookUrl) {
      setTelegramUpdateHandler(botHandle.processUpdate, env.webhookSecretToken);
    }

    // 5. On-chain payment watcher: verifies real deposits for open orders.
    const watcher = new PaymentWatcher(
      orderStore,
      {
        etherscan: env.etherscanApiKey,
        bscscan: env.bscscanApiKey,
        basescan: env.basescanApiKey,
        toncenter: env.toncenterApiKey,
        solanaRpcUrl: env.solanaRpcUrl,
      },
      {
        onPaid: (order, deposit) => botHandle!.notifyOrderPaid(order, deposit),
        onExpired: (order) => botHandle!.notifyOrderExpired(order),
      },
      env.paymentPollIntervalMs,
    );
    watcher.start();
    watchers.push(watcher);
  } else {
    logger.warn(
      "TELEGRAM_BOT_TOKEN not set — running in development mode without the bot. Set it to enable the bot.",
    );
  }

  // 6. Keep-alive self-ping (see DEPLOY.md — external cron pings are the real
  //    keep-alive for sleeping free tiers).
  let keepAliveTimer: NodeJS.Timeout | null = null;
  if (env.keepAliveUrl) {
    keepAliveTimer = setInterval(() => {
      fetch(env.keepAliveUrl!)
        .then((r) => {
          if (!r.ok) logger.warn({ status: r.status }, "Keep-alive ping failed");
        })
        .catch((err) => logger.warn({ err }, "Keep-alive ping error"));
    }, env.keepAliveIntervalMs);
    keepAliveTimer.unref();
    logger.info({ url: env.keepAliveUrl, intervalMs: env.keepAliveIntervalMs }, "Keep-alive enabled");
  }

  // 7. Graceful shutdown.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down gracefully");

    if (keepAliveTimer) clearInterval(keepAliveTimer);
    for (const w of watchers) w.stop();

    if (botHandle) await botHandle.stop().catch((err) => logger.warn({ err }, "Bot stop error"));

    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        logger.warn("HTTP server drain timed out — forcing exit");
        resolve();
      }, 5_000);
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
    });

    await orderStore.close().catch((err) => logger.warn({ err }, "Order store close error"));
    await store.close().catch((err) => logger.warn({ err }, "Session store close error"));

    logger.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const watchers: PaymentWatcher[] = [];

main().catch((err) => {
  logger.error({ err }, "Fatal boot error");
  process.exit(1);
});
