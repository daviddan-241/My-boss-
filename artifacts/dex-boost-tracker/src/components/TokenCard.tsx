import { useState } from "react";
import { ChevronDown, ChevronUp, Copy, Check, TrendingUp, TrendingDown } from "lucide-react";
import { BoostToken, TokenPair, fetchTokenPairs, formatNumber, formatPrice } from "@/lib/dexscreener";
import { ChainBadge } from "./ChainBadge";
import { BoostBar } from "./BoostBar";
import { SocialLinks } from "./SocialLinks";
import { ShareButton } from "./ShareButton";

interface TokenCardProps {
  token: BoostToken;
  rank?: number;
}

export function TokenCard({ token, rank }: TokenCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [pairs, setPairs] = useState<TokenPair[] | null>(null);
  const [loadingPairs, setLoadingPairs] = useState(false);
  const [copied, setCopied] = useState(false);

  const isGolden = (token.totalAmount ?? 0) >= 500;

  const toggleExpand = async () => {
    if (!expanded && pairs === null) {
      setLoadingPairs(true);
      try {
        const fetched = await fetchTokenPairs(token.chainId, token.tokenAddress);
        setPairs(fetched.slice(0, 3));
      } finally {
        setLoadingPairs(false);
      }
    }
    setExpanded((e) => !e);
  };

  const copyAddress = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(token.tokenAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const topPair = pairs?.[0];

  return (
    <div
      className={`rounded-xl border transition-all duration-200 cursor-pointer hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 ${
        isGolden
          ? "border-yellow-500/40 bg-gradient-to-br from-card to-yellow-950/20 hover:border-yellow-400/60 hover:shadow-yellow-500/10"
          : "border-border bg-card"
      }`}
      onClick={toggleExpand}
    >
      {/* Header image */}
      {token.header && (
        <div className="relative h-20 overflow-hidden rounded-t-xl">
          <img
            src={token.header}
            alt=""
            className="w-full h-full object-cover opacity-60"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-card" />
          {rank != null && (
            <div className="absolute top-2 left-2 w-6 h-6 rounded-full bg-background/80 flex items-center justify-center text-xs font-bold text-muted-foreground">
              {rank}
            </div>
          )}
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Top row */}
        <div className="flex items-start gap-3">
          {token.icon ? (
            <img
              src={token.icon}
              alt=""
              className={`w-10 h-10 rounded-full flex-shrink-0 ${isGolden ? "ring-2 ring-yellow-400/60 glow-gold" : "ring-1 ring-border"}`}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-accent flex-shrink-0 flex items-center justify-center text-lg font-bold text-muted-foreground">
              ?
            </div>
          )}

          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <ChainBadge chainId={token.chainId} />
              {isGolden && (
                <span className="text-xs font-bold text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded border border-yellow-400/30">
                  ★ Golden
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <code className="text-xs text-muted-foreground font-mono truncate">
                {token.tokenAddress.slice(0, 8)}...{token.tokenAddress.slice(-6)}
              </code>
              <button
                onClick={copyAddress}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
              >
                {copied ? (
                  <Check className="w-3 h-3 text-primary" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            </div>
          </div>

          <button className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors p-1">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {/* Description */}
        {token.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">{token.description}</p>
        )}

        {/* Boost bar */}
        <BoostBar amount={token.amount} totalAmount={token.totalAmount} isGolden={isGolden} />

        {/* Social links + share */}
        <div className="flex items-start justify-between gap-2">
          <SocialLinks links={token.links} tokenUrl={token.url} />
          <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <ShareButton tokenAddress={token.tokenAddress} chainId={token.chainId} />
          </div>
        </div>

        {/* Expanded pair data */}
        {expanded && (
          <div
            className="border-t border-border pt-3 space-y-2"
            onClick={(e) => e.stopPropagation()}
          >
            {loadingPairs && (
              <div className="text-xs text-muted-foreground animate-pulse">
                Loading market data...
              </div>
            )}

            {pairs?.length === 0 && !loadingPairs && (
              <p className="text-xs text-muted-foreground">No trading pairs found.</p>
            )}

            {topPair && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    {topPair.baseToken.symbol}/{topPair.quoteToken.symbol}
                  </span>
                  <span className="text-xs text-muted-foreground">{topPair.dexId}</span>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <Stat label="Price" value={formatPrice(topPair.priceUsd)} />
                  <Stat label="Liquidity" value={formatNumber(topPair.liquidity?.usd)} />
                  <Stat label="Market Cap" value={formatNumber(topPair.marketCap)} />
                  <Stat label="FDV" value={formatNumber(topPair.fdv)} />
                  <Stat label="Vol 24h" value={formatNumber(topPair.volume?.h24)} />
                  <PriceChangeStat change={topPair.priceChange?.h24} label="24h" />
                </div>

                {pairs && pairs.length > 1 && (
                  <p className="text-xs text-muted-foreground">
                    +{pairs.length - 1} more pair{pairs.length > 2 ? "s" : ""} on this chain
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xs font-mono font-semibold text-foreground">{value}</div>
    </div>
  );
}

function PriceChangeStat({ label, change }: { label: string; change?: number }) {
  if (change == null) return <Stat label={`${label} Change`} value="—" />;
  const isPositive = change >= 0;
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label} Change</div>
      <div
        className={`text-xs font-mono font-semibold flex items-center gap-0.5 ${
          isPositive ? "text-green-400" : "text-red-400"
        }`}
      >
        {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
        {isPositive ? "+" : ""}{change.toFixed(2)}%
      </div>
    </div>
  );
}
