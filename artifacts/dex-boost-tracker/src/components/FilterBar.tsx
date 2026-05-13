import { Search, X } from "lucide-react";
import { CHAIN_LABELS, CHAIN_COLORS } from "@/lib/dexscreener";

interface FilterBarProps {
  search: string;
  onSearch: (v: string) => void;
  selectedChain: string;
  onSelectChain: (v: string) => void;
  availableChains: string[];
}

export function FilterBar({
  search,
  onSearch,
  selectedChain,
  onSelectChain,
  availableChains,
}: FilterBarProps) {
  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          placeholder="Search by address or description..."
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="w-full pl-9 pr-9 py-2 bg-card border border-border rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
        />
        {search && (
          <button
            onClick={() => onSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Chain filter */}
      {availableChains.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onSelectChain("")}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
              selectedChain === ""
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
            }`}
          >
            All
          </button>
          {availableChains.map((chain) => {
            const label = CHAIN_LABELS[chain] ?? chain.toUpperCase().slice(0, 6);
            const color = CHAIN_COLORS[chain] ?? "#6b7280";
            const isActive = selectedChain === chain;
            return (
              <button
                key={chain}
                onClick={() => onSelectChain(chain)}
                className="px-3 py-1 rounded-full text-xs font-bold border transition-all"
                style={{
                  background: isActive ? `${color}33` : "transparent",
                  color: isActive ? color : "#6b7280",
                  borderColor: isActive ? `${color}88` : "#374151",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
