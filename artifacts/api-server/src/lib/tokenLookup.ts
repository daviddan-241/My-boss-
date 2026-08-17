/**
 * Multi-source token lookup engine.
 *
 * Replaces the old DexScreener+PumpFun-only lookup with a prioritized,
 * parallel fan-out across public token-data APIs:
 *
 *   1. DexScreener   — primary (richest market data, all chains)
 *   2. PumpFun       — Solana bonding-curve tokens (pre-graduation)
 *   3. GeckoTerminal — direct token endpoint + network probing (EVM auto-detect)
 *   4. CoinGecko     — contract endpoint per platform (price / MC / volume)
 *   5. Birdeye       — Solana (+ EVM) overview, needs BIRDEYE_API_KEY
 *   6. Jupiter       — Solana metadata fallback (any mint)
 *   7. Moralis       — EVM ERC-20 fallback, needs MORALIS_API_KEY (optional)
 *
 * Features:
 *   - per-source token-bucket rate limiting (respects free API tiers)
 *   - retries with exponential backoff + jitter, per-attempt timeouts
 *   - short-TTL cache so repeated lookups don't hammer upstream APIs
 *   - normalization of every source into one TokenInfo shape
 *   - field merging: the richest source wins, gaps are filled from others
 *   - full per-source success/failure reporting for the user-facing error text
 *   - EVM chain auto-detection by probing GeckoTerminal networks
 *
 * All sources are free/public (some have optional API keys for higher
 * limits). No source is required — the engine degrades gracefully.
 */

import { logger } from "./logger.js";
import { PublicKey } from "@solana/web3.js";
import {
  recordLookupResult,
  recordSourceResult,
  setLookupCacheSize,
} from "./statusRegistry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenInfo {
  name: string;
  symbol: string;
  chain: string; // human label, e.g. "Solana"
  chainId: string; // machine id, e.g. "solana"
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
  /** Token logo/icon URL (from DexScreener, GeckoTerminal, CoinGecko, PumpFun, …). */
  imageUrl?: string;
  source: string; // primary source that produced the winner
  sources?: string[]; // all sources that contributed data
}

export interface SourceResult {
  source: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface TokenLookupResult {
  token: TokenInfo | null;
  tried: SourceResult[];
  detectedChain?: string;
  fromCache?: boolean;
}

export interface LookupOptions {
  /** Internal chain id: solana | ethereum | bsc | base | ton | arbitrum | polygon | optimism | avalanche */
  chainHint?: string;
  /** Probe GeckoTerminal networks when the address is EVM and no chain is known. */
  autoDetectEvmChain?: boolean;
  /** Search by token name/symbol instead of address. */
  isQuery?: boolean;
}

// ─── Chain metadata ───────────────────────────────────────────────────────────

export const CHAIN_MAP: Record<
  string,
  {
    label: string;
    emoji: string;
    native: string;
    coinGeckoPlatform?: string;
    geckoTerminalNetwork?: string;
    birdeyeChain?: string;
    moralisChain?: string;
  }
> = {
  solana: {
    label: "Solana", emoji: "🟣", native: "SOL",
    coinGeckoPlatform: "solana", geckoTerminalNetwork: "solana",
    birdeyeChain: "solana",
  },
  ethereum: {
    label: "Ethereum", emoji: "Ξ", native: "ETH",
    coinGeckoPlatform: "ethereum", geckoTerminalNetwork: "eth",
    birdeyeChain: "ethereum", moralisChain: "eth",
  },
  bsc: {
    label: "BNB Chain", emoji: "🟡", native: "BNB",
    coinGeckoPlatform: "binance-smart-chain", geckoTerminalNetwork: "bsc",
    birdeyeChain: "bsc", moralisChain: "bsc",
  },
  base: {
    label: "Base", emoji: "🔵", native: "ETH",
    coinGeckoPlatform: "base", geckoTerminalNetwork: "base",
    birdeyeChain: "base", moralisChain: "base",
  },
  ton: {
    label: "TON", emoji: "💎", native: "TON",
    coinGeckoPlatform: "the-open-network", geckoTerminalNetwork: "ton",
  },
  arbitrum: {
    label: "Arbitrum", emoji: "🔷", native: "ETH",
    coinGeckoPlatform: "arbitrum-one", geckoTerminalNetwork: "arbitrum",
    birdeyeChain: "arbitrum", moralisChain: "arbitrum",
  },
  polygon: {
    label: "Polygon", emoji: "🟪", native: "POL",
    coinGeckoPlatform: "polygon-pos", geckoTerminalNetwork: "polygon_pos",
    birdeyeChain: "polygon", moralisChain: "polygon",
  },
  optimism: {
    label: "Optimism", emoji: "🔴", native: "ETH",
    coinGeckoPlatform: "optimistic-ethereum", geckoTerminalNetwork: "optimism",
    birdeyeChain: "optimism", moralisChain: "optimism",
  },
  avalanche: {
    label: "Avalanche", emoji: "🔺", native: "AVAX",
    coinGeckoPlatform: "avalanche", geckoTerminalNetwork: "avax",
    birdeyeChain: "avalanche", moralisChain: "avax",
  },
  fantom: {
    label: "Fantom", emoji: "👻", native: "FTM",
    coinGeckoPlatform: "fantom", geckoTerminalNetwork: "fantom",
    birdeyeChain: "fantom", moralisChain: "fantom",
  },
  celo: {
    label: "Celo", emoji: "🌿", native: "CELO",
    coinGeckoPlatform: "celo", geckoTerminalNetwork: "celo",
    moralisChain: "celo",
  },
};

const chainInfo = (chainId: string) => CHAIN_MAP[chainId] ?? { label: chainId, emoji: "🌐", native: "?" };

/** EVM networks probed when auto-detecting an EVM contract's chain. */
const EVM_PROBE_NETWORKS = [
  "eth",
  "bsc",
  "base",
  "arbitrum",
  "optimism",
  "polygon_pos",
  "avax",
  "fantom",
  "celo",
  "scroll",
];

// ─── Address format detection ─────────────────────────────────────────────────

export type ChainFormat = "solana" | "evm" | "ton" | null;

export function detectChainFormat(addr: string): ChainFormat {
  const t = addr.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return "evm";
  if (/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(t)) return "ton";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return "solana";
  return null;
}

// ─── Token bucket (per-source rate limiting) ──────────────────────────────────

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Resolves when a token is available; sleeps until refill otherwise. */
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((now - this.lastRefill) / 1000) * this.refillPerSec,
      );
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
      await sleep(Math.min(waitMs, 10_000));
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const buckets: Record<string, TokenBucket> = {};
function bucketFor(source: string, capacity: number, refillPerSec: number): TokenBucket {
  return (buckets[source] ??= new TokenBucket(capacity, refillPerSec));
}

