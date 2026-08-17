/**
 * Central environment validation — fail fast with clear messages.
 *
 * Every setting the process reads flows through here, so a missing or
 * malformed variable is caught at boot with an actionable error instead of
 * surfacing later as "Token not found" or a silent bot outage.
 */

export interface Env {
  nodeEnv: "production" | "development" | "test";
  logLevel: string;
  port: number;

  // Telegram
  /** Present in production (validated above); may be absent in dev/test. */
  telegramBotToken: string | undefined;
  adminChatId: string | undefined;
  /** When set, the bot runs in webhook mode instead of long polling. */
  webhookUrl: string | undefined;
  /** Random secret path segment for the webhook URL (obscures the endpoint). */
  webhookSecretPath: string | undefined;
  /** Optional X-Telegram-Bot-Api-Secret-Token sent by Telegram. */
  webhookSecretToken: string | undefined;

  // Persistence (optional — falls back to file/in-memory stores)
  databaseUrl: string | undefined;
  /** Directory for file-backed stores (orders) when no Postgres. */
  dataDir: string;

  // Keep-alive
  keepAliveUrl: string | undefined;
  keepAliveIntervalMs: number;

  // Lookup engine tuning
  birdeyeApiKey: string | undefined;
  coinGeckoApiKey: string | undefined;
  moralisApiKey: string | undefined;
  lookupCacheTtlMs: number;
  lookupCacheMaxEntries: number;

  // ── Payments (receiving wallets + on-chain verification) ──────────────────
  paymentWallets: {
    sol: string | undefined;
    evm: string | undefined; // used for ETH (Ethereum & Base) and BNB
    ton: string | undefined;
  };
  etherscanApiKey: string | undefined;
  bscscanApiKey: string | undefined;
  basescanApiKey: string | undefined;
  toncenterApiKey: string | undefined;
  solanaRpcUrl: string;
  /** Payment window for orders, in hours. */
  orderExpiryHours: number;
  /** How often the watcher polls chains for deposits. */
  paymentPollIntervalMs: number;
  /** DEX Update service price (display + native conversion). */
  dexUpdateUsd: number;
  dexUpdatePrices: { sol: number; eth: number; bnb: number; ton: number };

  // ── Wallet signing (real lock/burn transactions) ───────────────────────────
  /** Public base URL of this service — used to build wallet-connect links. */
  appUrl: string | undefined;
  /** Dedicated wallet that receives locked tokens (custody lock). */
  lockVaultWallet: string | undefined;
}

function fail(message: string): never {
  // No logger here on purpose: the logger may itself depend on env. Plain
  // stderr is the most reliable channel at boot time.
  process.stderr.write(`\n✖ Configuration error:\n   ${message}\n\n`);
  process.exit(1);
}

function readStr(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v.trim() !== "" ? v.trim() : undefined;
}

function readPort(name = "PORT"): number {
  const raw = readStr(name);
  if (!raw) fail(`Missing required env var "${name}" (the HTTP port the server listens on).`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`Env var "${name}" must be an integer between 1 and 65535, got "${raw}".`);
  }
  return port;
}

function readNum(name: string, fallback: number, min: number, max: number): number {
  const raw = readStr(name);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    fail(`Env var "${name}" must be a number between ${min} and ${max}, got "${raw}".`);
  }
  return n;
}

