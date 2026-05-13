import { CHAIN_LABELS, CHAIN_COLORS } from "@/lib/dexscreener";

interface ChainBadgeProps {
  chainId: string;
  className?: string;
}

export function ChainBadge({ chainId, className = "" }: ChainBadgeProps) {
  const label = CHAIN_LABELS[chainId] ?? chainId.toUpperCase().slice(0, 6);
  const color = CHAIN_COLORS[chainId] ?? "#6b7280";

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold font-mono tracking-wide ${className}`}
      style={{
        background: `${color}22`,
        color: color,
        border: `1px solid ${color}44`,
      }}
    >
      {label}
    </span>
  );
}
