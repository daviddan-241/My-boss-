/**
 * Telegram bot — DexScreener Boost Tracker & Token Growth Services.
 *
 * Legitimate edition with REAL rails:
 *   - Multi-source token lookup (7 data sources, EVM chain auto-detection)
 *   - Paid service flows (volume packages, DEX update/ads/trending) that end
 *     in a REAL on-chain payment order: the bot watches the blockchain and
 *     confirms payment only when the transaction actually arrives. No fake
 *     "I paid" buttons.
 *   - Persistent order lifecycle: awaiting_payment → paid → fulfilled /
 *     rejected / expired / cancelled, with order IDs, expiry windows and
 *     status updates to the user.
 *   - Admin toolkit: /orders, /order, /approve, /reject, /wallet, /status.
 *
 * Safety: this bot NEVER asks for seed phrases, private keys, or wallet
 * credentials. No legitimate service does. (Lock/burn services, if offered,
 * must be done through a proper wallet-connect signing app, never chat.)
 */

import TelegramBot from "node-telegram-bot-api";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import type { BotSession, SessionStore } from "./sessionStore.js";
import type { Order, OrderStore } from "./orderStore.js";
import { newOrderId } from "./orderStore.js";
import type { Deposit } from "./paymentVerifier.js";
import {
  CHAIN_MAP,
  detectChainFormat,
  lookupToken,
  type TokenInfo,
} from "./tokenLookup.js";
import { getStatusSnapshot, setBotStatus } from "./statusRegistry.js";

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

const IMG_WELCOME = path.join(PUBLIC_DIR, "welcome.jpeg");
const IMG_LOGO = path.join(PUBLIC_DIR, "dex-logo.jpeg");

// ─── Bot configuration ────────────────────────────────────────────────────────

export interface PaymentConfig {
  wallets: { sol?: string; evm?: string; ton?: string };
  dexUpdateUsd: number;
  dexUpdatePrices: { sol: number; eth: number; bnb: number; ton: number };
  orderExpiryHours: number;
}

export interface StartBotOptions {
  mode: "polling" | "webhook";
  webhookUrl?: string;
  webhookSecretPath?: string;
  webhookSecretToken?: string;
  adminChatId?: string;
  store: SessionStore;
  orderStore: OrderStore;
  payment: PaymentConfig;
}

export interface BotHandle {
  bot: TelegramBot;
  processUpdate: (body: unknown) => Promise<void>;
  notifyOrderPaid: (order: Order, deposit: Deposit) => Promise<void>;
  notifyOrderExpired: (order: Order) => Promise<void>;
  notifyUnknownDeposit: (deposit: Deposit, chainId: string, wallet: string) => Promise<void>;
  stop: () => Promise<void>;
}

// ─── Service catalog ──────────────────────────────────────────────────────────

interface Package {
  id: string;
  name: string;
  emoji: string;
  sol: number;
  bnb: number;
  eth: number;
  ton: number;
  volume: number;
  duration: string;
}

const PACKAGES: Package[] = [
  { id: "starter", name: "STARTER", emoji: "💎", sol: 0.5, bnb: 0.1, eth: 0.1, ton: 10, volume: 25_000, duration: "12h" },
  { id: "basic", name: "BASIC", emoji: "📦", sol: 1, bnb: 0.2, eth: 0.2, ton: 20, volume: 50_000, duration: "24h" },
  { id: "bronze", name: "BRONZE", emoji: "🥉", sol: 2.5, bnb: 0.5, eth: 0.5, ton: 50, volume: 125_000, duration: "36h" },
  { id: "premium", name: "PREMIUM", emoji: "🔥", sol: 5, bnb: 1, eth: 1, ton: 100, volume: 250_000, duration: "48h" },
  { id: "vip", name: "VIP", emoji: "💎", sol: 10, bnb: 2, eth: 2, ton: 200, volume: 500_000, duration: "72h" },
];

type Currency = "SOL" | "ETH" | "BNB" | "TON";

function currencyForChain(chainId: string): Currency {
  if (chainId === "ton") return "TON";
  if (chainId === "bsc") return "BNB";
  if (chainId === "ethereum" || chainId === "base") return "ETH";
  return "SOL";
}

function pkgPrice(pkg: Package, chainId: string): { amount: number; currency: Currency } {
  const c = currencyForChain(chainId);
  const amount = c === "TON" ? pkg.ton : c === "BNB" ? pkg.bnb : c === "ETH" ? pkg.eth : pkg.sol;
  return { amount, currency: c };
}

/** DEX Ads hourly rates + minimum hours (matches published catalog). */
function adsRateFor(chainId: string): { rate: number; minHours: number } {
  return chainId === "ethereum" || chainId === "base"
    ? { rate: 0.4, minHours: 1 }
    : { rate: 0.8, minHours: 3 };
}

/** Trending rates: top10 0.5/h (min 3h), top3 1/h (min 1h). */
function trendingRateFor(tier: "top10" | "top3"): { rate: number; minHours: number } {
  return tier === "top3" ? { rate: 1, minHours: 1 } : { rate: 0.5, minHours: 3 };
}

/** Exact amount in smallest units (wei / lamports / nanotons) as string. */
function toSmallestUnits(amount: number, currency: Currency): string {
  const decimals = currency === "SOL" ? 9 : currency === "TON" ? 9 : 18;
  const scaled = amount * 10 ** decimals;
  const rounded = Math.round(scaled);
  return String(rounded);
}