export function loadEnv(): Env {
  const nodeEnvRaw = readStr("NODE_ENV") ?? "development";
  const nodeEnv =
    nodeEnvRaw === "production" || nodeEnvRaw === "development" || nodeEnvRaw === "test"
      ? nodeEnvRaw
      : "development";

  const port = readPort();

  // Fail fast: the Telegram bot IS the product. Running without a token is
  // only allowed in development/test so the HTTP health surface can be tested.
  const telegramBotToken = readStr("TELEGRAM_BOT_TOKEN");
  if (!telegramBotToken && nodeEnv === "production") {
    fail(
      "Missing required env var TELEGRAM_BOT_TOKEN. Get one from @BotFather " +
        "(https://core.telegram.org/bots/tutorial) and add it to your platform's env vars.",
    );
  }

  const webhookUrl = readStr("WEBHOOK_URL");
  const webhookSecretPath = readStr("WEBHOOK_SECRET_PATH") ?? "telegram";
  const webhookSecretToken = readStr("WEBHOOK_SECRET_TOKEN");

  if (!webhookUrl && webhookSecretToken) {
    fail("WEBHOOK_SECRET_TOKEN is set but WEBHOOK_URL is not — webhook mode is disabled.");
  }

  const env: Env = {
    nodeEnv,
    logLevel: readStr("LOG_LEVEL") ?? (nodeEnv === "production" ? "info" : "debug"),
    port,
    telegramBotToken,
    adminChatId: readStr("ADMIN_CHAT_ID"),
    webhookUrl,
    webhookSecretPath,
    webhookSecretToken,
    databaseUrl: readStr("DATABASE_URL"),
    dataDir: readStr("DATA_DIR") ?? "./data",
    keepAliveUrl: readStr("KEEPALIVE_URL"),
    keepAliveIntervalMs: readNum("KEEPALIVE_INTERVAL_MS", 300_000, 30_000, 86_400_000),
    birdeyeApiKey: readStr("BIRDEYE_API_KEY"),
    coinGeckoApiKey: readStr("COINGECKO_API_KEY"),
    moralisApiKey: readStr("MORALIS_API_KEY"),
    lookupCacheTtlMs: readNum("LOOKUP_CACHE_TTL_MS", 300_000, 0, 86_400_000),
    lookupCacheMaxEntries: readNum("LOOKUP_CACHE_MAX_ENTRIES", 1000, 0, 1_000_000),

    paymentWallets: {
      sol: readStr("PAYMENT_WALLET_SOL"),
      evm: readStr("PAYMENT_WALLET_EVM"),
      ton: readStr("PAYMENT_WALLET_TON"),
    },
    etherscanApiKey: readStr("ETHERSCAN_API_KEY"),
    bscscanApiKey: readStr("BSCSCAN_API_KEY"),
    basescanApiKey: readStr("BASESCAN_API_KEY"),
    toncenterApiKey: readStr("TONCENTER_API_KEY"),
    solanaRpcUrl: readStr("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com",
    orderExpiryHours: readNum("ORDER_EXPIRY_HOURS", 24, 1, 720),
    paymentPollIntervalMs: readNum("PAYMENT_POLL_INTERVAL_MS", 45_000, 15_000, 3_600_000),
    dexUpdateUsd: readNum("DEX_UPDATE_PRICE_USD", 299, 1, 1_000_000),
    dexUpdatePrices: {
      sol: readNum("DEX_UPDATE_SOL", 2.0, 0.000001, 1_000_000),
      eth: readNum("DEX_UPDATE_ETH", 0.1, 0.000001, 1_000_000),
      bnb: readNum("DEX_UPDATE_BNB", 0.5, 0.000001, 1_000_000),
      ton: readNum("DEX_UPDATE_TON", 75, 0.000001, 1_000_000_000),
    },
    appUrl: readStr("APP_URL"),
    lockVaultWallet: readStr("LOCK_VAULT_WALLET"),
  };

  if (nodeEnv === "production") {
    const missingWallets = Object.entries(env.paymentWallets)
      .filter(([, v]) => !v)
      .map(([k]) => k.toUpperCase());
    if (missingWallets.length) {
      process.stderr.write(
        `\n⚠ Warning: payment wallets not configured: ${missingWallets.join(", ")}.\n` +
          `  Paid service flows will be disabled until they are set (PAYMENT_WALLET_SOL / _EVM / _TON).\n\n`,
      );
    }
  }

  return env;
}