// ─── HTTP helper: retry + backoff + timeout ───────────────────────────────────

interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  headers?: Record<string, string>;
  source: string; // used for rate limiting + stats
  rateCapacity?: number; // bucket capacity (burst)
  rateRefillPerSec?: number;
}

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function fetchJson(url: string, opts: FetchJsonOptions): Promise<any> {
  const {
    timeoutMs = 10_000,
    retries = 2,
    baseDelayMs = 600,
    headers,
    source,
    rateCapacity = 5,
    rateRefillPerSec = 1,
  } = opts;

  const started = Date.now();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await bucketFor(source, rateCapacity, rateRefillPerSec).take();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers });
      if (res.status === 429) {
        // Respect Retry-After if the API provides it.
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
        logger.warn({ source, url, wait }, "Rate limited by upstream API");
        await sleep(Math.min(wait, 15_000));
        throw new UpstreamError("HTTP 429 rate limited", true);
      }
      if (res.status >= 400 && res.status < 500) {
        // 4xx (other than 429) is a definitive answer ("not found") — never retry.
        throw new UpstreamError(`HTTP ${res.status}`, false);
      }
      if (!res.ok) throw new UpstreamError(`HTTP ${res.status}`, true);
      const data = await res.json();
      recordSourceResult(source, true, Date.now() - started);
      return data;
    } catch (err) {
      const error =
        err instanceof UpstreamError
          ? err
          : new UpstreamError(err instanceof Error ? err.message : String(err), true);
      lastError = error;
      if (attempt >= retries || !error.retryable) break;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 250;
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  recordSourceResult(source, false, Date.now() - started, lastError?.message);
  throw lastError ?? new Error("fetch failed");
}

// ─── Source: DexScreener ──────────────────────────────────────────────────────