function fmtAmount(amount: number, currency: Currency): string {
  const pretty = amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(1).replace(/\.0$/, "");
  return `${pretty} ${currency}`;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/([_*`[\]])/g, "\\$1");
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function progressBar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function addrShort(a: string): string {
  if (a.length <= 16) return a;
  return `${a.slice(0, 8)}...${a.slice(-8)}`;
}

function tokenCard(t: TokenInfo): string {
  const mc = t.marketCap ? fmtUsd(t.marketCap) : "—";
  const vol = t.volume24h ? fmtUsd(t.volume24h) : "—";
  const liq = t.liquidity ? fmtUsd(t.liquidity) : "—";
  const bc =
    t.bondingCurve != null ? `📊 Bonding Curve: ${progressBar(t.bondingCurve)} ${t.bondingCurve}%` : null;
  const src = t.sources?.length ? t.sources.join(" + ") : t.source;
  return [
    `✅ Token Found`,
    ``,
    `🎯 Token: ${esc(t.symbol)} — ${esc(t.name)}`,
    `${t.chainEmoji} Chain: ${t.chain}`,
    `📍 CA: \`${esc(t.address)}\``,
    `💰 Market Cap: ${mc}`,
    bc,
    `💧 Liquidity: ${liq}`,
    `💲 Price: ${t.price ?? "—"}`,
    `📈 24h Volume: ${vol}`,
    `🟢 Status: ${t.status}`,
    ``,
    `📡 Data sources: ${src}`,
  ]
    .filter((v): v is string => v !== null)
    .join("\n");
}

function failureText(address: string, tried: { source: string; ok: boolean; error?: string }[]): string {
  const lines = tried.map((s) => {
    const mark = s.ok ? "✅" : "❌";
    const detail = !s.ok && s.error ? ` — ${s.error}` : "";
    return `${mark} ${s.source}${detail}`;
  });
  return [
    `❌ Token not found for \`${esc(address)}\``,
    ``,
    `Sources tried:`,
    ...(lines.length ? lines : ["• (none)"]),
    ``,
    `Tips:`,
    `• Double-check the address — copy it exactly`,
    `• EVM addresses live on one chain; pick the right one if auto-detect missed it`,
    `• Brand-new tokens can take a few minutes to index`,
    `• Try /lookup with the token name or symbol instead`,
  ].join("\n");
}

const STATUS_EMOJI: Record<Order["status"], string> = {
  awaiting_payment: "⏳",
  paid: "✅",
  fulfilled: "🎉",
  rejected: "❌",
  expired: "⏰",
  cancelled: "🚫",
};

const STATUS_LABEL: Record<Order["status"], string> = {
  awaiting_payment: "Awaiting payment",
  paid: "Paid — in progress",
  fulfilled: "Completed",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
};

/** Convert a smallest-unit amount string to a human display string. */
function displayFromSmallest(amountSmallest: string, chainId: string): string {
  const decimals = chainId === "solana" || chainId === "ton" ? 9 : 18;
  const n = Number(amountSmallest) / 10 ** decimals;
  return fmtAmount(n, currencyForChain(chainId));
}

function orderCard(o: Order): string {
  const lines = [
    `🧾 Order \`${o.id}\``,
    ``,
    `📋 Service: ${o.service.replace(/_/g, " ")}${o.packageName ? ` — ${o.packageName}` : ""}`,
    `🎯 Token: ${esc(o.token.symbol)} on ${o.token.chain}`,
    `📍 CA: \`${esc(addrShort(o.token.address))}\``,
    `💵 Amount: *${fmtAmount(o.amount, o.currency)}*`,
  ];
  if (o.details) {
    for (const [k, v] of Object.entries(o.details)) lines.push(`${k}: ${esc(v)}`);
  }
  lines.push(``, `${STATUS_EMOJI[o.status]} Status: ${STATUS_LABEL[o.status]}`);
  if (o.status === "awaiting_payment") {
    lines.push(`💳 Wallet: \`${esc(o.wallet)}\``);
    const mins = Math.max(0, Math.round((o.expiresAt - Date.now()) / 60_000));
    lines.push(`⏱ Expires: in ${Math.floor(mins / 60)}h ${mins % 60}m`);
  }
  if (o.txLink) lines.push(`🔗 Tx: ${o.txLink}`);
  if (o.adminNote) lines.push(`📝 Note: ${esc(o.adminNote)}`);
  return lines.join("\n");
}

// ─── Boost feeds ──────────────────────────────────────────────────────────────

interface BoostToken {
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
  description?: string;
  url?: string;
}

async function fetchBoosts(endpoint: string): Promise<BoostToken[]> {
  const url = `https://api.dexscreener.com${endpoint}`;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.text();
      const data: unknown = JSON.parse(raw);
      if (Array.isArray(data)) return data as BoostToken[];
    } catch (err) {
      logger.warn({ err, endpoint, attempt }, "Boost feed fetch failed");
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

function formatBoostToken(t: BoostToken, rank?: number): string {
  const info = CHAIN_MAP[t.chainId] ?? { label: t.chainId, emoji: "🌐" };
  const addr = `${(t.tokenAddress ?? "").slice(0, 8)}...${(t.tokenAddress ?? "").slice(-6)}`;
  const rankStr = rank != null ? `#${rank} ` : "";
  const golden = (t.totalAmount ?? 0) >= 500 ? " 🌟" : "";
  const amount = (t.amount ?? 0).toLocaleString();
  const total = (t.totalAmount ?? 0).toLocaleString();
  return [
    `${rankStr}${info.emoji} ${addr}${golden}`,
    `🔥 Boost: ${amount} / ${total} total`,
    t.description ? `📝 ${t.description.slice(0, 80)}` : null,
    t.url ? `View on DexScreener: ${t.url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

type Btn = TelegramBot.InlineKeyboardButton;

const kb = (rows: Btn[][]): TelegramBot.InlineKeyboardMarkup => ({ inline_keyboard: rows });

/** Copy-button for a wallet address (Telegram Bot API 7.5 feature). */
function walletCopyBtn(wallet: string): Btn {
  const short = wallet.length > 24 ? `${wallet.slice(0, 12)}...${wallet.slice(-10)}` : wallet;
  return { text: `💳 ${short}`, copy_text: { text: wallet } } as unknown as Btn;
}

const KB_MAIN = () =>
  kb([
    [{ text: "🔍 Check Token", callback_data: "check_token" }],
    [
      { text: "📦 Volume Packages", callback_data: "vol_start" },
      { text: "📊 DEX Services", callback_data: "dex_menu" },
    ],
    [{ text: "📋 My Order", callback_data: "order_status" }],
    [
      { text: "📰 Latest Boosts", callback_data: "boost_latest" },
      { text: "🏆 Top Boosts", callback_data: "boost_top" },
    ],
  ]);

const KB_CANCEL = () => kb([[{ text: "❌ Cancel", callback_data: "cancel" }]]);

const KB_BACK_MAIN = () => kb([[{ text: "⬅️ Back to Main", callback_data: "back_main" }]]);

const KB_DEX_MENU = () =>
  kb([
    [{ text: "📊 DEX Update — $299", callback_data: "dex_update" }],
    [{ text: "📣 DEX Ads", callback_data: "dex_ads" }],
    [{ text: "🔥 DEX Trending", callback_data: "dex_trending" }],
    [{ text: "⬅️ Back to Main", callback_data: "back_main" }],
  ]);

const KB_TRENDING_TIER = () =>
  kb([
    [{ text: "🥉 Top 10 Trending", callback_data: "trending_top10" }],
    [{ text: "🥇 Top 3 Trending", callback_data: "trending_top3" }],
    [{ text: "❌ Cancel", callback_data: "cancel" }],
  ]);

const KB_SKIP_CANCEL = () =>
  kb([
    [{ text: "⏭ Skip", callback_data: "skip_group" }],
    [{ text: "❌ Cancel", callback_data: "cancel" }],
  ]);

const EVM_CHAIN_OPTIONS: [string, string][] = [
  ["ethereum", "Ξ Ethereum"],
  ["bsc", "⬡ BNB Chain"],
  ["base", "🔷 Base"],
  ["arbitrum", "🔷 Arbitrum"],
  ["optimism", "🔴 Optimism"],
  ["polygon", "🟪 Polygon"],
  ["avalanche", "🔺 Avalanche"],
];

const KB_EVM_CHAIN = () =>
  kb([
    ...EVM_CHAIN_OPTIONS.map(([id, label]) => [{ text: label, callback_data: `chain_${id}` }]),
    [{ text: "❌ Cancel", callback_data: "cancel" }],
  ]);

// ─── Message sending with Markdown → plain fallback ───────────────────────────

async function sendPhoto(
  bot: TelegramBot,
  chatId: number | string,
  photoPath: string,
  caption: string,
  opts: TelegramBot.SendPhotoOptions = {},
): Promise<void> {
  try {
    await bot.sendPhoto(chatId, photoPath, { caption, parse_mode: "Markdown", ...opts });
  } catch {
    try {
      await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", ...(opts as object) });
    } catch {
      await bot.sendMessage(chatId, caption.replace(/[_*`[\]]/g, ""), opts as object);
    }
  }
}

