export interface BoostToken {
  url: string;
  chainId: string;
  tokenAddress: string;
  amount: number | undefined;
  totalAmount: number | undefined;
  icon?: string;
  header?: string;
  description?: string;
  links?: { type?: string; label: string; url: string }[];
}

export interface TokenPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd?: string;
  txns?: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume?: { h24: number; h6: number; h1: number; m5: number };
  priceChange?: { m5: number; h1: number; h6: number; h24: number };
  liquidity?: { usd: number; base: number; quote: number };
  fdv?: number;
  marketCap?: number;
}

const BASE_URL = "https://api.dexscreener.com";

export async function fetchLatestBoosts(): Promise<BoostToken[]> {
  const res = await fetch(`${BASE_URL}/token-boosts/latest/v1`);
  if (!res.ok) throw new Error("Failed to fetch latest boosts");
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchTopBoosts(): Promise<BoostToken[]> {
  const res = await fetch(`${BASE_URL}/token-boosts/top/v1`);
  if (!res.ok) throw new Error("Failed to fetch top boosts");
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/** Merge latest + top, deduplicating by chainId+tokenAddress, to show more tokens */
export async function fetchAllBoosts(): Promise<{ latest: BoostToken[]; top: BoostToken[] }> {
  const [latest, top] = await Promise.all([fetchLatestBoosts(), fetchTopBoosts()]);
  return { latest, top };
}

export async function fetchTokenPairs(
  chainId: string,
  tokenAddress: string
): Promise<TokenPair[]> {
  try {
    const res = await fetch(`${BASE_URL}/latest/dex/tokens/${tokenAddress}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.pairs || []).filter((p: TokenPair) => p.chainId === chainId);
  } catch {
    return [];
  }
}

export function formatNumber(value: number | undefined): string {
  if (value == null) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatPrice(price: string | undefined): string {
  if (!price) return "—";
  const n = parseFloat(price);
  if (isNaN(n)) return "—";
  if (n < 0.00001) return `$${n.toExponential(3)}`;
  if (n < 0.001) return `$${n.toFixed(7)}`;
  if (n < 1) return `$${n.toFixed(5)}`;
  if (n < 1000) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export const CHAIN_LABELS: Record<string, string> = {
  solana: "SOL",
  ethereum: "ETH",
  bsc: "BSC",
  arbitrum: "ARB",
  base: "BASE",
  polygon: "MATIC",
  avalanche: "AVAX",
  optimism: "OP",
  fantom: "FTM",
  cronos: "CRO",
  sui: "SUI",
  aptos: "APT",
  ton: "TON",
  tron: "TRX",
  near: "NEAR",
};

export const CHAIN_COLORS: Record<string, string> = {
  solana: "#9945FF",
  ethereum: "#627EEA",
  bsc: "#F3BA2F",
  arbitrum: "#28A0F0",
  base: "#0052FF",
  polygon: "#8247E5",
  avalanche: "#E84142",
  optimism: "#FF0420",
  fantom: "#1969FF",
  cronos: "#002D74",
  sui: "#6FBCF0",
  aptos: "#00D5AD",
  ton: "#0088CC",
  tron: "#EF0027",
  near: "#00C08B",
};