async function lookupDexScreener(addr: string, chainHint?: string): Promise<TokenInfo> {
  const [tokenRes, searchRes] = await Promise.allSettled([
    fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, {
      source: "dexscreener", timeoutMs: 12_000, rateCapacity: 10, rateRefillPerSec: 3,
    }),
    fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${addr}`, {
      source: "dexscreener", timeoutMs: 12_000, rateCapacity: 10, rateRefillPerSec: 3,
    }),
  ]);

  let pairs: any[] = [];
  if (tokenRes.status === "fulfilled" && Array.isArray(tokenRes.value?.pairs)) {
    pairs = tokenRes.value.pairs;
  }
  if (!pairs.length && searchRes.status === "fulfilled" && Array.isArray(searchRes.value?.pairs)) {
    // Exact-match filter only makes sense when the input IS an address;
    // name/symbol queries keep every pair the search returned.
    if (detectChainFormat(addr)) {
      const q = addr.toLowerCase();
      pairs = searchRes.value.pairs.filter(
        (p: any) =>
          (p.baseToken?.address ?? "").toLowerCase() === q ||
          (p.quoteToken?.address ?? "").toLowerCase() === q,
      );
    } else {
      pairs = searchRes.value.pairs;
    }
  }

  if (chainHint) {
    const filtered = pairs.filter((p: any) => (p.chainId ?? "").toLowerCase() === chainHint);
    if (filtered.length) pairs = filtered;
  }
  if (!pairs.length) throw new Error("no trading pairs on DexScreener");

  const best = pairs.sort((a: any, b: any) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0];
  const chainId: string = best.chainId ?? "unknown";
  const info = chainInfo(chainId);
  const priceRaw = best.priceUsd ? parseFloat(best.priceUsd) : undefined;

  return {
    name: best.baseToken?.name ?? "Unknown",
    symbol: best.baseToken?.symbol ?? "???",
    chain: info.label,
    chainId,
    chainEmoji: info.emoji,
    address: addr,
    price: fmtPrice(priceRaw),
    priceRaw,
    marketCap: best.marketCap ?? best.fdv,
    liquidity: best.liquidity?.usd,
    volume24h: best.volume?.h24,
    status: "Active Trading",
    dexUrl: best.url,
    imageUrl: best.info?.imageUrl,
    source: "DexScreener",
  };
}

// ─── Source: PumpFun (Solana bonding curve) ───────────────────────────────────

const PUMPFUN_ENDPOINTS = [
  `https://frontend-api.pump.fun/coins/{addr}`,
  `https://client-api-2-74b1891ee9f9.herokuapp.com/coins/{addr}`,
  `https://pump.fun/api/v1/coins/{addr}`,
];

function parsePumpFunPayload(pf: any, address: string): TokenInfo {
  const mc = pf.usd_market_cap ?? pf.market_cap ?? 0;
  const virtualSol = pf.virtual_sol_reserves ?? 0;
  const bc = pf.complete ? 100 : Math.min(Math.round((virtualSol / 85_000) * 100), 99);
  const priceUsd: number | undefined =
    mc > 0 && pf.total_supply ? mc / pf.total_supply : pf.price_in_usd ?? undefined;

  return {
    name: pf.name ?? "Unknown",
    symbol: pf.symbol ?? "???",
    chain: "Solana",
    chainId: "solana",
    chainEmoji: "🟣",
    address,
    price: fmtPrice(priceUsd),
    priceRaw: priceUsd,
    marketCap: mc > 0 ? mc : undefined,
    bondingCurve: bc,
    status: pf.complete ? "Graduated ✅ (Raydium)" : "🔄 Bonding on PumpFun",
    dexUrl: `https://pump.fun/coin/${address}`,
    imageUrl: pf.image_uri,
    source: "PumpFun",
  };
}

async function lookupPumpFun(address: string): Promise<TokenInfo> {
  const results = await Promise.allSettled(
    PUMPFUN_ENDPOINTS.map((tpl) =>
      fetchJson(tpl.replace("{addr}", address), {
        source: "pumpfun", timeoutMs: 7_000, rateCapacity: 6, rateRefillPerSec: 1,
      }),
    ),
  );
  for (const r of results) {
    if (r.status === "fulfilled") {
      const parsed = parsePumpFunPayload(r.value, address);
      if (parsed.name && parsed.symbol) return parsed;
    }
  }
  throw new Error("not found on PumpFun bonding curve");
}

// ─── Source: GeckoTerminal ────────────────────────────────────────────────────

async function lookupGeckoTerminal(address: string, network: string): Promise<TokenInfo> {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}?include=top_pools`;
  const data = await fetchJson(url, {
    source: "geckoterminal", timeoutMs: 10_000, rateCapacity: 15, rateRefillPerSec: 5,
  });
  const attrs = data?.data?.attributes;
  if (!attrs?.name && !attrs?.symbol) throw new Error("no token data on GeckoTerminal");

  // Aggregate market data from the included top pools.
  let volumeH24: number | undefined;
  let liquidity: number | undefined;
  let priceUsd: number | undefined;
  const pools: any[] = data?.included ?? [];
  for (const pool of pools) {
    const pa = pool.attributes ?? {};
    const v = pa.volume_usd?.h24 ? parseFloat(pa.volume_usd.h24) : undefined;
    const liq = pa.reserve_in_usd ? parseFloat(pa.reserve_in_usd) : undefined;
    if (v != null && (volumeH24 == null || v > volumeH24)) volumeH24 = v;
    if (liq != null && (liquidity == null || liq > liquidity)) liquidity = liq;
    const p = pa.base_token_price_usd ?? pa.quote_token_price_usd;
    if (p != null) {
      const n = parseFloat(p);
      if (Number.isFinite(n) && (priceUsd == null || n > 0)) priceUsd ??= n;
    }
  }

  return {
    name: attrs.name ?? "Unknown",
    symbol: attrs.symbol ?? "???",
    chain: chainInfo(network).label,
    chainId: network,
    chainEmoji: chainInfo(network).emoji,
    address,
    price: fmtPrice(priceUsd),
    priceRaw: priceUsd,
    liquidity,
    volume24h: volumeH24,
    status: "Active Trading",
    dexUrl: data?.data?.attributes?.websites?.[0] ?? undefined,
    imageUrl: attrs.image_url,
    source: "GeckoTerminal",
  };
}

/** Used for name/symbol search (no chain known). */
async function searchGeckoTerminal(query: string): Promise<TokenInfo> {
  const data = await fetchJson(
    `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}`,
    { source: "geckoterminal", timeoutMs: 10_000, rateCapacity: 15, rateRefillPerSec: 5 },
  );
  const pools: any[] = data?.data ?? [];
  if (!pools.length) throw new Error("no GeckoTerminal search results");

  const best = pools.sort(
    (a: any, b: any) =>
      parseFloat(b.attributes?.volume_usd?.h24 ?? "0") - parseFloat(a.attributes?.volume_usd?.h24 ?? "0"),
  )[0];
  const attrs = best.attributes;
  const network = best.relationships?.network?.data?.id ?? "unknown";
  const baseAddress = best.relationships?.base_token?.data?.id ?? "";

  // GT search returns POOLS: attributes.name is the pool name ("PEPE / SOL").
  // Derive the token symbol from it; there's no richer token metadata here.
  const poolName: string = attrs?.name ?? "";
  const [symbolPart, quotePart] = poolName.split("/").map((s: string) => s.trim());
  const symbol = (symbolPart || attrs?.symbol || "???").toUpperCase();
  const name = attrs?.name ?? symbol;

  return {
    name,
    symbol,
    chain: chainInfo(network).label,
    chainId: network,
    chainEmoji: chainInfo(network).emoji,
    address: baseAddress,
    price: fmtPrice(parseFloat(attrs?.base_token_price_usd ?? "")),
    priceRaw: parseFloat(attrs?.base_token_price_usd ?? "") || undefined,
    liquidity: parseFloat(attrs?.reserve_in_usd ?? "") || undefined,
    volume24h: parseFloat(attrs?.volume_usd?.h24 ?? "") || undefined,
    status: `Active Trading (${quotePart ? `vs ${quotePart}` : "pool"})`,
    dexUrl: attrs?.address
      ? `https://www.geckoterminal.com/${network}/pools/${attrs.address}`
      : undefined,
    source: "GeckoTerminal",
  };
}

// ─── Source: CoinGecko ────────────────────────────────────────────────────────