async function sendMsg(
  bot: TelegramBot,
  chatId: number | string,
  text: string,
  opts: TelegramBot.SendMessageOptions = {},
): Promise<TelegramBot.Message> {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts });
  } catch {
    return await bot.sendMessage(chatId, text.replace(/[_*`[\]]/g, ""), opts);
  }
}

/**
 * Fetch a token logo for Telegram upload (Telegram's API can't pull remote
 * URLs itself). Returns null on any failure so callers fall back to text.
 */
async function fetchImageBytes(
  url: string,
  timeoutMs = 8_000,
): Promise<{ buf: Buffer; contentType: string; ext: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return null; // cap 5MB
    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("gif")
          ? "gif"
          : "jpg";
    return { buf, contentType, ext };
  } catch {
    return null;
  }
}

/**
 * Send a token result card. When the lookup found a logo (imageUrl), the
 * card is sent as a real photo with the details as caption — this is what
 * makes results "feel real". Falls back to plain text if the image can't be
 * fetched or Telegram rejects it.
 */
async function sendTokenCard(
  bot: TelegramBot,
  chatId: number | string,
  t: TokenInfo,
  opts: TelegramBot.SendPhotoOptions = {},
): Promise<void> {
  if (t.imageUrl) {
    const img = await fetchImageBytes(t.imageUrl);
    if (img) {
      try {
        await bot.sendPhoto(chatId, img.buf, {
          caption: tokenCard(t),
          parse_mode: "Markdown",
          filename: `token.${img.ext}`,
          contentType: img.contentType,
          ...opts,
        } as unknown as TelegramBot.SendPhotoOptions);
        return;
      } catch (err) {
        logger.warn({ err }, "Photo send failed — falling back to text card");
      }
    }
  }
  await sendMsg(bot, chatId, tokenCard(t), opts as TelegramBot.SendMessageOptions);
}

// ─── Bot entry point ──────────────────────────────────────────────────────────

export function startTelegramBot(token: string, opts: StartBotOptions): BotHandle {
  const { store, orderStore, adminChatId, payment } = opts;
  const bot = new TelegramBot(token, opts.mode === "polling" ? { polling: true } : {});
  const botLog = logger.child({ module: "telegram-bot" });

  let pollErrorCount = 0;

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const msgLimiter = new SlidingWindowLimiter(12, 30_000);
  const cbLimiter = new SlidingWindowLimiter(20, 15_000);
  const pruneTimer = setInterval(() => {
    msgLimiter.prune(10 * 60_000);
    cbLimiter.prune(10 * 60_000);
  }, 5 * 60_000);
  pruneTimer.unref();

  const isAdmin = (userId: number): boolean =>
    adminChatId != null && String(userId) === String(adminChatId);

  // ── Sessions ──────────────────────────────────────────────────────────────
  async function getSession(userId: number): Promise<BotSession> {
    return (await store.get(userId)) ?? { step: "idle" };
  }

  async function setSession(userId: number, patch: Partial<BotSession>): Promise<void> {
    const current = await getSession(userId);
    await store.set(userId, { ...current, ...patch });
  }

  async function clearSession(userId: number): Promise<void> {
    await store.delete(userId);
  }

  // ── Admin notifications ───────────────────────────────────────────────────
  async function notifyAdmin(text: string, extra?: TelegramBot.InlineKeyboardMarkup): Promise<void> {
    if (!adminChatId) return;
    try {
      await bot.sendMessage(adminChatId, text, { parse_mode: "Markdown", ...(extra ? { reply_markup: extra } : {}) });
    } catch {
      try {
        await bot.sendMessage(adminChatId, text.replace(/[*_`[\]]/g, ""), extra ? { reply_markup: extra } : {});
      } catch (err) {
        botLog.warn({ err }, "Admin notification failed");
      }
    }
  }

  const adminActionKeyboard = (orderId: string) =>
    kb([
      [
        { text: "✅ Approve", callback_data: `aprv_${orderId}` },
        { text: "❌ Reject", callback_data: `rej_${orderId}` },
      ],
    ]);

  // ── Wallets ───────────────────────────────────────────────────────────────
  function walletForCurrency(currency: Currency): string | undefined {
    if (currency === "SOL") return payment.wallets.sol;
    if (currency === "TON") return payment.wallets.ton;
    return payment.wallets.evm;
  }

  // ── Main menu ──────────────────────────────────────────────────────────────
  async function sendMainMenu(chatId: number | string, userId?: number): Promise<void> {
    if (userId != null) await clearSession(userId);
    await sendPhoto(
      bot,
      chatId,
      IMG_WELCOME,
      `🦅 DexBoost — Token Growth Services\n\n🔍 Free multi-source token lookup\n📦 Volume packages on SOL • ETH • BNB • BASE • TON\n📊 DEX update, ads & trending campaigns\n\n💳 Payments are verified *on-chain* — you get a real order with an ID, and confirmation lands in this chat the moment your transaction is detected. No "I paid" buttons, no guesswork.\n\n⚠️ We will never ask for your seed phrase or private key. Anyone who does is a scammer.`,
      { reply_markup: KB_MAIN() },
    );
  }

  // ── Token verification shared step ─────────────────────────────────────────
  async function runVerify(
    chatId: number,
    userId: number,
    address: string,
    chainHint?: string,
  ): Promise<TokenInfo | null> {
    const trimmed = address.trim();
    const format = detectChainFormat(trimmed);

    const verifyMsg = await bot.sendMessage(chatId, "🔍 Checking token data ●○○");
    const frames = ["●○○", "○●○", "○○●", "○●○"];
    let animStep = 0;
    const animInterval = setInterval(() => {
      animStep += 1;
      bot
        .editMessageText(`🔍 Checking token data ${frames[animStep % frames.length]}`, {
          chat_id: chatId,
          message_id: verifyMsg.message_id,
        })
        .catch(() => {});
    }, 700);

    let result;
    try {
      result = await lookupToken(trimmed, { chainHint, autoDetectEvmChain: true });
    } finally {
      clearInterval(animInterval);
      bot.deleteMessage(chatId, verifyMsg.message_id).catch(() => {});
    }

    if (result.token) return result.token;

    if (format === "evm" && !chainHint) {
      await setSession(userId, { step: "awaiting_ca", pendingAddress: trimmed });
      await bot.sendMessage(
        chatId,
        `${failureText(trimmed, result.tried)}\n\n🔗 Or pick the chain manually:`,
        { reply_markup: KB_EVM_CHAIN() },
      );
      return null;
    }
    await bot.sendMessage(chatId, failureText(trimmed, result.tried), { reply_markup: KB_CANCEL() });
    await clearSession(userId);
    return null;
  }

  function tokenRef(t: TokenInfo): Order["token"] {
    return {
      symbol: t.symbol,
      name: t.name,
      chain: t.chain,
      chainId: t.chainId,
      address: t.address,
      dexUrl: t.dexUrl,
    };
  }

  /** Continue a flow after the token was verified. */
  async function afterVerify(
    chatId: number,
    userId: number,
    service: string,
    t: TokenInfo,
  ): Promise<void> {
    // Service flows need a real contract address (payments are verified
    // against the token's chain). Name-search results carry no CA.
    if (!detectChainFormat(t.address)) {
      await sendMsg(
        bot,
        chatId,
        `❌ I found "${t.symbol}" but not its contract address — services need the actual CA.\n\nPlease send the contract address (not the name):`,
        { reply_markup: KB_CANCEL() },
      );
      await setSession(userId, { step: "awaiting_ca", draft: { service } });
      return;
    }
    if (service === "volume") {
      await setSession(userId, {
        step: "volume_package",
        draft: { service, token: tokenRef(t) },
      });
      await sendPackageChoice(chatId, t);
    } else if (service === "dex_update") {
      await createDexUpdateOrder(chatId, userId, t);
    } else if (service === "dex_ads") {
      const { rate, minHours } = adsRateFor(t.chainId);
      await setSession(userId, {
        step: "ads_hours",
        draft: { service, token: tokenRef(t) },
      });
      await sendMsg(
        bot,
        chatId,
        `${tokenCard(t)}\n\n📣 DEX Ads — campaign duration\n\n💰 Rate: ${rate} ${currencyForChain(t.chainId)}/hour\n⏰ Minimum: ${minHours} hours\n\nHow many hours do you want the campaign to run? (enter a number)`,
        { reply_markup: KB_CANCEL() },
      );
    } else if (service === "dex_trending") {
      await setSession(userId, {
        step: "trending_hours",
        draft: { service, token: tokenRef(t) },
      });
      await sendMsg(
        bot,
        chatId,
        `${tokenCard(t)}\n\n🔥 DEX Trending — duration\n\n🥉 Top 10: 0.5 native/hour (min 3h)\n🥇 Top 3: 1 native/hour (min 1h)\n\nHow many hours do you want trending? (enter a number)`,
        { reply_markup: KB_CANCEL() },
      );
    }
  }

  // ── Volume flow ────────────────────────────────────────────────────────────
  async function sendPackageChoice(chatId: number | string, t: TokenInfo): Promise<void> {
    const currency = currencyForChain(t.chainId);
    const rows: Btn[][] = [];
    for (let i = 0; i < PACKAGES.length; i += 2) {
      const row: Btn[] = [];
      for (const pkg of PACKAGES.slice(i, i + 2)) {
        const { amount } = pkgPrice(pkg, t.chainId);
        row.push({
          text: `${pkg.emoji} ${pkg.name} — ${fmtAmount(amount, currency)}`,
          callback_data: `pkg_${pkg.id}`,
        });
      }
      rows.push(row);
    }
    rows.push([{ text: "🎯 Custom amount", callback_data: "pkg_custom" }]);
    rows.push([{ text: "❌ Cancel", callback_data: "cancel" }]);

  const menuLines = PACKAGES.map((p) => {
    const { amount } = pkgPrice(p, t.chainId);
    return `${p.emoji} ${p.name} — ${fmtAmount(amount, currency)} → ${(p.volume / 1000).toFixed(0)}K volume (${p.duration})`;
  });
  await sendMsg(
    bot,
    chatId,
    `${tokenCard(t)}\n\n📦 Volume Packages (${t.chain})\n\nChoose a package — prices in ${currency}:\n\n${menuLines.join("\n")}\n\n🎯 Custom — 50K volume per native token\n\nPick a package:`,
    { reply_markup: kb(rows) },
  );
  }

  async function createVolumeOrder(
    chatId: number,
    userId: number,
    pkg: Package | null,
    t: TokenInfo,
    customAmount?: number,
  ): Promise<void> {
    const currency = currencyForChain(t.chainId);
    const { amount } = pkg ? pkgPrice(pkg, t.chainId) : { amount: customAmount ?? 0 };
    if (!pkg && customAmount == null) return;

    const order: Order = {
      id: newOrderId(),
      userId,
      chatId,
      username: undefined,
      service: "volume",
      packageName: pkg ? pkg.name : "CUSTOM",
      token: tokenRef(t),
      amount,
      amountSmallest: toSmallestUnits(amount, currency),
      currency,
      chainId: t.chainId as Order["chainId"],
      wallet: walletForCurrency(currency) ?? "",
      status: "awaiting_payment",
      createdAt: Date.now(),
      expiresAt: Date.now() + payment.orderExpiryHours * 3_600_000,
      details: pkg
        ? { Volume: `${pkg.volume.toLocaleString()}`, Duration: pkg.duration }
        : { Volume: `~${(Math.round(amount * 50_000)).toLocaleString()}`, Duration: "Flexible" },
    };

    if (!order.wallet) {
      await sendMsg(bot, chatId, "⚠️ Payment wallet for this chain is not configured yet. Please contact support.");
      await notifyAdmin(`⚠️ Missing payment wallet for ${currency} — order ${order.id} not created.`);
      return;
    }
    await orderStore.create(order);
    await sendReceipt(chatId, order);
    await notifyAdmin(
      `🧾 *New order ${order.id}*\n\n` +
        `👤 User: \`${userId}\`\n` +
        `📦 ${order.packageName} volume — ${esc(order.token.symbol)} (${order.token.chain})\n` +
        `📍 CA: \`${order.token.address}\`\n` +
        `💵 ${fmtAmount(order.amount, order.currency)} → \`${order.wallet}\``,
      adminActionKeyboard(order.id),
    );
    await clearSession(userId);
  }

  async function createDexUpdateOrder(chatId: number, userId: number, t: TokenInfo): Promise<void> {
    const currency = currencyForChain(t.chainId);
    const amount =
      currency === "SOL"
        ? payment.dexUpdatePrices.sol
        : currency === "ETH"
          ? payment.dexUpdatePrices.eth
          : currency === "BNB"
            ? payment.dexUpdatePrices.bnb
            : payment.dexUpdatePrices.ton;

    const order: Order = {
      id: newOrderId(),
      userId,
      chatId,
      service: "dex_update",
      packageName: "DEX Update",
      token: tokenRef(t),
      amount,
      amountSmallest: toSmallestUnits(amount, currency),
      currency,
      chainId: t.chainId as Order["chainId"],
      wallet: walletForCurrency(currency) ?? "",
      status: "awaiting_payment",
      createdAt: Date.now(),
      expiresAt: Date.now() + payment.orderExpiryHours * 3_600_000,
      details: { "USD value": `$${payment.dexUpdateUsd}`, Includes: "Logo, description, links, socials" },
    };

    if (!order.wallet) {
      await sendMsg(bot, chatId, "⚠️ Payment wallet for this chain is not configured yet. Please contact support.");
      await notifyAdmin(`⚠️ Missing payment wallet for ${currency} — order ${order.id} not created.`);
      return;
    }
    await orderStore.create(order);
    await sendReceipt(chatId, order);
    await notifyAdmin(
      `🧾 *New order ${order.id}*\n\n` +
        `👤 User: \`${userId}\`\n` +
        `📊 DEX Update ($${payment.dexUpdateUsd}) — ${esc(order.token.symbol)} (${order.token.chain})\n` +
        `📍 CA: \`${order.token.address}\`\n` +
        `💵 ${fmtAmount(order.amount, order.currency)} → \`${order.wallet}\``,
      adminActionKeyboard(order.id),
    );
    await clearSession(userId);
  }

  async function createAdsOrder(chatId: number, userId: number, t: TokenInfo, hours: number, group: string): Promise<void> {
    const currency = currencyForChain(t.chainId);
    const { rate } = adsRateFor(t.chainId);
    const amount = Math.round(hours * rate * 10) / 10;

    const order: Order = {
      id: newOrderId(),
      userId,
      chatId,
      service: "dex_ads",
      packageName: "DEX Ads",
      token: tokenRef(t),
      amount,
      amountSmallest: toSmallestUnits(amount, currency),
      currency,
      chainId: t.chainId as Order["chainId"],
      wallet: walletForCurrency(currency) ?? "",
      status: "awaiting_payment",
      createdAt: Date.now(),
      expiresAt: Date.now() + payment.orderExpiryHours * 3_600_000,
      details: { Hours: String(hours), Rate: `${rate} ${currency}/h`, Group: group },
    };

    if (!order.wallet) {
      await sendMsg(bot, chatId, "⚠️ Payment wallet for this chain is not configured yet. Please contact support.");
      await notifyAdmin(`⚠️ Missing payment wallet for ${currency} — order ${order.id} not created.`);
      return;
    }
    await orderStore.create(order);
    await sendReceipt(chatId, order);
    await notifyAdmin(
      `🧾 *New order ${order.id}*\n\n` +
        `👤 User: \`${userId}\`\n` +
        `📣 DEX Ads ${hours}h — ${esc(order.token.symbol)} (${order.token.chain})\n` +
        `💬 Group: ${esc(group)}\n` +
        `💵 ${fmtAmount(order.amount, order.currency)} → \`${order.wallet}\``,
      adminActionKeyboard(order.id),
    );
    await clearSession(userId);
  }

  async function createTrendingOrder(
    chatId: number,
    userId: number,
    t: TokenInfo,
    hours: number,
    tier: "top10" | "top3",
    group: string,
  ): Promise<void> {
    const currency = currencyForChain(t.chainId);
    const { rate } = trendingRateFor(tier);
    const amount = Math.round(hours * rate * 10) / 10;

    const order: Order = {
      id: newOrderId(),
      userId,
      chatId,
      service: "dex_trending",
      packageName: tier === "top3" ? "Top 3 Trending" : "Top 10 Trending",
      token: tokenRef(t),
      amount,
      amountSmallest: toSmallestUnits(amount, currency),
      currency,
      chainId: t.chainId as Order["chainId"],
      wallet: walletForCurrency(currency) ?? "",
      status: "awaiting_payment",
      createdAt: Date.now(),
      expiresAt: Date.now() + payment.orderExpiryHours * 3_600_000,
      details: { Hours: String(hours), Position: tier === "top3" ? "Top 3" : "Top 10", Group: group },
    };

    if (!order.wallet) {
      await sendMsg(bot, chatId, "⚠️ Payment wallet for this chain is not configured yet. Please contact support.");
      await notifyAdmin(`⚠️ Missing payment wallet for ${currency} — order ${order.id} not created.`);
      return;
    }
    await orderStore.create(order);
    await sendReceipt(chatId, order);
    await notifyAdmin(
      `🧾 *New order ${order.id}*\n\n` +
        `👤 User: \`${userId}\`\n` +
        `🔥 ${order.packageName} ${hours}h — ${esc(order.token.symbol)} (${order.token.chain})\n` +
        `💬 Group: ${esc(group)}\n` +
        `💵 ${fmtAmount(order.amount, order.currency)} → \`${order.wallet}\``,
      adminActionKeyboard(order.id),
    );
    await clearSession(userId);
  }

  async function sendReceipt(chatId: number | string, o: Order): Promise<void> {
    const receipt = [
      `🧾 *Order ${o.id}*`,
      ``,
      `📋 Service: ${o.service.replace(/_/g, " ")}${o.packageName ? ` — ${o.packageName}` : ""}`,
      `🎯 Token: ${esc(o.token.symbol)} on ${o.token.chain}`,
    ];
    if (o.details) {
      for (const [k, v] of Object.entries(o.details)) receipt.push(`${k}: ${esc(v)}`);
    }
    receipt.push(
      ``,
      `💵 Amount: *${fmtAmount(o.amount, o.currency)}*`,
      ``,
      `Send exactly *${fmtAmount(o.amount, o.currency)}* to:`,
      `\`${o.wallet}\``,
      ``,
      `⏱ Payment window: ${payment.orderExpiryHours}h`,
      `⚡ Payment is detected automatically on-chain — you'll get confirmation right here. No need to press anything.`,
    );
    await sendMsg(
      bot,
      chatId,
      receipt.join("\n"),
      {
        reply_markup: kb([
          [walletCopyBtn(o.wallet)],
          [
            { text: "📋 Check Status", callback_data: "order_status" },
            { text: "❌ Cancel Order", callback_data: "cancel_order" },
          ],
        ]),
      },
    );
  }

  // ── Payment notifications ──────────────────────────────────────────────────
  async function notifyOrderPaid(o: Order, deposit: Deposit): Promise<void> {
    await sendMsg(
      bot,
      o.chatId,
      `🎉 *Payment received!*\n\n🧾 Order \`${o.id}\`\n💵 ${fmtAmount(o.amount, o.currency)} confirmed on-chain.\n${deposit.link ? `🔗 Tx: ${deposit.link}\n` : ""}\nOur team has been notified and your order is now being processed. You'll get a message here as soon as it's completed.`,
    );
    await notifyAdmin(
      `💰 *PAYMENT CONFIRMED* — order ${o.id}\n\n` +
        `👤 User: \`${o.userId}\`\n` +
        `📋 ${o.service}${o.packageName ? ` — ${o.packageName}` : ""} · ${esc(o.token.symbol)} (${o.token.chain})\n` +
        `💵 ${fmtAmount(o.amount, o.currency)}\n` +
        `🔗 ${deposit.link ?? o.txLink ?? "—"}`,
      adminActionKeyboard(o.id),
    );
  }

  async function notifyOrderExpired(o: Order): Promise<void> {
    await sendMsg(
      bot,
      o.chatId,
      `⏰ Order \`${o.id}\` expired — no payment was detected within the ${payment.orderExpiryHours}h window, so it was closed automatically.\n\nStart a new order anytime.`,
      { reply_markup: KB_BACK_MAIN() },
    );
    await notifyAdmin(`⏰ Order ${o.id} expired (${fmtAmount(o.amount, o.currency)}, user ${o.userId}).`);
  }

  async function notifyOrderFulfilled(o: Order): Promise<void> {
    await sendMsg(
      bot,
      o.chatId,
      `🎉 *Order ${o.id} completed!*\n\n${o.packageName ? `${esc(o.packageName)} — ` : ""}${esc(o.token.symbol)} on ${o.token.chain}\n\nThanks for using DexBoost! Start another order anytime.`,
      { reply_markup: KB_BACK_MAIN() },
    );
  }

  async function notifyOrderRejected(o: Order, reason?: string): Promise<void> {
    await sendMsg(
      bot,
      o.chatId,
      `❌ Order \`${o.id}\` was rejected by our team${reason ? `:\n📝 ${esc(reason)}` : "."}\n\nIf you believe this is a mistake, please contact support.`,
      { reply_markup: KB_BACK_MAIN() },
    );
  }

  // ── Order status helpers ───────────────────────────────────────────────────
  async function sendUserOrderStatus(chatId: number | string, userId: number): Promise<void> {
    const orders = await orderStore.listForUser(userId, 1);
    if (!orders.length) {
      await sendMsg(bot, chatId, "📋 You don't have any orders yet.\n\nStart one from the main menu:", {
        reply_markup: KB_BACK_MAIN(),
      });
      return;
    }
    await sendMsg(bot, chatId, orderCard(orders[0]), { reply_markup: KB_BACK_MAIN() });
  }

  // ── Boost feed bodies ──────────────────────────────────────────────────────
  async function sendBoostFeed(
    chatId: number,
    endpoint: string,
    title: string,
    filterGolden: boolean,
  ): Promise<void> {
    const loading = await bot.sendMessage(chatId, "⏳ Fetching boosts...");
    const tokens = await fetchBoosts(endpoint);
    bot.deleteMessage(chatId, loading.message_id).catch(() => {});
    const list = filterGolden ? tokens.filter((t) => (t.totalAmount ?? 0) >= 500) : tokens;

    if (!list.length) {
      await bot.sendMessage(
        chatId,
        filterGolden
          ? "🌟 No Golden Ticker tokens right now."
          : "❌ Could not fetch boost data. Try again in a minute.",
        { reply_markup: KB_BACK_MAIN() },
      );
      return;
    }
    await bot.sendMessage(chatId, `${title}${filterGolden ? ` (${list.length})` : ""}`);
    for (let i = 0; i < Math.min(list.length, 10); i += 5) {
      const chunk = list
        .slice(i, i + 5)
        .map((t, j) => formatBoostToken(t, i + j + 1))
        .join("\n\n───────────\n\n");
      await bot.sendMessage(chatId, chunk, { disable_web_page_preview: true });
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  bot.setMyCommands([
    { command: "start", description: "🏠 Main menu" },
    { command: "lookup", description: "🔍 Look up a token (address or name)" },
    { command: "order", description: "📋 Your latest order status" },
    { command: "latest", description: "📰 Latest boosted tokens" },
    { command: "top", description: "🏆 Top boosted tokens" },
    { command: "golden", description: "🌟 Golden Ticker tokens" },
    { command: "chains", description: "🌐 Supported chains" },
    { command: "help", description: "❓ Help" },
    { command: "cancel", description: "❌ Cancel current action" },
  ]).catch(() => {});

  bot.onText(/^\/start/, async (msg) => {
    const userId = msg.from?.id ?? msg.chat.id;
    botLog.info({ userId }, "User started bot");

    // Real admin visibility: every new user is reported to the operator.
    const from = msg.from;
    const fullName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "—";
    const username = from?.username ? `@${from.username}` : "—";
    await notifyAdmin(
      `👤 *New user*\n\n` +
        `🆔 ID: \`${userId}\`\n` +
        `👤 Name: ${esc(fullName)}\n` +
        `🔖 Username: ${esc(username)}\n` +
        `🌐 Language: ${from?.language_code ?? "—"}\n` +
        `📅 ${new Date().toUTCString()}`,
    );

    await sendMainMenu(msg.chat.id, userId);
  });

  bot.onText(/^\/lookup(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    const userId = msg.from?.id ?? msg.chat.id;
    const arg = match?.[1]?.trim();
    if (arg) {
      const t = await runVerify(msg.chat.id, userId, arg);
      if (t) await sendTokenCard(bot, msg.chat.id, t, { reply_markup: KB_BACK_MAIN() });
    } else {
      await setSession(userId, { step: "awaiting_ca" });
      await sendMsg(
        bot,
        msg.chat.id,
        `🔍 Send me a token contract address — or a token name / symbol to search.\n\nFormats:\n• Solana: 32–44 Base58 chars\n• EVM: 0x + 40 hex\n• TON: EQ/UQ + 46 chars`,
        { reply_markup: KB_CANCEL() },
      );
    }
  });

  bot.onText(/^\/order/, async (msg) => {
    await sendUserOrderStatus(msg.chat.id, msg.from?.id ?? msg.chat.id);
  });

  bot.onText(/^\/cancel/, async (msg) => {
    await clearSession(msg.from?.id ?? msg.chat.id);
    await sendMainMenu(msg.chat.id);
  });

  bot.onText(/^\/help/, async (msg) => {
    await sendMsg(
      bot,
      msg.chat.id,
      `🦅 DexBoost — Help\n\n/start — 🏠 Main menu\n/lookup <CA or name> — 🔍 Token lookup (multi-source)\n/order — 📋 Your latest order status\n/latest · /top · /golden — 📰 DexScreener boost feeds\n/chains — 🌐 Supported chains\n/cancel — ❌ Cancel current action\n\n💳 Payments are verified on-chain. Orders are valid for ${payment.orderExpiryHours}h.\n\n⚠️ This bot never asks for seed phrases, private keys, or passwords. No legitimate service does — never share them with anyone.`,
      { reply_markup: KB_BACK_MAIN() },
    );
  });

  bot.onText(/^\/chains/, async (msg) => {
    await sendMsg(
      bot,
      msg.chat.id,
      `🦅 DexBoost — Chains\n\n⊙ Solana — 32–44 Base58 chars\nΞ Ethereum — 0x + 40 hex\n⬡ BNB Chain — 0x + 40 hex\n🔷 Base — 0x + 40 hex\n💎 TON — EQ/UQ + 46 chars\n\nEVM addresses are auto-detected across major networks.`,
      { reply_markup: KB_BACK_MAIN() },
    );
  });

  bot.onText(/^\/latest/, async (msg) => {
    await sendBoostFeed(msg.chat.id, "/token-boosts/latest/v1", "📰 Latest Boosted Tokens", false);
  });

  bot.onText(/^\/top/, async (msg) => {
    await sendBoostFeed(msg.chat.id, "/token-boosts/top/v1", "🏆 Top Boosted Tokens", false);
  });

  bot.onText(/^\/golden/, async (msg) => {
    await sendBoostFeed(msg.chat.id, "/token-boosts/top/v1", "🌟 Golden Ticker Tokens", true);
  });

  // ── Admin commands ─────────────────────────────────────────────────────────
  bot.onText(/^\/status/, async (msg) => {
    const userId = msg.from?.id ?? msg.chat.id;
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, "⛔ Admin only.");
      return;
    }
    const snap = getStatusSnapshot();
    const srcLines = Object.entries(snap.lookups.sources)
      .map(([s, v]) => `• ${s}: ${v.ok} ok / ${v.fail} fail (avg ${Math.round(v.avgMs)}ms)`)
      .join("\n");
    const actives = (await orderStore.listByStatus("awaiting_payment")).length;
    await sendMsg(
      bot,
      msg.chat.id,
      `📊 Bot Status\n\n` +
        `⚙️ Mode: ${snap.bot.mode} (bot ${snap.bot.enabled ? "enabled" : "disabled"})\n` +
        `⏱ Uptime: ${Math.floor(snap.server.uptimeSec / 60)}m ${snap.server.uptimeSec % 60}s\n` +
        `💾 Sessions: ${snap.sessions}\n` +
        `🧾 Open orders: ${actives}\n` +
        `🔍 Lookups: ${snap.lookups.total} total · ${snap.lookups.cacheHits} cache hits · ${snap.lookups.failures} failed\n` +
        `🗄 Cache entries: ${snap.lookups.cacheSize}\n\n` +
        `Sources:\n${srcLines || "• (none yet)"}\n\n` +
        `🧠 Memory RSS: ${snap.server.memoryRssMb} MB · Node ${snap.server.nodeVersion}`,
      { reply_markup: KB_BACK_MAIN() },
    );
  });

  bot.onText(/^\/orders/, async (msg) => {
    const userId = msg.from?.id ?? msg.chat.id;
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, "⛔ Admin only.");
      return;
    }
    const orders = await orderStore.listRecent(10);
    if (!orders.length) {
      await bot.sendMessage(msg.chat.id, "No orders yet.");
      return;
    }
    const lines = orders.map(
      (o) =>
        `${STATUS_EMOJI[o.status]} \`${o.id}\` · ${o.service.replace(/_/g, " ")}${o.packageName ? ` ${o.packageName}` : ""} · ${fmtAmount(o.amount, o.currency)} · user ${o.userId}`,
    );
    await sendMsg(bot, msg.chat.id, `🧾 Recent orders\n\n${lines.join("\n")}`);
  });

  bot.onText(/^\/order(?:@\w+)?\s+(\S+)/, async (msg, match) => {
    const userId = msg.from?.id ?? msg.chat.id;
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, "⛔ Admin only.");
      return;
    }
    const o = await orderStore.get(match?.[1] ?? "");
    if (!o) {
      await bot.sendMessage(msg.chat.id, "Order not found.");
      return;
    }
    await sendMsg(bot, msg.chat.id, `${orderCard(o)}\n\nUser: \`${o.userId}\``, {
      reply_markup: adminActionKeyboard(o.id),
    });
  });

  bot.onText(/^\/approve(?:@\w+)?\s+(\S+)/, async (msg, match) => {
    const userId = msg.from?.id ?? msg.chat.id;
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, "⛔ Admin only.");
      return;
    }
    const o = await orderStore.get(match?.[1] ?? "");
    if (!o) {
      await bot.sendMessage(msg.chat.id, "Order not found.");
      return;
    }
    if (o.status !== "paid") {
      await bot.sendMessage(msg.chat.id, `Cannot approve — order is "${o.status}".`);
      return;
    }
    const updated = await orderStore.update(o.id, { status: "fulfilled", fulfilledAt: Date.now() });
    if (updated) await notifyOrderFulfilled(updated);
    await bot.sendMessage(msg.chat.id, `✅ Order ${o.id} marked completed — user notified.`);
  });

  bot.onText(/^\/reject(?:@\w+)?\s+(\S+)(?:\s+(.+))?/, async (msg, match) => {
    const userId = msg.from?.id ?? msg.chat.id;
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, "⛔ Admin only.");
      return;
    }
    const o = await orderStore.get(match?.[1] ?? "");
    if (!o) {
      await bot.sendMessage(msg.chat.id, "Order not found.");
      return;
    }
    if (o.status === "fulfilled" || o.status === "rejected") {
      await bot.sendMessage(msg.chat.id, `Cannot reject — order is "${o.status}".`);
      return;
    }
    const reason = match?.[2]?.trim();
    const updated = await orderStore.update(o.id, {
      status: "rejected",
      adminNote: reason || "Rejected by admin",
    });
    if (updated) await notifyOrderRejected(updated, reason);
    await bot.sendMessage(msg.chat.id, `❌ Order ${o.id} rejected — user notified.`);
  });

  bot.onText(/^\/wallet/, async (msg) => {
    const userId = msg.from?.id ?? msg.chat.id;
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, "⛔ Admin only.");
      return;
    }
    await sendMsg(
      bot,
      msg.chat.id,
      `💳 Configured payment wallets\n\n` +
        `⊙ SOL: \`${payment.wallets.sol ?? "NOT SET"}\`\n` +
        `Ξ ETH/BNB (EVM): \`${payment.wallets.evm ?? "NOT SET"}\`\n` +
        `💎 TON: \`${payment.wallets.ton ?? "NOT SET"}\`\n\n` +
        `📊 DEX Update: $${payment.dexUpdateUsd} → ${payment.dexUpdatePrices.sol} SOL / ${payment.dexUpdatePrices.eth} ETH / ${payment.dexUpdatePrices.bnb} BNB / ${payment.dexUpdatePrices.ton} TON`,
    );
  });

  // ── Free-text messages (state machine) ─────────────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;

    if (
      !msgLimiter.allow(`m:${userId}`, () => {
        bot.sendMessage(chatId, "⚠️ You're sending messages too fast — please slow down.").catch(() => {});
      })
    ) {
      return;
    }

    const session = await getSession(userId);
    const draft = session.draft ?? {};
    const service = typeof draft.service === "string" ? draft.service : undefined;
    const draftToken = draft.token as Order["token"] | undefined;

    // Flow step: contract address (all services start here)
    if (session.step === "awaiting_ca" && service) {
      const t = await runVerify(chatId, userId, msg.text, session.chainHint);
      if (t) await afterVerify(chatId, userId, service, t);
      return;
    }

    // Volume: custom amount
    if (session.step === "custom_amount" && draftToken) {
      const amount = parseFloat(msg.text);
      if (!Number.isFinite(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Enter a valid amount (e.g. 3.5).", { reply_markup: KB_CANCEL() });
        return;
      }
      const t: TokenInfo = { ...(draftToken as unknown as TokenInfo) };
      await createVolumeOrder(chatId, userId, null, t, amount);
      return;
    }

    // DEX Ads: hours
    if (session.step === "ads_hours" && draftToken) {
      const hours = parseInt(msg.text, 10);
      const { minHours } = adsRateFor(draftToken.chainId);
      if (!Number.isFinite(hours) || hours < minHours) {
        await bot.sendMessage(chatId, `❌ Minimum ${minHours} hours for DEX Ads. Enter a valid duration.`, {
          reply_markup: KB_CANCEL(),
        });
        return;
      }
      await setSession(userId, {
        step: "ads_group",
        draft: { ...draft, hours },
      });
      await sendMsg(
        bot,
        chatId,
        `💬 Send your Telegram community/group link so we can feature it in the campaign.\n\nExample: https://t.me/yourgroup`,
        { reply_markup: KB_SKIP_CANCEL() },
      );
      return;
    }

    // DEX Ads: group link
    if (session.step === "ads_group" && draftToken) {
      const hours = Number(draft.hours ?? 0);
      await createAdsOrder(chatId, userId, draftToken as unknown as TokenInfo, hours, msg.text.trim());
      return;
    }

    // Trending: hours
    if (session.step === "trending_hours" && draftToken) {
      const hours = parseInt(msg.text, 10);
      if (!Number.isFinite(hours) || hours < 1) {
        await bot.sendMessage(chatId, "❌ Enter a valid duration (minimum 1 hour).", {
          reply_markup: KB_CANCEL(),
        });
        return;
      }
      await setSession(userId, {
        step: "trending_tier",
        draft: { ...draft, hours },
      });
      await sendMsg(bot, chatId, "🔥 Choose your trending position:", { reply_markup: KB_TRENDING_TIER() });
      return;
    }

    // Trending: group link
    if (session.step === "trending_group" && draftToken) {
      const hours = Number(draft.hours ?? 0);
      const tier = draft.tier === "top3" ? "top3" : "top10";
      await createTrendingOrder(chatId, userId, draftToken as unknown as TokenInfo, hours, tier, msg.text.trim());
      return;
    }

    // Generic lookup shortcut (no active flow)
    if (session.step === "awaiting_ca") {
      const t = await runVerify(chatId, userId, msg.text, session.chainHint);
      if (t) await sendTokenCard(bot, chatId, t, { reply_markup: KB_BACK_MAIN() });
      return;
    }
    if (msg.text.length <= 120) {
      const t = await runVerify(chatId, userId, msg.text);
      if (t) await sendTokenCard(bot, chatId, t, { reply_markup: KB_BACK_MAIN() });
    }
  });

  // ── Callback queries ───────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    bot.answerCallbackQuery(query.id).catch(() => {});

    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    if (!chatId) return;

    if (!cbLimiter.allow(`c:${userId}`)) return;

    const data = query.data ?? "";
    const session = await getSession(userId);
    const draft = session.draft ?? {};
    const draftToken = draft.token as Order["token"] | undefined;
    const service = typeof draft.service === "string" ? draft.service : undefined;

    if (data === "back_main" || data === "cancel") {
      await clearSession(userId);
      await sendMainMenu(chatId, userId);
      return;
    }

    // ── Public actions ──────────────────────────────────────────────────────
    if (data === "check_token") {
      await setSession(userId, { step: "awaiting_ca", pendingAddress: undefined });
      await sendMsg(
        bot,
        chatId,
        `🔍 Send me a token contract address — or a token name / symbol to search.\n\nFormats:\n• Solana: 32–44 Base58 chars\n• EVM: 0x + 40 hex\n• TON: EQ/UQ + 46 chars`,
        { reply_markup: KB_CANCEL() },
      );
      return;
    }

    if (data === "vol_start") {
      await setSession(userId, { step: "awaiting_ca", draft: { service: "volume" } });
      await sendMsg(
        bot,
        chatId,
        `📦 Volume Packages — Step 1/3\n\nSend your token contract address (CA):\n\n• Solana: 32–44 Base58\n• EVM: 0x + 40 hex\n• TON: EQ/UQ + 46 chars\n\n⚡ Auto-verified against 7 data sources.`,
        { reply_markup: KB_CANCEL() },
      );
      return;
    }

    if (data === "dex_menu") {
      await sendMsg(
        bot,
        chatId,
        `📊 DEX Services\n\n📊 DEX Update — $${payment.dexUpdateUsd}\n• Logo, description, links & socials\n\n📣 DEX Ads — from 0.4 native/hour\n• Featured placement campaigns\n\n🔥 DEX Trending — from 0.5 native/hour\n• Top 10 or Top 3 positions\n\nAll orders are paid in chain-native tokens and verified on-chain.`,
        { reply_markup: KB_DEX_MENU() },
      );
      return;
    }

    if (data === "dex_update") {
      await setSession(userId, { step: "awaiting_ca", draft: { service: "dex_update" } });
      await sendMsg(
        bot,
        chatId,
        `📊 DEX Update Service — $${payment.dexUpdateUsd}\n\nSend your token contract address (CA) to start:`,
        { reply_markup: KB_CANCEL() },
      );
      return;
    }

    if (data === "dex_ads") {
      await setSession(userId, { step: "awaiting_ca", draft: { service: "dex_ads" } });
      await sendMsg(
        bot,
        chatId,
        `📣 DEX Ads Service\n\nRates:\n• SOL / BNB / TON: 0.8 native/hour (min 3h)\n• ETH / BASE: 0.4 ETH/hour (min 1h)\n\nSend your token contract address (CA) to start:`,
        { reply_markup: KB_CANCEL() },
      );
      return;
    }

    if (data === "dex_trending") {
      await setSession(userId, { step: "awaiting_ca", draft: { service: "dex_trending" } });
      await sendMsg(
        bot,
        chatId,
        `🔥 DEX Trending Service\n\n🥉 Top 10: 0.5 native/hour (min 3h)\n🥇 Top 3: 1 native/hour (min 1h)\n\nSend your token contract address (CA) to start:`,
        { reply_markup: KB_CANCEL() },
      );
      return;
    }

    if (data === "order_status") {
      await sendUserOrderStatus(chatId, userId);
      return;
    }

    if (data === "cancel_order") {
      const orders = await orderStore.listForUser(userId, 1);
      const o = orders[0];
      if (o && o.status === "awaiting_payment") {
        await orderStore.update(o.id, { status: "cancelled" });
        await bot.sendMessage(chatId, `🚫 Order \`${o.id}\` cancelled.`, { reply_markup: KB_BACK_MAIN() });
        await notifyAdmin(`🚫 Order ${o.id} cancelled by user ${userId}.`);
      } else if (o) {
        await bot.sendMessage(chatId, `Order \`${o.id}\` can't be cancelled (status: ${o.status}).`);
      }
      return;
    }

    if (data === "boost_latest") {
      await sendBoostFeed(chatId, "/token-boosts/latest/v1", "📰 Latest Boosted Tokens", false);
      return;
    }
    if (data === "boost_top") {
      await sendBoostFeed(chatId, "/token-boosts/top/v1", "🏆 Top Boosted Tokens", false);
      return;
    }

    // Package selection (volume flow)
    if (data.startsWith("pkg_") && draftToken) {
      const pkgId = data.slice(4);
      if (pkgId === "custom") {
        await setSession(userId, { step: "custom_amount", draft });
        await sendMsg(
          bot,
          chatId,
          `🎯 Custom package\n\nEnter the amount of ${currencyForChain(draftToken.chainId)} you want to spend (e.g. 3.5).\n• 50,000 volume per 1 native token`,
          { reply_markup: KB_CANCEL() },
        );
        return;
      }
      const pkg = PACKAGES.find((p) => p.id === pkgId);
      if (pkg) {
        await createVolumeOrder(chatId, userId, pkg, draftToken as unknown as TokenInfo);
      }
      return;
    }

    // Trending tier selection
    if ((data === "trending_top10" || data === "trending_top3") && draftToken) {
      const tier = data === "trending_top10" ? "top10" : "top3";
      const hours = Number(draft.hours ?? 0);
      const { minHours } = trendingRateFor(tier);
      if (hours < minHours) {
        await bot.sendMessage(
          chatId,
          `❌ Minimum ${minHours} hour(s) for ${tier === "top3" ? "Top 3" : "Top 10"} trending.`,
          { reply_markup: KB_CANCEL() },
        );
        return;
      }
      await setSession(userId, {
        step: "trending_group",
        draft: { ...draft, tier },
      });
      await sendMsg(
        bot,
        chatId,
        `💬 Send your Telegram community/group link to feature in the trending campaign.\n\nExample: https://t.me/yourgroup`,
        { reply_markup: KB_CANCEL() },
      );
      return;
    }

    // Skip group link (ads only)
    if (data === "skip_group" && session.step === "ads_group" && draftToken) {
      const hours = Number(draft.hours ?? 0);
      await createAdsOrder(chatId, userId, draftToken as unknown as TokenInfo, hours, "—");
      return;
    }

    // Manual EVM chain selection
    if (data.startsWith("chain_")) {
      const chainId = data.slice(6);
      if (session.step !== "awaiting_ca" || !session.pendingAddress) {
        await sendMainMenu(chatId, userId);
        return;
      }
      const t = await runVerify(chatId, userId, session.pendingAddress, chainId);
      if (t) {
        if (service) await afterVerify(chatId, userId, service, t);
        else await sendTokenCard(bot, chatId, t, { reply_markup: KB_BACK_MAIN() });
      }
      return;
    }

    // ── Admin actions ────────────────────────────────────────────────────────
    if (data.startsWith("aprv_") && isAdmin(userId)) {
      const orderId = data.slice(5);
      const o = await orderStore.get(orderId);
      if (!o) {
        await bot.sendMessage(chatId, "Order not found.");
        return;
      }
      if (o.status !== "paid") {
        await bot.sendMessage(chatId, `Cannot approve — order is "${o.status}".`);
        return;
      }
      const updated = await orderStore.update(o.id, { status: "fulfilled", fulfilledAt: Date.now() });
      if (updated) await notifyOrderFulfilled(updated);
      await bot.sendMessage(chatId, `✅ ${orderId} completed — user notified.`);
      return;
    }

    if (data.startsWith("rej_") && isAdmin(userId)) {
      const orderId = data.slice(4);
      const o = await orderStore.get(orderId);
      if (!o) {
        await bot.sendMessage(chatId, "Order not found.");
        return;
      }
      if (o.status === "fulfilled" || o.status === "rejected") {
        await bot.sendMessage(chatId, `Cannot reject — order is "${o.status}".`);
        return;
      }
      const updated = await orderStore.update(o.id, {
        status: "rejected",
        adminNote: "Rejected by admin",
      });
      if (updated) await notifyOrderRejected(updated);
      await bot.sendMessage(chatId, `❌ ${orderId} rejected — user notified.`);
      return;
    }
  });

  // ── Error handling & lifecycle ─────────────────────────────────────────────
  bot.on("polling_error", (err) => {
    pollErrorCount += 1;
    setBotStatus({ lastError: String(err), pollErrors: pollErrorCount });
    botLog.error({ err }, "Telegram polling error");
  });
  bot.on("webhook_error", (err) => {
    setBotStatus({ lastError: String(err) });
    botLog.error({ err }, "Telegram webhook error");
  });

  // ── Webhook setup ──────────────────────────────────────────────────────────
  let webhookUrl: string | undefined;
  if (opts.mode === "webhook" && opts.webhookUrl) {
    webhookUrl = `${opts.webhookUrl.replace(/\/+$/, "")}/api/telegram/${opts.webhookSecretPath ?? "telegram"}`;
    bot
      .setWebHook(webhookUrl, {
        secret_token: opts.webhookSecretToken,
        allowed_updates: ["message", "callback_query"],
      })
      .then(() => {
        botLog.info({ webhookUrl }, "Telegram webhook registered");
        setBotStatus({ mode: "webhook", webhookUrl, startedAt: new Date().toISOString() });
        notifyAdmin(`✅ *Bot online* (webhook mode)\n\`${webhookUrl}\``).catch(() => {});
      })
      .catch((err) => {
        setBotStatus({ lastError: String(err) });
        botLog.error({ err }, "Failed to register webhook — updates will NOT be received");
      });
  } else {
    setBotStatus({ mode: "polling", startedAt: new Date().toISOString() });
    botLog.info("Telegram bot polling started");
    notifyAdmin(`✅ *Bot online* (polling mode)`).catch(() => {});
  }

  return {
    bot,
    processUpdate: async (body: unknown) => {
      await bot.processUpdate(body as TelegramBot.Update);
    },
    notifyOrderPaid,
    notifyOrderExpired,
    notifyUnknownDeposit: async (deposit: Deposit, chainId: string, wallet: string) => {
      await notifyAdmin(
        `⚠️ *Unmatched deposit*\n\n` +
          `🔗 Chain: ${chainId}\n` +
          `💳 Wallet: \`${wallet}\`\n` +
          `💵 Amount: ${displayFromSmallest(deposit.amountSmallest, chainId)}\n` +
          `🔗 ${deposit.link ?? "—"}\n\n` +
          `No open order matches this transaction — check /orders (wrong amount or late payment?).`,
      );
    },
    stop: async () => {
      clearInterval(pruneTimer);
      if (opts.mode === "webhook" && webhookUrl) {
        await bot.deleteWebHook().catch(() => {});
        botLog.info("Webhook removed");
      } else {
        await bot.stopPolling().catch(() => {});
        botLog.info("Polling stopped");
      }
      setBotStatus({ enabled: false, lastError: null });
    },
  };
}
