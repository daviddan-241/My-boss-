import { X, ExternalLink, Zap, Rocket } from "lucide-react";

interface BoostTokenModalProps {
  onClose: () => void;
}

const CREATION_SITES = [
  {
    name: "pump.fun",
    chain: "Solana",
    chainColor: "#9945FF",
    desc: "Launch a token on Solana in seconds",
    url: "https://pump.fun",
    emoji: "🟣",
  },
  {
    name: "Raydium",
    chain: "Solana",
    chainColor: "#9945FF",
    desc: "Create & manage Solana liquidity pools",
    url: "https://raydium.io",
    emoji: "⚡",
  },
  {
    name: "Uniswap",
    chain: "Ethereum",
    chainColor: "#627EEA",
    desc: "Deploy tokens on Ethereum / Base / Arbitrum",
    url: "https://app.uniswap.org",
    emoji: "🦄",
  },
  {
    name: "PancakeSwap",
    chain: "BNB Chain",
    chainColor: "#F3BA2F",
    desc: "Create tokens on BNB Chain",
    url: "https://pancakeswap.finance",
    emoji: "🥞",
  },
  {
    name: "Moonshot",
    chain: "Solana",
    chainColor: "#9945FF",
    desc: "Fair-launch meme coins on Solana",
    url: "https://moonshot.money",
    emoji: "🌙",
  },
  {
    name: "four.meme",
    chain: "BNB Chain",
    chainColor: "#F3BA2F",
    desc: "Meme token launchpad on BNB Chain",
    url: "https://four.meme",
    emoji: "4️⃣",
  },
];

const BOOST_STEPS = [
  {
    step: 1,
    title: "Create Your Token",
    desc: "Launch on any supported chain using one of the platforms below",
  },
  {
    step: 2,
    title: "Get Listed on DexScreener",
    desc: "Your token appears automatically once trading begins",
  },
  {
    step: 3,
    title: "Purchase Boosts",
    desc: "Buy boost packs on DexScreener to increase your Trending Score",
  },
  {
    step: 4,
    title: "Reach Golden Ticker",
    desc: "Accumulate 500+ active boosts for the coveted Golden Ticker status",
  },
];

export function BoostTokenModal({ onClose }: BoostTokenModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full sm:max-w-2xl max-h-[90vh] overflow-y-auto bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
              <Rocket className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h2 className="font-bold text-foreground">Boost Your Token</h2>
              <p className="text-xs text-muted-foreground">
                Create, list, and boost your token on DexScreener
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-accent"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* How it works */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">
              How It Works
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {BOOST_STEPS.map((s) => (
                <div
                  key={s.step}
                  className="flex gap-3 p-3 rounded-xl bg-accent/50 border border-border"
                >
                  <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary flex-shrink-0 mt-0.5">
                    {s.step}
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">
                      {s.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {s.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Creation sites */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">
              Token Creation Platforms
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {CREATION_SITES.map((site) => (
                <a
                  key={site.name}
                  href={site.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3.5 rounded-xl bg-card border border-border hover:border-primary/40 hover:bg-accent/30 transition-all group"
                >
                  <span className="text-2xl">{site.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-foreground">
                        {site.name}
                      </span>
                      <span
                        className="text-xs font-bold px-1.5 py-0.5 rounded"
                        style={{
                          background: `${site.chainColor}22`,
                          color: site.chainColor,
                        }}
                      >
                        {site.chain}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {site.desc}
                    </p>
                  </div>
                  <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
                </a>
              ))}
            </div>
          </div>

          {/* DexScreener boost link */}
          <div className="p-4 rounded-xl bg-primary/10 border border-primary/30">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold text-primary">
                Ready to Boost?
              </span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Once your token is trading, head to its DexScreener page to
              purchase boosts. A single 24h boost pack starts at{" "}
              <span className="text-foreground font-semibold">$3,999</span>.
              Reach 500+ boosts for the Golden Ticker.
            </p>
            <a
              href="https://dexscreener.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              <Zap className="w-4 h-4" />
              Open DexScreener
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* Telegram bot CTA */}
          <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/30">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-blue-400 font-bold text-sm">
                📲 Telegram Bot
              </span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Get live boost alerts, check top tokens, and track your portfolio
              — all from Telegram.
            </p>
            <a
              href="https://t.me/DexscreenersBoostBot"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500 text-white text-sm font-semibold hover:bg-blue-600 transition-colors"
            >
              Open Bot
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
