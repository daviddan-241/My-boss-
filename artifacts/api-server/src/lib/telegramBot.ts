import TelegramBot from "node-telegram-bot-api";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

// In dev and production the server always runs from dist/index.mjs,
// so ../public always resolves to artifacts/api-server/public/
const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public"
);

// Image paths (sent as local files so they always work)
const IMG_LOCKER  = path.join(PUBLIC_DIR, "supply-locker.png");
const IMG_BURNER  = path.join(PUBLIC_DIR, "supply-burner.png");
const IMG_LOGO    = path.join(PUBLIC_DIR, "dex-logo.png");

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionStep =
  | "idle"
  // Volume bot
  | "volume_contract" | "volume_package" | "volume_payment" | "custom_amount"
  // DEX services
  | "dex_update_contract"
  | "dex_ads_contract" | "dex_ads_hours"
  | "dex_trending_contract" | "dex_trending_tier"
  // Lock Supply
  | "lock_contract" | "lock_percent" | "lock_custom_pct" | "lock_duration" | "lock_custom_dur"
  // Burn Token
  | "burn_contract" | "burn_percent" | "burn_custom_pct";

interface UserSession {
  step: SessionStep;
  tokenData?: TokenInfo;
  selectedPackage?: Package;
  dexHours?: number;
  lockPercent?: number;
  lockDuration?: string;
  burnPercent?: number;
}

interface TokenInfo {
  name: string;
  symbol: string;
  chain: string;
  chainEmoji: string;
  address: string;
  price?: string;
  priceRaw?: number;
  marketCap?: number;
  liquidity?: number;
  volume24h?: number;
  bondingCurve?: number;
  status: string;
  dexUrl?: string;
}

interface Package {
  id: string;
  name: string;
  emoji: string;
  solPrice: number;
  bnbPrice: number;
  ethPrice: number;
  tonPrice: number;
  volume: number;
  duration: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PACKAGES: Package[] = [
  { id: "starter", name: "STARTER", emoji: "💎", solPrice: 0.5, bnbPrice: 0.1, ethPrice: 0.1, tonPrice: 0.1, volume: 25_000,  duration: "12h" },
  { id: "basic",   name: "BASIC",   emoji: "📦", solPrice: 1,   bnbPrice: 0.2, ethPrice: 0.2, tonPrice: 0.2, volume: 50_000,  duration: "24h" },
  { id: "bronze",  name: "BRONZE",  emoji: "🥉", solPrice: 2.5, bnbPrice: 0.5, ethPrice: 0.5, tonPrice: 0.5, volume: 125_000, duration: "36h" },
  { id: "premium", name: "PREMIUM", emoji: "🔥", solPrice: 5,   bnbPrice: 1,   ethPrice: 1,   tonPrice: 1,   volume: 250_000, duration: "48h" },
  { id: "vip",     name: "VIP",     emoji: "💎", solPrice: 10,  bnbPrice: 2,   ethPrice: 2,   tonPrice: 2,   volume: 500_000, duration: "72h" },
];

const CHAIN_MAP: Record<string, { label: string; emoji: string; native: string }> = {
  solana:   { label: "Solana",    emoji: "🟣", native: "SOL" },
  ethereum: { label: "Ethereum",  emoji: "🔷", native: "ETH" },
  bsc:      { label: "BNB Chain", emoji: "🔶", native: "BNB" },
  base:     { label: "Base",      emoji: "🔵", native: "ETH" },
  ton:      { label: "TON",       emoji: "💎", native: "TON" },
};

const DEXSCREENER_API = "https://api.dexscreener.com";

// ─── Session store ────────────────────────────────────────────────────────────

const sessions = new Map<number, UserSession>();

function getSession(userId: number): UserSession {
  if (!sessions.has(userId)) sessions.set(userId, { step: "idle" });
  return sessions.get(userId)!;
}

function clearSession(userId: number): void {
  sessions.set(userId, { step: "idle" });
}

// ─── Chain detection ──────────────────────────────────────────────────────────

function detectChain(addr: string): string | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(addr))         return "evm";
  if (/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(addr))  return "ton";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return "solana";
  return null;
}

// ─── DexScreener lookup ───────────────────────────────────────────────────────

async function lookupToken(address: string): Promise<TokenInfo | null> {
  try {
    const res = await fetch(`${DEXSCREENER_API}/latest/dex/tokens/${address}`);
    if (!res.ok) return null;
    const data = await res.json() as { pairs?: any[] };
    const pairs: any[] = data.pairs ?? [];
    if (!pairs.length) return null;

    // Best pair = highest 24h volume
    const best = pairs.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0];
    const chainId = (best.chainId ?? "unknown") as string;
    const info = CHAIN_MAP[chainId] ?? { label: chainId, emoji: "🌐", native: "?" };

    const priceRaw = best.priceUsd ? parseFloat(best.priceUsd) : undefined;
    const priceStr = priceRaw != null ? `$${priceRaw.toFixed(8)}` : undefined;
    const marketCap = best.marketCap ?? best.fdv;
    const liquidity = best.liquidity?.usd;
    const vol24h = best.volume?.h24;

    // Estimate bonding curve for pump.fun tokens (Solana)
    // pump.fun graduates at ~$85,000 liquidity; we approximate from liq/target
    let bondingCurve: number | undefined;
    if (chainId === "solana" && liquidity) {
      // Some pairs have bonding curve % in their labels or we estimate
      const pumpUrl = (best.url ?? "") + (best.baseToken?.address ?? "");
      const isPump = pumpUrl.toLowerCase().includes("pump") ||
                     (best.dexId ?? "").toLowerCase().includes("pump");
      if (isPump) {
        bondingCurve = Math.min(Math.round((liquidity / 85_000) * 100), 100);
      }
    }

    return {
      name: best.baseToken?.name ?? "Unknown",
      symbol: best.baseToken?.symbol ?? "???",
      chain: info.label,
      chainEmoji: info.emoji,
      address,
      price: priceStr,
      priceRaw,
      marketCap,
      liquidity,
      volume24h: vol24h,
      bondingCurve,
      status: "Active Trading",
      dexUrl: best.url,
    };
  } catch {
    return null;
  }
}

