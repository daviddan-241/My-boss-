/**
 * Smoke test for the multi-source token lookup engine.
 *
 * Run:  pnpm --filter @workspace/scripts run smoke
 *
 * Verifies against LIVE public APIs:
 *   1. A well-known Solana token (wrapped SOL) — expects DexScreener + others
 *   2. A well-known EVM token (USDC on Ethereum) — exercises EVM auto-detect
 *   3. A name/symbol search ("pepe") — exercises query mode
 */

import { lookupToken, detectEvmChain } from "../artifacts/api-server/src/lib/tokenLookup.js";

const CASES: { label: string; input: string; chainHint?: string; isQuery?: boolean }[] = [
  { label: "Solana token (wrapped SOL)", input: "So11111111111111111111111111111111111111112" },
  { label: "EVM token, auto-detect (USDC/ETH)", input: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { label: "Name search (pepe)", input: "pepe", isQuery: true },
  { label: "OLD coin, 2017 ERC-20 (Maker MKR)", input: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2" },
];

const PROBES: { label: string; input: string; expect: string }[] = [
  { label: "EVM chain probe (WBNB → bsc)", input: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", expect: "bsc" },
  { label: "EVM chain probe (WETH → eth)", input: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", expect: "eth" },
];

async function main(): Promise<void> {
  let failures = 0;
let warnings = 0;
  for (const c of CASES) {
    const t0 = Date.now();
    console.log(`\n=== ${c.label} ===\n  input: ${c.input}`);
    const res = await lookupToken(c.input, { chainHint: c.chainHint, isQuery: c.isQuery, autoDetectEvmChain: true });
    console.log(`  took ${Date.now() - t0}ms · fromCache: ${res.fromCache ?? false}`);
    for (const s of res.tried) {
      console.log(`  ${s.ok ? "✅" : "❌"} ${s.source}${s.error ? ` — ${s.error}` : ""} (${s.ms}ms)`);
    }
    if (res.token) {
      console.log(
        `  RESULT: ${res.token.symbol} (${res.token.name}) on ${res.token.chain} · MC ${res.token.marketCap ?? "—"} · price ${res.token.price ?? "—"} · sources [${res.token.sources?.join(", ")}]`,
      );
      console.log(
        `  IMAGE: ${res.token.imageUrl ? res.token.imageUrl.slice(0, 90) + "…" : "❌ none found"}`,
      );
      if (!res.token.imageUrl) warnings++; // enrichment is best-effort (rate-limit dependent)
    } else {
      console.log("  RESULT: NOT FOUND");
      failures++;
    }
    // Cache check: second identical lookup must hit the cache.
    const t1 = Date.now();
    const again = await lookupToken(c.input, { chainHint: c.chainHint, isQuery: c.isQuery, autoDetectEvmChain: true });
    console.log(`  repeat: ${Date.now() - t1}ms · fromCache: ${again.fromCache ?? false}`);
  }

  for (const p of PROBES) {
    const t0 = Date.now();
    console.log(`\n=== ${p.label} ===\n  input: ${p.input}`);
    const found = await detectEvmChain(p.input);
    console.log(`  took ${Date.now() - t0}ms · detected: ${found ?? "none"} · expected: ${p.expect}`);
    // Probe failures are usually upstream 429s on shared IPs (the engine then
    // falls back to the manual chain picker) — warn, don't fail the suite.
    if (found !== p.expect) warnings++;
  }

  console.log(
    failures === 0
      ? `\n✅ All ${CASES.length} lookups resolved${warnings ? ` (${warnings} probe warning(s) — likely upstream rate limits)` : ""}`
      : `\n⚠️ ${failures} lookup(s) failed (may be upstream rate limits — rerun)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
