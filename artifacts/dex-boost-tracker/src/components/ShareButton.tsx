import { useState } from "react";
import { Share2, Copy, Check, Twitter, Send, X } from "lucide-react";

interface ShareButtonProps {
  tokenAddress?: string;
  chainId?: string;
}

export function ShareButton({ tokenAddress, chainId }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const shareUrl = tokenAddress
    ? `https://dexscreener.com/${chainId}/${tokenAddress}`
    : window.location.href;

  const shareText = tokenAddress
    ? `Check out this boosted token on DexScreener! 🚀\n${shareUrl}`
    : `Track live DexScreener boosts! 🔥\n${shareUrl}`;

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => { setCopied(false); setOpen(false); }, 2000);
  };

  const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
  const telegramUrl = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`;

  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent hover:bg-accent/80 text-muted-foreground hover:text-foreground text-xs font-medium transition-colors border border-border"
      >
        <Share2 className="w-3.5 h-3.5" />
        Share
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-full mb-2 z-40 w-52 bg-card border border-border rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-xs font-semibold text-foreground">Share</span>
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="p-1.5 space-y-1">
              <button
                onClick={copyLink}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-accent text-sm transition-colors text-left"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-primary flex-shrink-0" />
                ) : (
                  <Copy className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                )}
                <span className="text-foreground">{copied ? "Copied!" : "Copy link"}</span>
              </button>
              <a
                href={twitterUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-sky-500/10 text-sm transition-colors"
              >
                <Twitter className="w-4 h-4 text-sky-400 flex-shrink-0" />
                <span className="text-foreground">Share on X</span>
              </a>
              <a
                href={telegramUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-blue-500/10 text-sm transition-colors"
              >
                <Send className="w-4 h-4 text-blue-400 flex-shrink-0" />
                <span className="text-foreground">Share on Telegram</span>
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