async function fetchBoosts(endpoint: string): Promise<any[]> {
  try {
    const res = await fetch(`${DEXSCREENER_API}${endpoint}`);
    if (!res.ok) return [];
    const data = await res.json() as any;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtVol(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function progressBar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function addrShort(a: string): string {
  return `${a.slice(0, 8)}...${a.slice(-8)}`;
}

function getWallet(chainType: string): string {
  if (chainType === "ton") return process.env["PAYMENT_WALLET_TON"] ?? "YOUR_TON_WALLET_ADDRESS";
  if (chainType === "evm") return process.env["PAYMENT_WALLET_EVM"] ?? "YOUR_EVM_WALLET_ADDRESS";
  return process.env["PAYMENT_WALLET_SOL"] ?? "YOUR_SOL_WALLET_ADDRESS";
}

function chainTypeFor(token: TokenInfo): string {
  const c = token.chain.toLowerCase();
  if (c.includes("ton")) return "ton";
  if (c.includes("bnb") || c.includes("ethereum") || c.includes("base")) return "evm";
  return "solana";
}

function nativeSymbolFor(token: TokenInfo): string {
  const c = token.chain.toLowerCase();
  if (c.includes("ton")) return "TON";
  if (c.includes("bnb")) return "BNB";
  if (c.includes("ethereum") || c.includes("base")) return "ETH";
  return "SOL";
}

function getPkgPrice(pkg: Package, token: TokenInfo): string {
  const c = token.chain.toLowerCase();
  if (c.includes("ton")) return `${pkg.tonPrice} TON`;
  if (c.includes("bnb")) return `${pkg.bnbPrice} BNB`;
  if (c.includes("ethereum") || c.includes("base")) return `${pkg.ethPrice} ETH`;
  return `${pkg.solPrice} SOL`;
}

// ─── Verification result text (reused across flows) ───────────────────────────

function tokenVerifyText(t: TokenInfo): string {
  const mc   = t.marketCap ? fmtUsd(t.marketCap) : "—";
  const liq  = t.liquidity  ? fmtUsd(t.liquidity)  : "—";
  const vol  = t.volume24h  ? fmtVol(t.volume24h)  : "—";
  const bc   = t.bondingCurve != null ? `${t.bondingCurve}%` : null;
  const lines = [
    `✅ *Token Verification Results*\n`,
    `🎯 Token: *${t.symbol}*`,
    `📝 Name: ${t.name}`,
    `${t.chainEmoji} Chain: ${t.chain}`,
    `📍 CA: \`${addrShort(t.address)}\``,
    `💰 Market Cap: ${mc}`,
    bc ? `📊 Bonding Curve: ${bc}` : null,
    `💲 Price: ${t.price ?? "—"}`,
    `📈 24h Volume: ${vol}`,
    liq !== "—" ? `💧 Liquidity: ${liq}` : null,
    `🟢 Status: ${t.status}`,
    `🔗 Source: DexScreener`,
    `\n✅ Token data retrieved successfully!`,
  ];
  return lines.filter(Boolean).join("\n");
}

// ─── Message texts ────────────────────────────────────────────────────────────

function welcomeText(): string {
  return `🦅 *Dexscreener boost*

🚀 *DEX Volume Bot — Multi-Chain Elite Volume Booster*

💎 Real Volume • Whale Attraction • Instant DEX Ranking

🌐 *Supported Chains:*
⊙ Solana  •  Ξ Ethereum  •  ⬡ BNB Chain  •  🔷 Base  •  💎 TON

🎯 *Why Whales Choose Volume-Rich Tokens:*
• Trending tokens get premium attention from big Banks
• Consistent activity signals project legitimacy
• DEX algorithms favor high-volume tokens in recommendations`;
}

function volumePackagesText(): string {
  return `🦅 *Dexscreener boost*

📦 *Premium Volume Packages*

💎 *STARTER* — 0.5 SOL / 0.1 BNB|TON / 0.1 ETH
→ 25,000 Volume • 12h

📦 *BASIC* — 1 SOL / 0.2 BNB|TON / 0.2 ETH
→ 50,000 Volume • 24h

🥉 *BRONZE* — 2.5 SOL / 0.5 BNB|TON / 0.5 ETH
→ 125,000 Volume • 36h

🔥 *PREMIUM* — 5 SOL / 1 BNB|TON|ETH
→ 250,000 Volume • 48h

💎 *VIP* — 10 SOL / 2 BNB|TON|ETH
→ 500,000 Volume • 72h

🎯 *CUSTOM* — 50,000 volume per native token • Flexible duration`;
}

function dexServicesText(): string {
  return `🦅 *Dexscreener boost*

🎯 *Professional DEX Services*

📊 *DEX UPDATE — $299 USD*
~3.1677 SOL / ~0.1310 ETH / ~0.4482 BNB
• Logo • Description • Website • Socials • Banner

📣 *DEX ADS*
SOL/BNB/TON: 0.8 native/hour (min 3h)
ETH/Base: 0.4 ETH/hour (min 1h)
• Premium placement • Featured positioning

🔥 *DEX TRENDING*
🥉 Top 10: 0.5 native/hour (min 3h)
🥇 Top 3: 1 native/hour (min 1h)
• Guaranteed positions

🎁 *COMBO DEALS*
Save 20% on multiple services`;
}

function helpText(): string {
  return `🦅 *Dexscreener boost — Help*

/start — 🏠 Open main menu
/volume — 📦 View all volume packages
/latest — 📰 Latest boosted tokens
/top — 🏆 Top boosted tokens
/golden — 🌟 Golden Ticker tokens (500+ boosts)
/chains — 🌐 Supported chains info
/help — ❓ Help guide
/cancel — ❌ Cancel current session

*Quick Start:*
1. Tap "🚀 Start Volume Bot"
2. Paste your token contract address
3. Choose a package
4. Send payment → Launch!`;
}

function chainsText(): string {
  return `🦅 *Dexscreener boost — Chains*

⊙ *Solana* — 32–44 Base58 chars
Ξ *Ethereum* — 0x + 40 hex
⬡ *BNB Chain* — 0x + 40 hex
🔷 *Base* — 0x + 40 hex
💎 *TON* — EQ/UQ + 46 chars`;
}

function formatBoostToken(t: any, rank?: number): string {
  const chainInfo = CHAIN_MAP[t.chainId] ?? { label: t.chainId, emoji: "🌐", native: "?" };
  const addr = `${(t.tokenAddress ?? "").slice(0, 8)}...${(t.tokenAddress ?? "").slice(-6)}`;
  const rankStr = rank != null ? `*#${rank}* ` : "";
  const golden = (t.totalAmount ?? 0) >= 500 ? " 🌟" : "";
  const amount = (t.amount ?? 0).toLocaleString();
  const total = (t.totalAmount ?? 0).toLocaleString();
  const urlLine = t.url ? `[View on DexScreener](${t.url})` : null;
  return [
    `${rankStr}${chainInfo.emoji} \`${addr}\`${golden}`,
    `🔥 Boost: *${amount}* / ${total} total`,
    t.description ? `📝 ${t.description.slice(0, 80)}` : null,
    urlLine,
  ].filter(Boolean).join("\n");
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

const KB_MAIN = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "🚀 Start Volume Bot",  callback_data: "start_volume"    },
     { text: "◼️ Stop Volume Bot",   callback_data: "stop_volume"     }],
    [{ text: "📦 Volume Packages",   callback_data: "volume_packages" },
     { text: "🎯 DEX Services",      callback_data: "dex_services"    }],
    [{ text: "🔒 Lock Supply",       callback_data: "lock_supply"     },
     { text: "🔥 Burn Token",        callback_data: "burn_token"      }],
  ],
});

