import app from "./app";
import { logger } from "./lib/logger";
import { startTelegramBot } from "./lib/telegramBot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  if (botToken) {
    try {
      startTelegramBot(botToken);
      logger.info("Telegram bot started");
    } catch (e) {
      logger.error({ err: e }, "Failed to start Telegram bot");
    }
  } else {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot is disabled");
  }
});