async function lookupCoinGecko(address: string, platform: string): Promise<TokenInfo> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env["COINGECKO_API_KEY"]) headers["x-cg-demo-api-key"] = process.env["COINGECKO_API_KEY"]!;

  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/coins/${platform}/contract/${address}`,
    { source: "coingecko", timeoutMs: 10_000, headers, rateCapacity: 10, rateRefillPerSec: 0.2 },
  );
  const md = data?.market_data;
  const chainId = Object.entries(CHAIN_MAP).find(([, v]) => v.coinGeckoPlatform === platform)?.[0] ?? "unknown";

  return {
    name: data?.name ?? "Unknown",
    symbol: (data?.symbol ?? "???").toUpperCase(),
    chain: chainInfo(chainId).label,
    chainId,
    chainEmoji: chainInfo(chainId).emoji,
    address,
    price: fmtPrice(md?.current_price?.usd),
    priceRaw: md?.current_price?.usd,
    marketCap: md?.market_cap?.usd,
    volume24h: md?.total_volume?.usd,
    status: "Listed",
    dexUrl: data?.links?.homepage?.[0] ?? undefined,
    imageUrl: data?.image?.large ?? data?.image?.thumb ?? data?.image?.small,
    source: "CoinGecko",
  };
}

/**
 * CoinGecko coin detail by coin id — used to enrich name-search results with
 * real price/market-cap data and the logo. Works for coins of ANY age,
 * including tokens that stopped trading years ago.
 */
async function lookupCoinGeckoCoin(id: string): Promise<TokenInfo> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env["COINGECKO_API_KEY"]) headers["x-cg-demo-api-key"] = process.env["COINGECKO_API_KEY"]!;

  const data = await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}`, {
    source: "coingecko",
    timeoutMs: 10_000,
    headers,
    rateCapacity: 10,
    rateRefillPerSec: 0.2,
  });
  const md = data?.market_data;
  const platformId = Object.keys(data?.platforms ?? {})[0];
  const chainId =
    Object.entries(CHAIN_MAP).find(([, v]) => v.coinGeckoPlatform === platformId)?.[0] ?? "unknown";
  return {
    name: data?.name ?? id,
    symbol: (data?.symbol ?? "???").toUpperCase(),
    chain: chainInfo(chainId).label,
    chainId,
    chainEmoji: chainInfo(chainId).emoji,
    address: data?.platforms?.[platformId] ?? id,
    price: fmtPrice(md?.current_price?.usd),
    priceRaw: md?.current_price?.usd,
    marketCap: md?.market_cap?.usd,
    volume24h: md?.total_volume?.usd,
    status: "Listed",
    dexUrl: `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}`,
    imageUrl: data?.image?.large ?? data?.image?.thumb ?? data?.image?.small,
    source: "CoinGecko",
  };
}

/**
 * CoinGecko /search — the strongest name/symbol fallback. Covers coins of any
 * age (even delisted-from-trading ones remain in the index) and always has a
 * logo. Enriched with the coin-detail call for live price/MC data.
 */
async function searchCoinGecko(query: string): Promise<TokenInfo> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env["COINGECKO_API_KEY"]) headers["x-cg-demo-api-key"] = process.env["COINGECKO_API_KEY"]!;

  const data = await fetchJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`, {
    source: "coingecko-search",
    timeoutMs: 10_000,
    headers,
    rateCapacity: 10,
    rateRefillPerSec: 0.2,
  });
  const coins: any[] = data?.coins ?? [];
  if (!coins.length) throw new Error("no CoinGecko search results");

  // Prefer an exact symbol/name match, else the most relevant result.
  const q = query.trim().toLowerCase();
  const scored = coins.map((c) => {
    const sym = String(c.symbol ?? "").toLowerCase();
    const name = String(c.name ?? "").toLowerCase();
    let score = 0;
    if (sym === q) score = 3;
    else if (name === q) score = 2;
    else if (sym.startsWith(q) || name.startsWith(q)) score = 1;
    return { c, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Lower market-cap rank (e.g. 1 = Bitcoin) means bigger/older coin — prefer it.
    return (a.c.market_cap_rank ?? Infinity) - (b.c.market_cap_rank ?? Infinity);
  });
  const best = scored[0].c;
  if (!best?.id) throw new Error("no usable CoinGecko result");

  return lookupCoinGeckoCoin(String(best.id));
}

// ─── Source: Birdeye (optional key) ───────────────────────────────────────────

async function lookupBirdeye(address: string, chainId: string): Promise<TokenInfo> {
  const key = process.env["BIRDEYE_API_KEY"];
  if (!key) throw new Error("BIRDEYE_API_KEY not configured (optional source)");
  const birdeyeChain = CHAIN_MAP[chainId]?.birdeyeChain;
  if (!birdeyeChain) throw new Error("chain not supported by Birdeye source");

  const data = await fetchJson(
    `https://public-api.birdeye.so/defi/token_overview?address=${address}`,
    {
      source: "birdeye", timeoutMs: 10_000, rateCapacity: 50, rateRefillPerSec: 1,
      headers: { "X-API-KEY": key, "x-chain": birdeyeChain, accept: "application/json" },
    },
  );
  const d = data?.data;
  if (!d?.symbol && !d?.name) throw new Error("no Birdeye data");

  return {
    name: d.name ?? "Unknown",
    symbol: d.symbol ?? "???",
    chain: chainInfo(chainId).label,
    chainId,
    chainEmoji: chainInfo(chainId).emoji,
    address,
    price: fmtPrice(d.price),
    priceRaw: d.price,
    marketCap: d.mc,
    liquidity: d.liquidity,
    volume24h: d.v24hUSD,
    status: "Listed",
    dexUrl: d.extensions?.website ?? undefined,
    imageUrl: typeof d.logoURI === "string" ? d.logoURI : d.extensions?.logoURI,
    source: "Birdeye",
  };
}

// ─── Source: Jupiter (Solana metadata) ────────────────────────────────────────

async function lookupJupiter(address: string): Promise<TokenInfo> {
  const data = await fetchJson(`https://tokens.jup.ag/token/${address}`, {
    source: "jupiter",
    timeoutMs: 8_000,
    rateCapacity: 20,
    rateRefillPerSec: 5,
    headers: { "user-agent": "dex-boost-bot/1.0", accept: "application/json" },
  });
  if (!data?.name && !data?.symbol) throw new Error("no Jupiter token metadata");
  return {
    name: data.name ?? "Unknown",
    symbol: data.symbol ?? "???",
    chain: "Solana",
    chainId: "solana",
    chainEmoji: "🟣",
    address,
    status: "Metadata only",
    source: "Jupiter",
  };
}