const KB_CANCEL = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel" }]],
});

const KB_BACK_MAIN = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [[{ text: "⬅️ Back to Main", callback_data: "back_main" }]],
});

const KB_PACKAGES = (withBack = false): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "💎 Starter — 0.5 SOL", callback_data: "pkg_starter" },
     { text: "📦 Basic — 1 SOL",    callback_data: "pkg_basic"   }],
    [{ text: "🥉 Bronze — 2.5 SOL", callback_data: "pkg_bronze"  },
     { text: "🔥 Premium — 5 SOL",  callback_data: "pkg_premium" }],
    [{ text: "💎 VIP — 10 SOL",     callback_data: "pkg_vip"     },
     { text: "🎯 Custom Package",   callback_data: "pkg_custom"  }],
    withBack
      ? [{ text: "⬅️ Back to Main", callback_data: "back_main" }]
      : [{ text: "❌ Cancel",        callback_data: "cancel"    }],
  ],
});

const KB_LOCK_PCT = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "25%",  callback_data: "lock_pct_25"  }, { text: "50%",  callback_data: "lock_pct_50"  }],
    [{ text: "75%",  callback_data: "lock_pct_75"  }, { text: "100%", callback_data: "lock_pct_100" }],
    [{ text: "✏️ Custom", callback_data: "lock_pct_custom" }],
    [{ text: "❌ Cancel",  callback_data: "cancel"         }],
  ],
});

const KB_LOCK_DUR = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "1 Month",  callback_data: "lock_dur_1m"  }, { text: "3 Months", callback_data: "lock_dur_3m"  }],
    [{ text: "6 Months", callback_data: "lock_dur_6m"  }, { text: "1 Year",   callback_data: "lock_dur_1y"  }],
    [{ text: "✏️ Custom", callback_data: "lock_dur_custom" }],
    [{ text: "❌ Cancel",  callback_data: "cancel"         }],
  ],
});

const KB_BURN_PCT = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "25%",  callback_data: "burn_pct_25"  }, { text: "50%",  callback_data: "burn_pct_50"  }],
    [{ text: "75%",  callback_data: "burn_pct_75"  }, { text: "100%", callback_data: "burn_pct_100" }],
    [{ text: "✏️ Custom", callback_data: "burn_pct_custom" }],
    [{ text: "❌ Cancel",  callback_data: "cancel"         }],
  ],
});

const KB_DEX_SERVICES = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "📊 DEX Update — $299", callback_data: "dex_update"   },
     { text: "📣 DEX Ads",          callback_data: "dex_ads"       }],
    [{ text: "🔥 DEX Trending",     callback_data: "dex_trending"  }],
    [{ text: "⬅️ Back to Main",     callback_data: "back_main"     }],
  ],
});

// ─── Photo helper (falls back to text if photo fails) ────────────────────────

async function sendPhoto(
  bot: TelegramBot,
  chatId: number | string,
  photoPath: string,
  caption: string,
  opts: TelegramBot.SendPhotoOptions = {}
): Promise<void> {
  try {
    await bot.sendPhoto(chatId, photoPath, { caption, parse_mode: "Markdown", ...opts });
  } catch {
    await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", ...opts as any });
  }
}

