/**
 * API server + Telegram bot entrypoint.
 *
 * Responsibilities:
 *   - Validate all env vars at boot and fail fast with actionable messages
 *   - Boot Express (health endpoints, webhook route, signing webapp)
 *   - Start the Telegram bot (webhook mode if WEBHOOK_URL is set, else polling)
 *   - Start the on-chain payment watcher (verifies real deposits per order)
 *   - Wire the wallet-signing webapp (real lock/burn transactions)
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
import { setSigningDeps } from "./routes/signing";
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
      signingApp: env.appUrl ? "enabled" : "disabled (APP_URL not set)",
      lockVault: env.lockVaultWallet ? "set" : "missing",
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
      appUrl: env.appUrl,
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
        onUnknownDeposit: (deposit, chainId, wallet) =>
          botHandle!.notifyUnknownDeposit(deposit, chainId, wallet),
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

  // 6. Wallet-signing webapp: verify signed tx on-chain → fulfill order → notify.
  setSigningDeps(orderStore, async (orderId, signature, link) => {
    const order = await orderStore.get(orderId);
    if (!order) return;
    const updated = await orderStore.update(order.id, {
      status: "fulfilled",
      fulfilledAt: Date.now(),
      txHash: signature,
      txLink: link,
    });
    if (updated && botHandle) {
      await botHandle.notifyOrderFulfilled(updated);
      if (env.adminChatId) {
        await botHandle.bot
          .sendMessage(
            env.adminChatId,
            `🔗 *Signed tx verified on-chain* — order \`${order.id}\` fulfilled automatically\n\n${link}`,
            { parse_mode: "Markdown" },
          )
          .catch(() => {});
      }
    }
  });

  // 7. Keep-alive self-ping. Defaults to pinging OUR OWN /api/healthz — keeps
  //    the process warm on hosts that kill idle connections. NOTE: it cannot
  //    wake a slept instance; that's what external monitors (UptimeRobot)
  //    are for on Render free.
  const keepAliveUrl = env.keepAliveUrl ?? `http://127.0.0.1:${env.port}/api/healthz`;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  keepAliveTimer = setInterval(() => {
    fetch(keepAliveUrl)
      .then((r) => {
        if (!r.ok) logger.warn({ status: r.status }, "Keep-alive ping failed");
      })
      .catch((err) => logger.warn({ err }, "Keep-alive ping error"));
  }, env.keepAliveIntervalMs);
  keepAliveTimer.unref();
  logger.info(
    { url: keepAliveUrl, intervalMs: env.keepAliveIntervalMs, external: !!env.keepAliveUrl },
    "Keep-alive enabled",
  );

  // 8. Graceful shutdown.
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