// ─── Source: Moralis (optional key, EVM only) ─────────────────────────────────

async function lookupMoralis(address: string, chainId: string): Promise<TokenInfo> {
  const key = process.env["MORALIS_API_KEY"];
  if (!key) throw new Error("MORALIS_API_KEY not configured (optional source)");
  const moralisChain = CHAIN_MAP[chainId]?.moralisChain;
  if (!moralisChain) throw new Error("chain not supported by Moralis source");

  const data = await fetchJson(
    `https://deep-index.moralis.io/api/v2.2/erc20/metadata?chain=${moralisChain}&addresses=${address}`,
    { source: "moralis", timeoutMs: 10_000, rateCapacity: 20, rateRefillPerSec: 0.5, headers: { "X-API-Key": key } },
  );
  const d = Array.isArray(data) ? data[0] : data;
  if (!d?.name && !d?.symbol) throw new Error("no Moralis metadata");
  return {
    name: d.name ?? "Unknown",
    symbol: d.symbol ?? "???",
    chain: chainInfo(chainId).label,
    chainId,
    chainEmoji: chainInfo(chainId).emoji,
    address,
    status: "Metadata only",
    imageUrl: typeof d.logo === "string" ? d.logo : undefined,
    source: "Moralis",
  };
}

// ─── Solana on-chain source ──────────────────────────────────────────────────
//
// Reads token metadata and pump.fun bonding-curve state DIRECTLY from the
// Solana chain. This is the source that resolves coins no API still knows
// about: months-old pump.fun tokens, dead pools, delisted coins — any mint
// that ever existed. Three metadata layouts are handled:
//   1. Metaplex Token Metadata PDA (most coins, incl. old pump.fun)
//   2. Raw account-buffer URI scan (pump.fun's newer on-chain format)
//   3. The metadata URI JSON itself (authoritative name/symbol/image)

const SOLANA_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const SOLANA_RPC_FALLBACKS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

function solanaRpcUrls(): string[] {
  const custom = process.env["SOLANA_RPC_URL"]?.trim();
  const list = custom ? [custom] : [];
  return [...list, ...SOLANA_RPC_FALLBACKS.filter((u) => u !== custom)];
}

/** JSON-RPC call with the shared rate-limit bucket + one retry. */
async function solanaRpc(rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  await bucketFor("solana-rpc", 15, 5).take();
  const started = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { error?: { message?: string }; result?: unknown };
      if (data.error) throw new Error(`rpc: ${data.error.message ?? "error"}`);
      recordSourceResult("solana-rpc", true, Date.now() - started);
      return data.result;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await sleep(500);
    }
  }
  recordSourceResult("solana-rpc", false, Date.now() - started, String(lastErr));
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Try every configured RPC URL until one returns the account (or all fail). */
async function solanaGetAccount(pubkey: string): Promise<{ data: Buffer } | null> {
  for (const rpc of solanaRpcUrls()) {
    try {
      const result = await solanaRpc(rpc, "getAccountInfo", [pubkey, { encoding: "base64" }]);
      const data = result?.value?.data;
      if (Array.isArray(data) && typeof data[0] === "string") {
        return { data: Buffer.from(data[0], "base64") };
      }
      return null; // account does not exist on this RPC (authoritative answer)
    } catch {
      // try the next RPC
    }
  }
  return null;
}

/** Parse Metaplex MetadataV1 account (borsh strings at fixed offsets). */
function parseMetaplexMetadata(b: Buffer): { name: string; symbol: string; uri: string | null } | null {
  if (b.length < 120 || b[0] !== 4) return null;
  let off = 65;
  const readStr = (): string | null => {
    if (off + 4 > b.length) return null;
    const len = b.readUInt32LE(off);
    off += 4;
    if (off + len > b.length) return null;
    const s = b.subarray(off, off + len).toString("utf8").replace(/\0+$/g, "").trim();
    off += len;
    return s;
  };
  const name = readStr();
  const symbol = readStr();
  const uri = readStr();
  return name && symbol ? { name, symbol, uri } : null;
}