// ─── Bot entry point ─────────────────────────────────────────────────────────

export function startTelegramBot(token: string): TelegramBot {
  const bot = new TelegramBot(token, { polling: true });
  const adminChatId = process.env["ADMIN_CHAT_ID"];

  async function notifyAdmin(text: string): Promise<void> {
    if (!adminChatId) return;
    try { await bot.sendMessage(adminChatId, text, { parse_mode: "Markdown" }); } catch {}
  }

  logger.info("Telegram bot starting");

  // Register commands
  bot.setMyCommands([
    { command: "start",  description: "🏠 Open main menu"               },
    { command: "volume", description: "📦 Volume packages & pricing"    },
    { command: "latest", description: "📰 Latest boosted tokens"        },
    { command: "top",    description: "🏆 Top boosted tokens"           },
    { command: "golden", description: "🌟 Golden Ticker tokens"         },
    { command: "chains", description: "🌐 Supported chains & info"      },
    { command: "help",   description: "❓ Help guide"                   },
    { command: "cancel", description: "❌ Cancel current session"       },
  ]).catch(() => {});

  // ── Helper: send main menu ────────────────────────────────────────────────
  async function sendMainMenu(chatId: number | string): Promise<void> {
    clearSession(Number(chatId));
    try {
      await bot.sendPhoto(chatId, IMG_LOGO, {
        caption: welcomeText(),
        parse_mode: "Markdown",
        reply_markup: KB_MAIN(),
      });
    } catch {
      await bot.sendMessage(chatId, welcomeText(), {
        parse_mode: "Markdown",
        reply_markup: KB_MAIN(),
      });
    }
  }

  // ── Helper: verify token then call next ────────────────────────────────────
  async function verifyAndContinue(
    chatId: number,
    userId: number,
    address: string,
    onSuccess: (info: TokenInfo) => Promise<void>
  ): Promise<void> {
    const chainType = detectChain(address);
    if (!chainType) {
      await bot.sendMessage(
        chatId,
        "❌ *Invalid contract address format.*\n\n• Solana: 32–44 Base58 chars\n• EVM: 0x + 40 hex\n• TON: EQ/UQ + 46 chars",
        { parse_mode: "Markdown", reply_markup: KB_CANCEL() }
      );
      return;
    }

    const loading = await bot.sendMessage(chatId, "⏳ *Verifying token on DexScreener...*", { parse_mode: "Markdown" });
    const tokenInfo = await lookupToken(address);
    try { await bot.deleteMessage(chatId, loading.message_id); } catch {}

    if (!tokenInfo) {
      await bot.sendMessage(
        chatId,
        "❌ *Token not found on DexScreener.*\n\nEnsure the token has active trading pairs, then try again.",
        { parse_mode: "Markdown", reply_markup: KB_CANCEL() }
      );
      return;
    }

    getSession(userId).tokenData = tokenInfo;
    await onSuccess(tokenInfo);
  }

  // ── Volume Bot flow ────────────────────────────────────────────────────────

  async function startVolumeStep1(chatId: number | string, userId: number): Promise<void> {
    getSession(userId).step = "volume_contract";
    await bot.sendMessage(
      chatId,
      `🦅 *Dexscreener boost*

🚀 *Volume Bot — Whale Attraction Protocol*

📊 Progress: 33%
${progressBar(33)}
*Step 1/3: Token Verification*

🌐 Supported: ⊙ SOL • Ξ ETH • ⬡ BNB • 🔷 Base • 💎 TON

🔍 Please provide your token contract address:
⚡ Auto-verified with DexScreener`,
      { parse_mode: "Markdown", reply_markup: KB_CANCEL() }
    );
  }

  async function sendVolumeStep2(chatId: number | string, t: TokenInfo): Promise<void> {
    const mc  = t.marketCap ? fmtUsd(t.marketCap) : "—";
    const vol = t.volume24h ? fmtVol(t.volume24h)  : "—";
    const liq = t.liquidity  ? fmtUsd(t.liquidity)  : "—";
    const bc  = t.bondingCurve != null ? `\n📊 Bonding Curve: ${t.bondingCurve}%` : "";
    await bot.sendMessage(
      chatId,
      `${tokenVerifyText(t)}

📊 Progress: 67%
${progressBar(67)}
*Step 2/3: Package Selection*

🎯 Choose your volume package:`,
      { parse_mode: "Markdown", reply_markup: KB_PACKAGES() }
    );
  }

  async function sendVolumeStep3(chatId: number | string, userId: number, t: TokenInfo, pkg: Package): Promise<void> {
    const session = getSession(userId);
    session.step = "volume_payment";
    session.selectedPackage = pkg;

    const chainType = chainTypeFor(t);
    const priceStr  = getPkgPrice(pkg, t);
    const wallet    = getWallet(chainType);
    const mc        = t.marketCap ? fmtUsd(t.marketCap) : "—";

    await bot.sendMessage(
      chatId,
      `🦅 *Dexscreener boost*

📊 Progress: 100%
${progressBar(100)}
*Step 3/3: Payment & Activation*

${t.chainEmoji} Chain: ${t.chain}
🎯 Token: *${t.symbol}* (${mc})
${pkg.emoji} Package: *${pkg.name}*
💰 Volume: ${pkg.volume.toLocaleString()}
⏰ Duration: ${pkg.duration}
💵 Investment: *${priceStr}*

💰 *Send ${priceStr} to:*
\`${wallet}\`

After sending, tap the button below to launch!`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Payment Sent — Launch!", callback_data: "payment_sent" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      }
    );
    await notifyAdmin(`🚀 *Volume Bot Order*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\`\nPackage: ${pkg.name}\nPrice: ${priceStr}`);
  }

  // ── Lock Supply flow ───────────────────────────────────────────────────────

  async function startLockStep1(chatId: number | string, userId: number): Promise<void> {
    getSession(userId).step = "lock_contract";
    await sendPhoto(
      bot, chatId, IMG_LOCKER,
      `🔒 *Lock Supply*

📍 Step 1/3: Token Contract Address

Please provide your token's contract address (CA):

📋 Supported formats:
• ⊙ Solana: 32–44 Base58 chars
• Ξ ETH / ⬡ BSC / 🔷 Base: 0x + 40 hex
• 💎 TON: EQ/UQ + 46 chars`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendLockStep2Percent(chatId: number | string, t: TokenInfo): Promise<void> {
    await bot.sendMessage(
      chatId,
      `${tokenVerifyText(t)}

📍 Step 2/3: Choose the percentage to lock:`,
      { parse_mode: "Markdown", reply_markup: KB_LOCK_PCT() }
    );
  }

  async function sendLockDuration(chatId: number | string): Promise<void> {
    await sendPhoto(
      bot, chatId, IMG_LOCKER,
      `🗓 *Lock Duration*

📍 Step 2/3: Choose how long the supply will be locked:`,
      { reply_markup: KB_LOCK_DUR() }
    );
  }

  async function sendLockSummary(chatId: number | string, userId: number, t: TokenInfo, pct: number, dur: string): Promise<void> {
    clearSession(userId);
    const wallet = getWallet(chainTypeFor(t));
    const mc  = t.marketCap ? fmtUsd(t.marketCap) : "—";
    const liq = t.liquidity  ? fmtUsd(t.liquidity)  : "—";

    await sendPhoto(
      bot, chatId, IMG_LOCKER,
      `🔒 *Lock Summary*

${t.chainEmoji} Chain: ${t.chain}
🏷 Token: *${t.name}* (${t.symbol})
📍 CA: \`${addrShort(t.address)}\`
💰 Market Cap: ${mc}
💧 Liquidity: ${liq}
🕐 Lock Duration: ${dur}
🎯 Target % to Lock: ${pct}%

📍 Step 3/3: Connect your wallet to sign the transaction.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔗 Connect Wallet", callback_data: "lock_connect_wallet" }],
            [{ text: "⬅️ Back to Main",   callback_data: "back_main"           }],
          ],
        },
      }
    );
    await notifyAdmin(`🔒 *Lock Supply Request*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\`\nPercent: ${pct}%\nDuration: ${dur}`);
  }

  // ── Burn Token flow ────────────────────────────────────────────────────────

  async function startBurnStep1(chatId: number | string, userId: number): Promise<void> {
    getSession(userId).step = "burn_contract";
    await sendPhoto(
      bot, chatId, IMG_BURNER,
      `🔥 *Burn Token*

📍 Step 1/3: Token Contract Address

Please provide your token's contract address (CA):

📋 Supported formats:
• ⊙ Solana: 32–44 Base58 chars
• Ξ ETH / ⬡ BSC / 🔷 Base: 0x + 40 hex
• 💎 TON: EQ/UQ + 46 chars`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendBurnStep2Percent(chatId: number | string, t: TokenInfo): Promise<void> {
    await sendPhoto(
      bot, chatId, IMG_BURNER,
      `${tokenVerifyText(t)}

📍 Step 2/3: Choose the percentage to burn:`,
      { reply_markup: KB_BURN_PCT() }
    );
  }

  async function sendBurnSummary(chatId: number | string, userId: number, t: TokenInfo, pct: number): Promise<void> {
    clearSession(userId);
    const wallet = getWallet(chainTypeFor(t));
    const native = nativeSymbolFor(t);
    const mc     = t.marketCap ? fmtUsd(t.marketCap) : "—";
    const fee    = chainTypeFor(t) === "solana" ? "0.5 SOL" : `0.05 ${native}`;

    await sendPhoto(
      bot, chatId, IMG_BURNER,
      `🔥 *Burn Summary*

${t.chainEmoji} Chain: ${t.chain}
🏷 Token: *${t.name}* (${t.symbol})
📍 CA: \`${addrShort(t.address)}\`
💰 Market Cap: ${mc}
🔥 Burn Amount: ${pct}% of supply

📍 Step 3/3: Payment & Confirmation
🔧 Service Fee: ${fee}

💰 *Send ${fee} to:*
\`${wallet}\``,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Fee Sent — Burn Now!", callback_data: "burn_paid" }],
            [{ text: "❌ Cancel",               callback_data: "cancel"    }],
          ],
        },
      }
    );
    await notifyAdmin(`🔥 *Burn Token Request*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\`\nPercent: ${pct}%`);
  }

  // ── Text message handler ───────────────────────────────────────────────────

  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    const text   = msg.text.trim();
    const session = getSession(userId);

    // ── Contract address steps ──────────────────────────────────────────────
    if (session.step === "volume_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "volume_package";
        await sendVolumeStep2(chatId, t);
      });
      return;
    }

    if (session.step === "lock_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "lock_percent";
        await sendLockStep2Percent(chatId, t);
      });
      return;
    }

    if (session.step === "burn_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "burn_percent";
        await sendBurnStep2Percent(chatId, t);
      });
      return;
    }

    if (session.step === "dex_update_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        clearSession(userId);
        const wallet = getWallet("solana");
        await bot.sendMessage(
          chatId,
          `🦅 *DEX Update Service — $299 USD*

${tokenVerifyText(t)}

✨ *Includes:* Logo • Description • Website • Socials • Banner

💰 *Send payment to:*
\`${wallet}\`

_Our team will update your token info within 24h of payment confirmation._`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Payment Sent", callback_data: "payment_sent" }],
                [{ text: "❌ Cancel",        callback_data: "cancel"       }],
              ],
            },
          }
        );
        await notifyAdmin(`📊 *DEX Update Order*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\``);
      });
      return;
    }

    if (session.step === "dex_ads_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "dex_ads_hours";
        await bot.sendMessage(
          chatId,
          `✅ Token: *${t.symbol}* on ${t.chain}\n\n📣 *DEX Ads Service*\n\nHow many hours?\n• SOL/BNB/TON: 0.8/hour (min 3h)\n• ETH/Base: 0.4 ETH/hour (min 1h)\n\n_Reply with a number (e.g. "6"):_`,
          { parse_mode: "Markdown", reply_markup: KB_CANCEL() }
        );
      });
      return;
    }

    if (session.step === "dex_trending_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "dex_trending_tier";
        await bot.sendMessage(
          chatId,
          `✅ Token: *${t.symbol}* on ${t.chain}\n\n🔥 *DEX Trending — Choose tier:*`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🥉 Top 10 — 0.5/hour", callback_data: "trending_top10" },
                 { text: "🥇 Top 3 — 1/hour",    callback_data: "trending_top3"  }],
                [{ text: "❌ Cancel", callback_data: "cancel" }],
              ],
            },
          }
        );
      });
      return;
    }

    // ── Hours input for DEX Ads ─────────────────────────────────────────────
    if (session.step === "dex_ads_hours") {
      const hours = parseInt(text, 10);
      if (isNaN(hours) || hours < 1) {
        await bot.sendMessage(chatId, "❌ Please enter a valid number (e.g., 3)", { reply_markup: KB_CANCEL() });
        return;
      }
      const t = session.tokenData!;
      const wallet = getWallet("solana");
      const cost = (hours * 0.8).toFixed(1);
      clearSession(userId);
      await bot.sendMessage(
        chatId,
        `📣 *DEX Ads — ${hours}h Campaign*\n\nToken: *${t.symbol}* on ${t.chain}\nDuration: ${hours}h\nCost: ${cost} SOL (or ${cost} BNB/TON | ${(hours * 0.4).toFixed(1)} ETH)\n\n💰 Send to:\n\`${wallet}\``,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Payment Sent — Launch!", callback_data: "payment_sent" }],
              [{ text: "❌ Cancel", callback_data: "cancel" }],
            ],
          },
        }
      );
      await notifyAdmin(`📣 *DEX Ads Order*\n\nUser: ${userId}\nToken: ${t.symbol}\nHours: ${hours}\nCost: ${cost} SOL`);
      return;
    }

    // ── Custom lock percent ─────────────────────────────────────────────────
    if (session.step === "lock_custom_pct") {
      const pct = parseFloat(text);
      if (isNaN(pct) || pct <= 0 || pct > 100) {
        await bot.sendMessage(chatId, "❌ Enter a percentage between 1 and 100 (e.g., 60)", { reply_markup: KB_CANCEL() });
        return;
      }
      session.lockPercent = pct;
      session.step = "lock_duration";
      await sendLockDuration(chatId);
      return;
    }

    // ── Custom lock duration ────────────────────────────────────────────────
    if (session.step === "lock_custom_dur") {
      if (!text.trim()) {
        await bot.sendMessage(chatId, "❌ Please enter a valid duration (e.g., 2 years, 90 days)", { reply_markup: KB_CANCEL() });
        return;
      }
      const t   = session.tokenData!;
      const pct = session.lockPercent!;
      await sendLockSummary(chatId, userId, t, pct, text.trim());
      return;
    }

    // ── Custom burn percent ─────────────────────────────────────────────────
    if (session.step === "burn_custom_pct") {
      const pct = parseFloat(text);
      if (isNaN(pct) || pct <= 0 || pct > 100) {
        await bot.sendMessage(chatId, "❌ Enter a percentage between 1 and 100 (e.g., 50)", { reply_markup: KB_CANCEL() });
        return;
      }
      const t = session.tokenData!;
      await sendBurnSummary(chatId, userId, t, pct);
      return;
    }

    // ── Custom volume amount ────────────────────────────────────────────────
    if (session.step === "custom_amount") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Enter a valid amount (e.g., 3.5)", { reply_markup: KB_CANCEL() });
        return;
      }
      const t      = session.tokenData;
      const volume = Math.round(amount * 50_000);
      const wallet = getWallet("solana");
      clearSession(userId);
      await bot.sendMessage(
        chatId,
        `🎯 *Custom Package*\n\nToken: *${t?.symbol ?? "Your Token"}*\nAmount: ${amount} SOL\nVolume: ~${volume.toLocaleString()}\n\n💰 Send ${amount} SOL to:\n\`${wallet}\``,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Payment Sent — Launch!", callback_data: "payment_sent" }],
              [{ text: "❌ Cancel", callback_data: "cancel" }],
            ],
          },
        }
      );
    }
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  bot.onText(/^\/start/, async (msg) => {
    await sendMainMenu(msg.chat.id);
  });

  bot.onText(/^\/cancel/, async (msg) => {
    clearSession(msg.from?.id ?? msg.chat.id);
    await bot.sendMessage(msg.chat.id, "❌ Session cancelled.", { parse_mode: "Markdown" });
    await sendMainMenu(msg.chat.id);
  });

  bot.onText(/^\/help/,   async (msg) => {
    await bot.sendMessage(msg.chat.id, helpText(), { parse_mode: "Markdown", reply_markup: KB_BACK_MAIN() });
  });

  bot.onText(/^\/volume/, async (msg) => {
    await bot.sendMessage(msg.chat.id, volumePackagesText(), { parse_mode: "Markdown", reply_markup: KB_PACKAGES(true) });
  });

  bot.onText(/^\/chains/, async (msg) => {
    await bot.sendMessage(msg.chat.id, chainsText(), { parse_mode: "Markdown", reply_markup: KB_BACK_MAIN() });
  });

  bot.onText(/^\/latest/, async (msg) => {
    const loading = await bot.sendMessage(msg.chat.id, "⏳ Fetching latest boosts...");
    const tokens  = await fetchBoosts("/token-boosts/latest/v1");
    try { await bot.deleteMessage(msg.chat.id, loading.message_id); } catch {}
    if (!tokens.length) { await bot.sendMessage(msg.chat.id, "❌ Could not fetch data."); return; }
    await bot.sendMessage(msg.chat.id, `📰 *Latest Boosted Tokens*`, { parse_mode: "Markdown" });
    for (let i = 0; i < Math.min(tokens.length, 10); i += 5) {
      const chunk = tokens.slice(i, i + 5).map(formatBoostToken).join("\n\n───────────\n\n");
      await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown", disable_web_page_preview: true });
    }
  });

  bot.onText(/^\/top/, async (msg) => {
    const loading = await bot.sendMessage(msg.chat.id, "⏳ Fetching top boosts...");
    const tokens  = await fetchBoosts("/token-boosts/top/v1");
    try { await bot.deleteMessage(msg.chat.id, loading.message_id); } catch {}
    if (!tokens.length) { await bot.sendMessage(msg.chat.id, "❌ Could not fetch data."); return; }
    await bot.sendMessage(msg.chat.id, `🏆 *Top Boosted Tokens*`, { parse_mode: "Markdown" });
    for (let i = 0; i < Math.min(tokens.length, 10); i += 5) {
      const chunk = tokens.slice(i, i + 5).map((t, j) => formatBoostToken(t, i + j + 1)).join("\n\n───────────\n\n");
      await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown", disable_web_page_preview: true });
    }
  });

  bot.onText(/^\/golden/, async (msg) => {
    const loading = await bot.sendMessage(msg.chat.id, "⏳ Fetching Golden Tickers...");
    const tokens  = await fetchBoosts("/token-boosts/top/v1");
    try { await bot.deleteMessage(msg.chat.id, loading.message_id); } catch {}
    const golden = tokens.filter(t => (t.totalAmount ?? 0) >= 500);
    if (!golden.length) {
      await bot.sendMessage(msg.chat.id, "🌟 No Golden Ticker tokens found right now!", { reply_markup: KB_BACK_MAIN() });
      return;
    }
    await bot.sendMessage(msg.chat.id, `🌟 *Golden Ticker Tokens* (${golden.length})`, { parse_mode: "Markdown" });
    for (let i = 0; i < Math.min(golden.length, 10); i += 5) {
      const chunk = golden.slice(i, i + 5).map((t, j) => formatBoostToken(t, i + j + 1)).join("\n\n───────────\n\n");
      await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown", disable_web_page_preview: true });
    }
  });

  // ── Callback queries ───────────────────────────────────────────────────────

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    if (!chatId) return;
    await bot.answerCallbackQuery(query.id).catch(() => {});

    const data    = query.data ?? "";
    const session = getSession(userId);

    // ── Main menu navigation ──────────────────────────────────────────────
    if (data === "back_main" || data === "cancel") {
      clearSession(userId);
      if (data === "cancel") await bot.sendMessage(chatId, "❌ Cancelled.");
      await sendMainMenu(chatId);
      return;
    }

    if (data === "start_volume") { await startVolumeStep1(chatId, userId); return; }

    if (data === "stop_volume") {
      clearSession(userId);
      await bot.sendMessage(chatId, `◼️ *No Active Volume Bot*\n\nNo volume generation is running. Use "🚀 Start Volume Bot" to begin!`, {
        parse_mode: "Markdown", reply_markup: KB_BACK_MAIN(),
      });
      return;
    }

    if (data === "volume_packages") {
      await bot.sendMessage(chatId, volumePackagesText(), { parse_mode: "Markdown", reply_markup: KB_PACKAGES(true) });
      return;
    }

    if (data === "dex_services") {
      await bot.sendMessage(chatId, dexServicesText(), { parse_mode: "Markdown", reply_markup: KB_DEX_SERVICES() });
      return;
    }

    if (data === "lock_supply") { await startLockStep1(chatId, userId); return; }
    if (data === "burn_token")  { await startBurnStep1(chatId, userId);  return; }

    // ── Package selection ─────────────────────────────────────────────────
    if (data.startsWith("pkg_")) {
      const pkgId = data.replace("pkg_", "");
      if (pkgId === "custom") {
        session.step = "custom_amount";
        await bot.sendMessage(
          chatId,
          `🎯 *Custom Package*\n\nEnter your desired SOL amount:\n• 50,000 volume per 1 SOL\n\n_e.g., type "3.5" for 175,000 volume_`,
          { parse_mode: "Markdown", reply_markup: KB_CANCEL() }
        );
        return;
      }
      const pkg = PACKAGES.find(p => p.id === pkgId);
      if (!pkg) return;
      const t = session.tokenData;
      if (!t) {
        // From volume_packages page — go to step 1 first
        session.selectedPackage = pkg;
        await startVolumeStep1(chatId, userId);
        return;
      }
      await sendVolumeStep3(chatId, userId, t, pkg);
      return;
    }

    // ── Lock Supply callbacks ─────────────────────────────────────────────
    if (data.startsWith("lock_pct_")) {
      const raw = data.replace("lock_pct_", "");
      if (raw === "custom") {
        session.step = "lock_custom_pct";
        await bot.sendMessage(chatId, "✏️ Enter the custom percentage to lock (1–100):", { reply_markup: KB_CANCEL() });
        return;
      }
      session.lockPercent = parseInt(raw, 10);
      session.step = "lock_duration";
      await sendLockDuration(chatId);
      return;
    }

    if (data.startsWith("lock_dur_")) {
      const raw = data.replace("lock_dur_", "");
      if (raw === "custom") {
        session.step = "lock_custom_dur";
        await bot.sendMessage(chatId, "✏️ Enter the custom lock duration (e.g., '90 days', '2 years'):", { reply_markup: KB_CANCEL() });
        return;
      }
      const durMap: Record<string, string> = { "1m": "1 Month", "3m": "3 Months", "6m": "6 Months", "1y": "1 Year" };
      const dur = durMap[raw] ?? raw;
      const t   = session.tokenData!;
      const pct = session.lockPercent!;
      await sendLockSummary(chatId, userId, t, pct, dur);
      return;
    }

    if (data === "lock_connect_wallet") {
      const wallet = getWallet("solana");
      await bot.sendMessage(
        chatId,
        `🔗 *Connect Your Wallet*\n\n📍 Step 3/3: Payment\n\nTo execute the lock transaction, send a service fee to cover gas and our smart contract:\n\n💵 Fee: 0.1 SOL\n💰 *Send to:*\n\`${wallet}\`\n\n_After payment, our system will process your lock within 10 minutes._`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Fee Sent — Lock It!", callback_data: "payment_sent" }],
              [{ text: "❌ Cancel", callback_data: "cancel" }],
            ],
          },
        }
      );
      return;
    }

    // ── Burn Token callbacks ──────────────────────────────────────────────
    if (data.startsWith("burn_pct_")) {
      const raw = data.replace("burn_pct_", "");
      if (raw === "custom") {
        session.step = "burn_custom_pct";
        await bot.sendMessage(chatId, "✏️ Enter the custom percentage to burn (1–100):", { reply_markup: KB_CANCEL() });
        return;
      }
      const pct = parseInt(raw, 10);
      session.burnPercent = pct;
      const t = session.tokenData!;
      await sendBurnSummary(chatId, userId, t, pct);
      return;
    }

    // ── DEX service entry points ──────────────────────────────────────────
    if (data === "dex_update") {
      session.step = "dex_update_contract";
      await bot.sendMessage(
        chatId,
        `🎯 *DEX UPDATE SERVICE*\n💰 Price: $299 USD (paid in chain native token)\n\n📊 Progress: 17%\n${progressBar(17)}\nStep 1/6: Token Contract Address\n\n🌐 Supported: ⊙ SOL • Ξ ETH • ⬡ BNB • 🔷 Base • 💎 TON\n\n✨ Includes: Logo • Description • Website • Socials • Banner\n\n🔍 Please provide your token contract address:\n⚡ Auto-verified with DexScreener`,
        { parse_mode: "Markdown", reply_markup: KB_CANCEL() }
      );
      return;
    }

    if (data === "dex_ads") {
      session.step = "dex_ads_contract";
      await bot.sendMessage(
        chatId,
        `📣 *DEX Ads Service*\n\n💰 SOL/BNB/TON: 0.8 native/hour (min 3h)\n💰 ETH/Base: 0.4 ETH/hour (min 1h)\n\n🔍 Please provide your token contract address:\n⚡ Auto-verified with DexScreener`,
        { parse_mode: "Markdown", reply_markup: KB_CANCEL() }
      );
      return;
    }

    if (data === "dex_trending") {
      session.step = "dex_trending_contract";
      await bot.sendMessage(
        chatId,
        `🔥 *DEX Trending Service*\n\n🥉 Top 10: 0.5 native/hour (min 3h)\n🥇 Top 3: 1 native/hour (min 1h)\n\n🔍 Please provide your token contract address:\n⚡ Auto-verified with DexScreener`,
        { parse_mode: "Markdown", reply_markup: KB_CANCEL() }
      );
      return;
    }

    // ── Trending tier ─────────────────────────────────────────────────────
    if (data === "trending_top10" || data === "trending_top3") {
      const t    = session.tokenData!;
      const tier = data === "trending_top10" ? "Top 10" : "Top 3";
      const rate = data === "trending_top10" ? "0.5" : "1";
      const wallet = getWallet("solana");
      clearSession(userId);
      await bot.sendMessage(
        chatId,
        `🔥 *DEX Trending — ${tier}*\n\nToken: *${t.symbol}* on ${t.chain}\nRate: ${rate} native/hour (min 3h)\n\n💰 Send payment to:\n\`${wallet}\`\n\n*Guaranteed ${tier} position!*`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Payment Sent — Launch!", callback_data: "payment_sent" }],
              [{ text: "❌ Cancel", callback_data: "cancel" }],
            ],
          },
        }
      );
      await notifyAdmin(`🔥 *DEX Trending Order*\n\nUser: ${userId}\nToken: ${t.symbol}\nTier: ${tier}`);
      return;
    }

    // ── Payment confirmations ─────────────────────────────────────────────
    if (data === "payment_sent" || data === "burn_paid") {
      clearSession(userId);
      await bot.sendMessage(
        chatId,
        `⏳ *Hold On...*\n\nWe've received your payment notification and are now confirming your order.\n\nYou will be notified once your order is confirmed ✅\n\n_Typical confirmation time: 30–60 minutes_`,
        { parse_mode: "Markdown", reply_markup: KB_BACK_MAIN() }
      );
      await notifyAdmin(`💰 *Payment Notification*\n\nUser: ${userId}\nAction: ${data}`);
      return;
    }
  });

  bot.on("polling_error", (err) => {
    logger.error({ err }, "Telegram polling error");
  });

  logger.info("Telegram bot started successfully");
  return bot;
}
