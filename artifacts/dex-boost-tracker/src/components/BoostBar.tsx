interface BoostBarProps {
  amount: number | undefined;
  totalAmount: number | undefined;
  isGolden?: boolean;
}

export function BoostBar({ amount, totalAmount, isGolden }: BoostBarProps) {
  const a = amount ?? 0;
  const t = totalAmount ?? 0;
  const pct = t > 0 ? Math.min((a / t) * 100, 100) : 0;

  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center text-xs">
        <span className="text-muted-foreground">Boost</span>
        <span
          className={`font-bold font-mono ${isGolden ? "text-yellow-400" : "text-primary"}`}
        >
          {a.toLocaleString()}
          {isGolden && " ★"}
        </span>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: isGolden
              ? "linear-gradient(90deg, #ca8a04, #fde047)"
              : "linear-gradient(90deg, hsl(142 70% 35%), hsl(142 70% 55%))",
            boxShadow: isGolden
              ? "0 0 8px rgba(234, 179, 8, 0.6)"
              : "0 0 8px rgba(34, 197, 94, 0.5)",
          }}
        />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Total: {t.toLocaleString()}</span>
        {isGolden && (
          <span className="text-yellow-400 font-bold">Golden Ticker</span>
        )}
      </div>
    </div>
  );
}
