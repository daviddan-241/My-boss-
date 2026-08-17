import { ExternalLink, Twitter, Send, Globe, MessageCircle } from "lucide-react";

interface Link {
  type?: string;
  label: string;
  url: string;
}

interface SocialLinksProps {
  links?: Link[];
  tokenUrl?: string;
}

function getLinkIcon(type: string | undefined) {
  switch ((type ?? "").toLowerCase()) {
    case "twitter":
      return <Twitter className="w-3.5 h-3.5" />;
    case "telegram":
      return <Send className="w-3.5 h-3.5" />;
    case "discord":
      return <MessageCircle className="w-3.5 h-3.5" />;
    case "website":
      return <Globe className="w-3.5 h-3.5" />;
    default:
      return <ExternalLink className="w-3.5 h-3.5" />;
  }
}

function getLinkColor(type: string | undefined): string {
  switch ((type ?? "").toLowerCase()) {
    case "twitter":
      return "text-sky-400 hover:text-sky-300 hover:bg-sky-400/10";
    case "telegram":
      return "text-blue-400 hover:text-blue-300 hover:bg-blue-400/10";
    case "discord":
      return "text-indigo-400 hover:text-indigo-300 hover:bg-indigo-400/10";
    case "website":
      return "text-primary hover:text-primary/80 hover:bg-primary/10";
    default:
      return "text-muted-foreground hover:text-foreground hover:bg-accent";
  }
}

export function SocialLinks({ links, tokenUrl }: SocialLinksProps) {
  const allLinks: Link[] = [
    ...(links ?? []),
    ...(tokenUrl ? [{ type: "dexscreener", label: "DexScreener", url: tokenUrl }] : []),
  ];

  if (allLinks.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {allLinks.map((link, i) => (
        <a
          key={i}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          title={link.label}
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${getLinkColor(link.type)}`}
          onClick={(e) => e.stopPropagation()}
        >
          {getLinkIcon(link.type)}
          <span>{link.label || link.type}</span>
        </a>
      ))}
    </div>
  );
}