/** Scan a raw account buffer for the first http(s)/ipfs/ar URI (new pump.fun layout). */
function scanUriFromBuffer(b: Buffer): string | null {
  const text = b.toString("utf8");
  const m = text.match(/https?:\/\/[^\x00-\x1f" ]+/i) ?? text.match(/ipfs:\/\/[A-Za-z0-9/._-]+/i);
  return m ? m[0] : null;
}

/** Convert ipfs:// / ar:// URIs into fetchable https gateways. */
function normalizeMetadataUri(uri: string): string {
  const u = uri.trim();
  if (u.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${u.slice("ipfs://".length)}`;
  if (u.startsWith("ar://")) return `https://arweave.net/${u.slice("ar://".length)}`;
  return u;
}

interface UriMetadata {
  name?: string;
  symbol?: string;
  image?: string;
}

/** Fetch the metadata URI JSON — authoritative name/symbol/image. */
async function fetchUriMetadata(uri: string): Promise<UriMetadata | null> {
  try {
    await bucketFor("solana-metadata", 8, 3).take();
    const res = await fetch(normalizeMetadataUri(uri), {
      signal: AbortSignal.timeout(6_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    return {
      name: typeof json.name === "string" ? json.name : undefined,
      symbol: typeof json.symbol === "string" ? json.symbol : undefined,
      image: typeof json.image === "string" ? json.image : undefined,
    };
  } catch {
    return null;
  }
}

// SOL/USD price cache (used to enrich bonding-curve data; best-effort only).
let solUsdCache: { price: number; at: number } | null = null;

async function getSolUsd(): Promise<number | null> {
  if (solUsdCache && Date.now() - solUsdCache.at < 10 * 60_000) return solUsdCache.price;
  try {
    await bucketFor("coingecko-price", 3, 0.1).take();
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { solana?: { usd?: number } };
    const price = json.solana?.usd;
    if (typeof price === "number" && price > 0) {
      solUsdCache = { price, at: Date.now() };
      return price;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

/** The on-chain Solana source: any mint that ever existed gets a result. */
async function lookupSolanaOnChain(mint: string): Promise<TokenInfo> {
  let name: string | undefined;
  let symbol: string | undefined;
  let uri: string | undefined;

  // 1. Metaplex metadata PDA (standard layout).
  const [metaPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), SOLANA_METADATA_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
    SOLANA_METADATA_PROGRAM,
  );
  const metaAcct = await solanaGetAccount(metaPda.toBase58());
  if (metaAcct) {
    const parsed = parseMetaplexMetadata(metaAcct.data);
    if (parsed) {
      name = parsed.name;
      symbol = parsed.symbol;
      if (parsed.uri) uri = parsed.uri;
    }
  }

  // 2. No PDA → scan the mint account itself (pump.fun's newer format).
  if (!name || !symbol) {
    const mintAcct = await solanaGetAccount(mint);
    if (mintAcct) {
      const scanned = scanUriFromBuffer(mintAcct.data);
      if (scanned) uri = scanned;
    }
  }

  // 3. URI JSON is authoritative for name/symbol/image when available.
  let imageUrl: string | undefined;
  if (uri) {
    const md = await fetchUriMetadata(uri);
    if (md) {
      if (!name) name = md.name;
      if (!symbol) symbol = md.symbol;
      if (md.image) imageUrl = md.image.startsWith("ipfs://") ? normalizeMetadataUri(md.image) : md.image;
    }
  }

  if (!name || !symbol) {
    throw new Error("no on-chain metadata for this mint");
  }

  // 4. pump.fun bonding curve state (price / market cap / status).
  let status = "On-chain metadata — no active trading";
  let priceStr: string | undefined;
  let priceRaw: number | undefined;
  let marketCap: number | undefined;
  let bondingCurve: number | undefined;
  let dexUrl: string | undefined;

  const [bcPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    PUMP_FUN_PROGRAM,
  );
  const bcAcct = await solanaGetAccount(bcPda.toBase58());
  if (bcAcct && bcAcct.data.length >= 49) {
    const b = bcAcct.data;
    const u64 = (o: number) => b.readBigUInt64LE(o);
    const vTok = u64(8);
    const vSol = u64(16);
    const total = u64(40);
    const complete = b[48];
    dexUrl = `https://pump.fun/coin/${mint}`;

    if (complete === 1 && vTok === 0n && vSol === 0n) {
      status = "Graduated ✅ (bonding curve complete)";
    } else if (vTok > 0n && vSol > 0n) {
      const priceSol = Number(vSol) / 1e9 / (Number(vTok) / 1e6);
      const mcSol = (priceSol * Number(total)) / 1e6;
      priceStr = `${priceSol.toFixed(8)} SOL`;
      status = "🔄 Bonding Curve (live)";
      const solUsd = await getSolUsd();
      if (solUsd) {
        priceRaw = priceSol * solUsd;
        priceStr = fmtPrice(priceRaw);
        marketCap = mcSol * solUsd;
        // pump.fun curves graduate at ~$69k market cap.
        bondingCurve = Math.min(Math.round(((mcSol * solUsd) / 69_000) * 100), 99);
      }
    } else {
      status = "Bonding curve settled — no active trading";
    }
  }

  return {
    name,
    symbol: symbol.toUpperCase(),
    chain: "Solana",
    chainId: "solana",
    chainEmoji: "🟣",
    address: mint,
    price: priceStr,
    priceRaw,
    marketCap,
    bondingCurve,
    status,
    dexUrl,
    imageUrl,
    source: "SolanaOnChain",
  };
}

// ─── EVM chain auto-detection (GeckoTerminal network probes) ──────────────────

export async function detectEvmChain(address: string): Promise<string | null> {
  // Stagger launches by a hair so the burst of parallel requests doesn't trip
  // upstream rate limits on shared egress IPs (429s are the main flake source).
  const launched: Promise<unknown>[] = [];
  for (let i = 0; i < EVM_PROBE_NETWORKS.length; i++) {
    const net = EVM_PROBE_NETWORKS[i];
    const probe = (async () => {
      const data = await fetchJson(
        `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${address}`,
        { source: "geckoterminal-probe", timeoutMs: 4_000, retries: 1, rateCapacity: 25, rateRefillPerSec: 8 },
      );
      if (data?.data?.attributes?.address) return net;
      throw new Error("absent");
    })();
    // Attach a handler immediately so a fast rejection (e.g. HTTP 404 on a
    // network the contract isn't on) is never an unhandled rejection while
    // we stagger the remaining launches. Promise.allSettled below does the
    // real inspection.
    probe.catch(() => {});
    launched.push(probe);
    if (i < EVM_PROBE_NETWORKS.length - 1) await sleep(120);
  }

  const results = await Promise.allSettled(launched);
  for (const r of results) {
    if (r.status === "fulfilled" && typeof r.value === "string") return r.value;
  }
  return null;
}

// ─── Formatting helper ────────────────────────────────────────────────────────

function fmtPrice(n: number | undefined): string | undefined {
  if (n == null || Number.isNaN(n)) return undefined;
  if (n < 0.001) return `$${n.toFixed(8)}`;
  if (n < 1) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

// ─── TTL cache ────────────────────────────────────────────────────────────────

interface CacheEntry {
  token: TokenInfo | null;
  tried: SourceResult[];
  at: number;
}

class LookupCache {
  private readonly map = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  private key(addr: string, chainHint?: string): string {
    return `${chainHint ?? "*"}:${addr.trim().toLowerCase()}`;
  }

  get(addr: string, chainHint?: string): CacheEntry | undefined {
    const k = this.key(addr, chainHint);
    const entry = this.map.get(k);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    // Touch for LRU-ish eviction.
    this.map.delete(k);
    this.map.set(k, entry);
    return entry;
  }

  set(addr: string, chainHint: string | undefined, entry: CacheEntry): void {
    const k = this.key(addr, chainHint);
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(k, entry);
    setLookupCacheSize(this.map.size);
  }

  size(): number {
    return this.map.size;
  }
}

// ─── Result ranking & merging ─────────────────────────────────────────────────

/** Richness: prefer results carrying real market data. */
function richness(t: TokenInfo): number {
  let score = 0;
  if (t.marketCap != null) score += 2;
  if (t.liquidity != null) score += 1;
  if (t.priceRaw != null) score += 1;
  if (t.volume24h != null) score += 1;
  if (t.bondingCurve != null) score += 1;
  return score;
}

const PRIORITY: Record<string, number> = {
  dexscreener: 0,
  geckoterminal: 1,
  coingecko: 2,
  pumpfun: 3,
  birdeye: 4,
  moralis: 5,
  jupiter: 6,
};

function pickWinner(results: TokenInfo[]): TokenInfo {
  return results
    .slice()
    .sort((a, b) => {
      const r = richness(b) - richness(a);
      if (r !== 0) return r;
      return (PRIORITY[a.source] ?? 99) - (PRIORITY[b.source] ?? 99);
    })[0];
}

/** Fill missing fields of the winner from the other results. */
function mergeResults(winner: TokenInfo, others: TokenInfo[]): TokenInfo {
  const merged: TokenInfo = { ...winner };
  const sources = new Set<string>([winner.source]);
  for (const t of others) {
    sources.add(t.source);
    if (merged.priceRaw == null && t.priceRaw != null) {
      merged.priceRaw = t.priceRaw;
      merged.price = t.price;
    }
    if (merged.marketCap == null && t.marketCap != null) merged.marketCap = t.marketCap;
    if (merged.liquidity == null && t.liquidity != null) merged.liquidity = t.liquidity;
    if (merged.volume24h == null && t.volume24h != null) merged.volume24h = t.volume24h;
    if (merged.bondingCurve == null && t.bondingCurve != null) merged.bondingCurve = t.bondingCurve;
    if (!merged.dexUrl && t.dexUrl) merged.dexUrl = t.dexUrl;
    if (!merged.imageUrl && t.imageUrl) merged.imageUrl = t.imageUrl;
    if (merged.name === "Unknown" && t.name !== "Unknown") merged.name = t.name;
    if (merged.symbol === "???" && t.symbol !== "???") merged.symbol = t.symbol;
  }
  merged.sources = [...sources];
  return merged;
}

/**
 * Best-effort logo enrichment: when the winning result has no image (some
 * DexScreener pairs lack info.imageUrl), query GeckoTerminal/CoinGecko for
 * the same contract to grab the logo. Adds at most one parallel round-trip.
 */
async function enrichMissingImage(t: TokenInfo): Promise<TokenInfo> {
  if (t.imageUrl) return t;
  const gt = CHAIN_MAP[t.chainId]?.geckoTerminalNetwork;
  const cg = CHAIN_MAP[t.chainId]?.coinGeckoPlatform;
  const jobs: Promise<TokenInfo | null>[] = [];
  if (gt) jobs.push(lookupGeckoTerminal(t.address, gt).catch(() => null));
  if (cg) jobs.push(lookupCoinGecko(t.address, cg).catch(() => null));
  if (!jobs.length) return t;

  // Best-effort with a hard 3s budget — image enrichment must never delay
  // the answer. (Promise.race, not allSettled: a slow rate-limited job must
  // not hold the response hostage.)
  const budget = new Promise<TokenInfo | null>((resolve) => setTimeout(() => resolve(null), 3000));
  const firstWithImage = Promise.allSettled(jobs).then((rs) => {
    for (const r of rs) {
      if (r.status === "fulfilled" && r.value?.imageUrl) return r.value;
    }
    return null;
  });
  const enriched = await Promise.race([firstWithImage, budget]);
  if (enriched?.imageUrl) {
    t.imageUrl = enriched.imageUrl;
    t.sources = [...(t.sources ?? [t.source]), enriched.source];
  }
  return t;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

let cache: LookupCache | null = null;

function getCache(): LookupCache {
  if (!cache) {
    const ttl = Number(process.env["LOOKUP_CACHE_TTL_MS"] ?? 300_000);
    const max = Number(process.env["LOOKUP_CACHE_MAX_ENTRIES"] ?? 1000);
    cache = new LookupCache(Number.isFinite(ttl) ? ttl : 300_000, Number.isFinite(max) ? max : 1000);
  }
  return cache;
}

async function trySource(
  name: string,
  fn: () => Promise<TokenInfo | null>,
  results: TokenInfo[],
  tried: SourceResult[],
  open?: () => boolean,
): Promise<void> {
  const started = Date.now();
  try {
    const token = await fn();
    // If the wave was cut short by the fast path, late results are not merged
    // into the answer but still count as telemetry.
    if (token && (open?.() ?? true)) results.push(token);
    tried.push({ source: name, ok: true, ms: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tried.push({ source: name, ok: false, ms: Date.now() - started, error: message });
  }
}

/**
 * Race a wave of sources: resolve as soon as (a) everything settled, or
 * (b) at least one result exists and a 1.5s grace period passed, or (c) an
 * 8s hard ceiling elapsed. Keeps lookups fast even when one upstream API is
 * rate-limiting us; remaining fetches finish in the background.
 */
async function raceWave(wave: Promise<void>[], hasResult: () => boolean): Promise<void> {
  const settled = Promise.allSettled(wave);
  const fastPath = new Promise<void>((resolve) => {
    const t0 = Date.now();
    const tick = (): void => {
      const elapsed = Date.now() - t0;
      if (hasResult() && elapsed > 1500) resolve();
      else if (elapsed >= 8000) resolve();
      else setTimeout(tick, 120);
    };
    tick();
  });
  await Promise.race([settled, fastPath]);
}

export async function lookupToken(
  rawAddress: string,
  opts: LookupOptions = {},
): Promise<TokenLookupResult> {
  const address = rawAddress.trim();
  const started = Date.now();
  const tried: SourceResult[] = [];
  const results: TokenInfo[] = [];

  const format = detectChainFormat(address);

  // Name/symbol search path (query mode).
  if (opts.isQuery || !format) {
    const cacheHit = getCache().get(`q:${address}`);
    if (cacheHit) {
      recordLookupResult(cacheHit.token != null, true);
      return { token: cacheHit.token, tried: cacheHit.tried, fromCache: true };
    }
    let waveOpen = true;
    const isOpen = (): boolean => waveOpen;
    await raceWave(
      [
        trySource("dexscreener-search", async () => {
          const t = await lookupDexScreener(address);
          return t;
        }, results, tried, isOpen),
        trySource("geckoterminal-search", () => searchGeckoTerminal(address), results, tried, isOpen),
        trySource("coingecko-search", () => searchCoinGecko(address), results, tried, isOpen),
      ],
      () => results.length > 0,
    );
    waveOpen = false;
    let token = results.length ? mergeResults(pickWinner(results), results) : null;
    if (token) token = await enrichMissingImage(token);
    recordLookupResult(token != null, false);
    const entry = { token, tried, at: Date.now() };
    getCache().set(`q:${address}`, undefined, entry);
    return { token, tried };
  }

  // Address path.
  let chainHint = opts.chainHint;
  const cacheHit = getCache().get(address, chainHint);
  if (cacheHit) {
    recordLookupResult(cacheHit.token != null, true);
    return { token: cacheHit.token, tried: cacheHit.tried, fromCache: true };
  }

  // Chain implied by the address format (Solana / TON) — used so every
  // chain-specific source runs even without an explicit chain hint.
  const formatChainId = format === "solana" ? "solana" : format === "ton" ? "ton" : undefined;
  const effectiveChainId = chainHint ?? formatChainId;
  const chain = CHAIN_MAP[effectiveChainId ?? ""];

  // Wave 1 — everything we can query in parallel.
  let waveOpen = true;
  const isOpen = (): boolean => waveOpen;
  const wave1: Promise<void>[] = [
    trySource("dexscreener", () => lookupDexScreener(address, chainHint), results, tried, isOpen),
  ];

  if (format === "solana") {
    wave1.push(trySource("pumpfun", () => lookupPumpFun(address), results, tried, isOpen));
    wave1.push(trySource("jupiter", () => lookupJupiter(address), results, tried, isOpen));
    // The on-chain source resolves ANY mint that ever existed — old coins,
    // dead pools, live bonding curves. Always tried for Solana.
    wave1.push(trySource("solana-onchain", () => lookupSolanaOnChain(address), results, tried, isOpen));
    if (process.env["BIRDEYE_API_KEY"]) {
      wave1.push(trySource("birdeye", () => lookupBirdeye(address, "solana"), results, tried, isOpen));
    }
  }

  if (chain?.geckoTerminalNetwork) {
    wave1.push(
      trySource("geckoterminal", () => lookupGeckoTerminal(address, chain.geckoTerminalNetwork!), results, tried, isOpen),
    );
  }
  if (chain?.coinGeckoPlatform) {
    wave1.push(
      trySource("coingecko", () => lookupCoinGecko(address, chain.coinGeckoPlatform!), results, tried, isOpen),
    );
  }
  if (format === "evm" && chain?.moralisChain && process.env["MORALIS_API_KEY"]) {
    wave1.push(trySource("moralis", () => lookupMoralis(address, chainHint!), results, tried, isOpen));
  }

  await raceWave(wave1, () => results.length > 0);
  waveOpen = false;

  // Wave 2 — EVM auto-detection when the user didn't pick a chain.
  let detectedChain: string | undefined;
  if (!results.length && format === "evm" && !chainHint && opts.autoDetectEvmChain !== false) {
    logger.info({ address }, "EVM address not found in wave 1 — probing networks");
    const startedProbe = Date.now();
    try {
      const net = await detectEvmChain(address);
      detectedChain = net ?? undefined;
      tried.push({
        source: "evm-chain-probe",
        ok: !!net,
        ms: Date.now() - startedProbe,
        error: net ? undefined : "contract not found on probed networks",
      });
      if (net) {
        await trySource("geckoterminal", () => lookupGeckoTerminal(address, net), results, tried);
        const cgPlatform = CHAIN_MAP[net]?.coinGeckoPlatform;
        if (cgPlatform) {
          await trySource("coingecko", () => lookupCoinGecko(address, cgPlatform), results, tried);
        }
      }
    } catch (err) {
      tried.push({
        source: "evm-chain-probe",
        ok: false,
        ms: Date.now() - startedProbe,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Wave 3 — chain-agnostic CoinGecko check for EVM when nothing matched and a
  // chain WAS provided but the token may live elsewhere (data-quality fallback
  // only; keeps the previous chain hint out of the cache key).
  if (!results.length && format === "evm" && chainHint && opts.autoDetectEvmChain !== false) {
    detectedChain = await detectEvmChain(address) ?? undefined;
    if (detectedChain) {
      await trySource("geckoterminal", () => lookupGeckoTerminal(address, detectedChain!), results, tried);
    }
  }

  let token = results.length ? mergeResults(pickWinner(results), results) : null;
  if (token) token = await enrichMissingImage(token);
  recordLookupResult(token != null, false);
  getCache().set(address, chainHint, { token, tried, at: Date.now() });

  logger.info(
    { address, chainHint, detectedChain, ok: token != null, ms: Date.now() - started, sources: token?.sources },
    "Token lookup completed",
  );

  return { token, tried, detectedChain };
}
