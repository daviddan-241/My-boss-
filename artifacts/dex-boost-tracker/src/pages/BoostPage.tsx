import { useState, useEffect, useCallback, useMemo } from "react";
import { RefreshCw, Zap, Trophy, Clock, AlertCircle, Rocket, Send } from "lucide-react";
import { BoostToken, fetchLatestBoosts, fetchTopBoosts } from "@/lib/dexscreener";
import { TokenCard } from "@/components/TokenCard";
import { FilterBar } from "@/components/FilterBar";
import { BoostTokenModal } from "@/components/BoostTokenModal";
import { ShareButton } from "@/components/ShareButton";

type Tab = "latest" | "top" | "all";

const REFRESH_INTERVAL = 30_000;

export function BoostPage() {
  const [tab, setTab] = useState<Tab>("latest");
  const [latest, setLatest] = useState<BoostToken[]>([]);
  const [top, setTop] = useState<BoostToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL / 1000);
  const [search, setSearch] = useState("");
  const [selectedChain, setSelectedChain] = useState("");
  const [showBoostModal, setShowBoostModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [latestData, topData] = await Promise.all([
        fetchLatestBoosts(),
        fetchTopBoosts(),
      ]);
      setLatest(Array.isArray(latestData) ? latestData : []);
      setTop(Array.isArray(topData) ? topData : []);
      setLastRefreshed(new Date());
      setCountdown(REFRESH_INTERVAL / 1000);
    } catch {
      setError("Failed to fetch boost data. DexScreener API may be unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : REFRESH_INTERVAL / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [lastRefreshed]);

  // "all" merges latest + top, deduplicating by chainId+tokenAddress
  const all = useMemo(() => {
    const seen = new Set<string>();
    const merged: BoostToken[] = [];
    for (const t of [...latest, ...top]) {
      const key = `${t.chainId}:${t.tokenAddress}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(t);
      }
    }
    return merged;
  }, [latest, top]);

  const tokens = tab === "latest" ? latest : tab === "top" ? top : all;

  const availableChains = useMemo(() => {
    const chains = [...new Set(tokens.map((t) => t.chainId))];
    return chains.sort();
  }, [tokens]);

  const filtered = useMemo(() => {
    let list = tokens;
    if (selectedChain) list = list.filter((t) => t.chainId === selectedChain);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.tokenAddress.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [tokens, selectedChain, search]);

  const goldenCount = top.filter((t) => (t.totalAmount ?? 0) >= 500).length;
  const totalUnique = all.length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center glow-green">
                <Zap className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-base font-bold text-foreground leading-none">
                  DexScreener Boosts
                </h1>
                <p className="text-xs text-muted-foreground">Live boost tracker</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Telegram bot link */}
              <a
                href="https://t.me/DexscreenersBoostBot"
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 text-xs font-semibold transition-colors border border-blue-500/20"
              >
                <Send className="w-3.5 h-3.5" />
                Telegram Bot
              </a>

              {/* Boost your token */}
              <button
                onClick={() => setShowBoostModal(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary text-xs font-semibold transition-colors border border-primary/20"
              >
                <Rocket className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Boost Token</span>
                <span className="sm:hidden">Boost</span>
              </button>

              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="w-3.5 h-3.5" />
                <span className="font-mono font-semibold text-foreground">{countdown}s</span>
              </div>
              <button
                onClick={load}
                disabled={loading}
                className="p-1.5 rounded-lg bg-accent hover:bg-accent/80 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </button>
              <ShareButton />
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-5 space-y-5">
        {/* Stats bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="Latest"
            value={latest.length}
            icon={<Clock className="w-4 h-4 text-primary" />}
            onClick={() => setTab("latest")}
            active={tab === "latest"}
          />
          <StatCard
            label="Top Boosted"
            value={top.length}
            icon={<Trophy className="w-4 h-4 text-yellow-400" />}
            onClick={() => setTab("top")}
            active={tab === "top"}
          />
          <StatCard
            label="Golden Tickers"
            value={goldenCount}
            icon={<span className="text-yellow-400 text-sm">★</span>}
          />
          <StatCard
            label="All Tokens"
            value={totalUnique}
            icon={<Zap className="w-4 h-4 text-blue-400" />}
            onClick={() => setTab("all")}
            active={tab === "all"}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-card border border-border rounded-lg w-fit">
          <TabBtn active={tab === "latest"} onClick={() => setTab("latest")}>
            <Clock className="w-3.5 h-3.5" />
            Latest
          </TabBtn>
          <TabBtn active={tab === "top"} onClick={() => setTab("top")}>
            <Trophy className="w-3.5 h-3.5" />
            Top Boosted
          </TabBtn>
          <TabBtn active={tab === "all"} onClick={() => setTab("all")}>
            <Zap className="w-3.5 h-3.5" />
            All ({totalUnique})
          </TabBtn>
        </div>

        {/* Filter */}
        <FilterBar
          search={search}
          onSearch={setSearch}
          selectedChain={selectedChain}
          onSelectChain={setSelectedChain}
          availableChains={availableChains}
        />

        {/* Meta line */}
        {lastRefreshed && (
          <p className="text-xs text-muted-foreground">
            Updated {lastRefreshed.toLocaleTimeString()} · {filtered.length} token{filtered.length !== 1 ? "s" : ""}
          </p>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-4 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && filtered.length === 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="h-48 rounded-xl bg-card border border-border animate-pulse" />
            ))}
          </div>
        )}

        {/* Empty */}
        {!loading && filtered.length === 0 && !error && (
          <div className="text-center py-16 text-muted-foreground">
            <Zap className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No tokens found matching your filters.</p>
          </div>
        )}

        {/* Token grid */}
        {filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((token, i) => (
              <TokenCard
                key={`${token.chainId}-${token.tokenAddress}-${i}`}
                token={token}
                rank={tab === "top" ? i + 1 : undefined}
              />
            ))}
          </div>
        )}

        {/* Telegram + Boost CTA footer */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-border">
          <a
            href="https://t.me/DexscreenersBoostBot"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 p-4 rounded-xl bg-blue-500/10 border border-blue-500/30 hover:bg-blue-500/20 transition-colors"
          >
            <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center flex-shrink-0">
              <Send className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-blue-300">Telegram Bot</p>
              <p className="text-xs text-muted-foreground">
                Get live boost alerts on Telegram
              </p>
            </div>
          </a>

          <button
            onClick={() => setShowBoostModal(true)}
            className="flex items-center gap-3 p-4 rounded-xl bg-primary/10 border border-primary/30 hover:bg-primary/20 transition-colors text-left"
          >
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center flex-shrink-0">
              <Rocket className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-primary">Boost Your Token</p>
              <p className="text-xs text-muted-foreground">
                Create & boost your token on DexScreener
              </p>
            </div>
          </button>
        </div>
      </div>

      {/* Boost modal */}
      {showBoostModal && (
        <BoostTokenModal onClose={() => setShowBoostModal(false)} />
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-semibold transition-all ${
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground hover:bg-accent"
      }`}
    >
      {children}
    </button>
  );
}

function StatCard({
  label,
  value,
  icon,
  className = "",
  onClick,
  active,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  className?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col gap-1 p-3 rounded-xl border text-left transition-all w-full ${
        active
          ? "bg-primary/10 border-primary/40"
          : "bg-card border-border hover:border-border/80"
      } ${onClick ? "cursor-pointer hover:bg-accent/50" : "cursor-default"} ${className}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        {icon}
      </div>
      <span className="text-2xl font-bold font-mono text-foreground">{value}</span>
    </button>
  );
}
