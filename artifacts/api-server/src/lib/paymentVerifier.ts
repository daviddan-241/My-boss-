/**
 * On-chain payment verification.
 *
 * Orders are created with an expected (wallet, chain, exact amount, window).
 * The PaymentWatcher polls each chain for incoming deposits and marks orders
 * "paid" ONLY when a real transaction matches:
 *
 *   - destination == the order's receiving wallet
 *   - value (wei / lamports / nanotons) >= 99.5% of the order amount
 *   - timestamp within [order.createdAt - 60s, now]
 *
 * Sources (all free/public; API keys only raise rate limits):
 *   - Ethereum / BNB Chain / Base → Etherscan-family "account txlist"
 *   - Solana → JSON-RPC (any RPC URL; default public mainnet endpoint.
 *     A free Helius/QuickNode key as SOLANA_RPC_URL is recommended.)
 *   - TON → TonCenter v2 getTransactions
 *
 * On a sleeping free tier (Render free), the watcher simply catches up on the
 * next wake — nothing is lost because orders persist in the store.
 */

import { logger } from "./logger.js";
import type { Order, OrderStore } from "./orderStore.js";

export interface Deposit {
  txHash: string;
  from: string;
  /** Amount in smallest units (wei / lamports / nanotons) as a decimal string. */
  amountSmallest: string;
  timestamp: number;
  link?: string;
}

export interface ExplorerKeys {
  etherscan?: string;
  bscscan?: string;
  basescan?: string;
  toncenter?: string;
  solanaRpcUrl?: string;
}

export interface PaymentHooks {
  onPaid: (order: Order, deposit: Deposit) => Promise<void> | void;
  onExpired: (order: Order) => Promise<void> | void;
}

// ─── Small HTTP helpers (kept local — tokenLookup has its own) ───────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function httpJson(url: string, timeoutMs = 12_000): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await sleep(800);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await sleep(900);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ─── EVM deposits ────────────────────────────────────────────────────────────
//
// Three tiers, tried in order (all free; keys only raise limits):
//   1. Etherscan-family API v2  — needs a (free) API key, richest data
//   2. Blockscout public API    — keyless, full tx detail (ETH, Base)
//   3. Public RPC balance-delta — keyless, works on every EVM chain; detects
//      the net inflow since the last poll (no tx hash available)

interface EvmChainCfg {
  v2Api?: { base: string; chainId: number };
  blockscout?: string;
  rpc?: string;
  web: string;
}

const EVM_CHAINS: Record<string, EvmChainCfg> = {
  ethereum: {
    v2Api: { base: "https://api.etherscan.io/v2/api", chainId: 1 },
    blockscout: "https://eth.blockscout.com",
    rpc: "https://ethereum-rpc.publicnode.com",
    web: "https://etherscan.io",
  },
  bsc: {
    v2Api: { base: "https://api.bscscan.com/v2/api", chainId: 56 },
    rpc: "https://bsc-rpc.publicnode.com",
    web: "https://bscscan.com",
  },
  base: {
    v2Api: { base: "https://api.basescan.org/v2/api", chainId: 8453 },
    blockscout: "https://base.blockscout.com",
    rpc: "https://base-rpc.publicnode.com",
    web: "https://basescan.org",
  },
  arbitrum: { rpc: "https://arbitrum-one-rpc.publicnode.com", web: "https://arbiscan.io" },
  optimism: { rpc: "https://optimism-rpc.publicnode.com", web: "https://optimistic.etherscan.io" },
  polygon: { rpc: "https://polygon-bor-rpc.publicnode.com", web: "https://polygonscan.com" },
  avalanche: { rpc: "https://avalanche-c-chain-rpc.publicnode.com", web: "https://snowtrace.io" },
};

/**
 * Pure filter: keeps only successful plain native transfers INTO `wallet`.
 * Normalizes both Etherscan-family V2 arrays and Blockscout items.
 * Exported for tests.
 */
export function filterEvmTxList(list: unknown[], wallet: string, webBase: string): Deposit[] {
  const w = wallet.toLowerCase();
  const deposits: Deposit[] = [];
  for (const raw of list) {
    const tx = raw as Record<string, unknown>;
    if (!tx || typeof tx !== "object") continue;

    // Etherscan shape: { to: "0x..", from: "0x..", input, isError, value, timeStamp }
    // Blockscout shape: { to: { hash }, from: { hash }, raw_input, result, value, timestamp }
    const toObj = tx.to;
    const fromObj = tx.from;
    const to = typeof toObj === "string" ? toObj : (toObj as { hash?: string })?.hash;
    const from = typeof fromObj === "string" ? fromObj : (fromObj as { hash?: string })?.hash;
    const input = typeof tx.input === "string" ? tx.input : String(tx.raw_input ?? "0x");
    const isError = tx.isError != null ? String(tx.isError) : tx.result === "failed" ? "1" : "0";
    const value = tx.value;

    if (!to || to.toLowerCase() !== w) continue; // not to our wallet
    if (input !== "0x") continue; // contract call, not a plain transfer
    if (isError !== "0") continue; // failed tx
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) continue;
    if (BigInt(value) <= 0n) continue; // zero-value tx is never a deposit
    if (!tx.hash) continue;

    const ts =
      typeof tx.timeStamp === "string"
        ? Number(tx.timeStamp) * 1000
        : typeof tx.timestamp === "string"
          ? Date.parse(tx.timestamp)
          : 0;

    deposits.push({
      txHash: String(tx.hash),
      from: from ?? "",
      amountSmallest: BigInt(value).toString(),
      timestamp: ts,
      link: `${webBase}/tx/${tx.hash}`,
    });
  }
  return deposits;
}

async function fetchEvmV2(
  cfg: EvmChainCfg,
  wallet: string,
  apiKey: string | undefined,
): Promise<Deposit[]> {
  if (!cfg.v2Api || !apiKey) throw new Error("no V2 key");
  const url =
    `${cfg.v2Api.base}?chainid=${cfg.v2Api.chainId}&module=account&action=txlist` +
    `&address=${encodeURIComponent(wallet)}&startblock=0&endblock=99999999&page=1&offset=25&sort=desc&apikey=${encodeURIComponent(apiKey)}`;
  const data = await httpJson(url);
  if (!Array.isArray(data?.result)) {
    throw new Error(`explorer: ${String(data?.message ?? data?.result ?? "unknown")}`);
  }
  return filterEvmTxList(data.result, wallet, cfg.web);
}

async function fetchBlockscout(
  cfg: EvmChainCfg,
  wallet: string,
): Promise<Deposit[]> {
  if (!cfg.blockscout) throw new Error("no Blockscout instance for this chain");
  const url = `${cfg.blockscout}/api/v2/addresses/${encodeURIComponent(wallet)}/transactions`;
  const data = await httpJson(url);
  if (!Array.isArray(data?.items)) throw new Error("unexpected Blockscout response");
  return filterEvmTxList(data.items, wallet, cfg.web);
}

// Balance-delta baselines per chain+wallet (keyless fallback tier).
const balanceBaselines = new Map<string, bigint>();

async function fetchRpcBalanceDelta(
  cfg: EvmChainCfg,
  chainId: string,
  wallet: string,
): Promise<Deposit[]> {
  if (!cfg.rpc) throw new Error("no public RPC for this chain");
  const res = await rpcCall(cfg.rpc, "eth_getBalance", [wallet, "latest"]);
  const hex = res?.result;
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("bad eth_getBalance response");
  }
  const balance = BigInt(hex);
  const key = `${chainId}:${wallet.toLowerCase()}`;
  const prev = balanceBaselines.get(key);
  if (prev === undefined) {
    balanceBaselines.set(key, balance); // first observation — establish baseline
    return [];
  }
  if (balance < prev) {
    balanceBaselines.set(key, balance); // wallet spent — reset baseline
    return [];
  }
  const delta = balance - prev;
  balanceBaselines.set(key, balance);
  if (delta <= 0n) return [];
  logger.info({ chainId, wallet, delta: delta.toString() }, "Balance-delta deposit detected (keyless mode)");
  return [
    {
      txHash: `bal:${balance.toString()}`,
      from: "",
      amountSmallest: delta.toString(),
      timestamp: Date.now(),
      link: `${cfg.web}/address/${wallet}`,
    },
  ];
}

export async function fetchEvmDeposits(
  chainId: string,
  wallet: string,
  apiKey?: string,
): Promise<Deposit[]> {
  const cfg = EVM_CHAINS[chainId];
  if (!cfg) return [];
  const attempts: (() => Promise<Deposit[]>)[] = [
    () => fetchEvmV2(cfg, wallet, apiKey),
    () => fetchBlockscout(cfg, wallet),
    () => fetchRpcBalanceDelta(cfg, chainId, wallet),
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(`all EVM sources failed: ${errors.join(" | ")}`);
}

// ─── Solana (JSON-RPC) ────────────────────────────────────────────────────────

export const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

export async function fetchSolanaDeposits(wallet: string, rpcUrl?: string): Promise<Deposit[]> {
  const rpc = rpcUrl ?? DEFAULT_SOLANA_RPC;
  const sigRes = await rpcCall(rpc, "getSignaturesForAddress", [wallet, { limit: 20 }]);
  const signatures: unknown[] = sigRes?.result ?? [];
  const deposits: Deposit[] = [];

  for (const sig of signatures) {
    const signature = (sig as { signature?: string })?.signature;
    if (!signature) continue;
    try {
      const txRes = await rpcCall(rpc, "getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
      const result = txRes?.result;
      if (!result) continue;
      const accountKeys: unknown[] = result.transaction?.message?.accountKeys ?? [];
      const idx = accountKeys.findIndex((k) => {
        if (typeof k === "string") return k === wallet;
        const pk = (k as { pubkey?: string })?.pubkey;
        return pk === wallet;
      });
      if (idx < 0) continue;
      const pre = Number(result.meta?.preBalances?.[idx]);
      const post = Number(result.meta?.postBalances?.[idx]);
      const delta = post - pre;
      if (delta <= 0) continue;
      if (result.meta?.err) continue; // failed tx
      deposits.push({
        txHash: signature,
        from: "",
        amountSmallest: String(delta),
        timestamp: Number(result.blockTime ?? 0) * 1000,
        link: `https://solscan.io/tx/${signature}`,
      });
    } catch {
      // single-tx parse failure — skip, next poll will retry
    }
  }
  return deposits;
}

// ─── TON (TonCenter) ──────────────────────────────────────────────────────────

/**
 * Normalize a TON address to its raw "0:<64 hex>" form.
 *
 * Accepted input forms (verified against TonCenter responses):
 *   - raw:        "0:B73E..." (64 hex chars)
 *   - friendly:   "EQ" + base64url(36 bytes) → 50 chars total
 *   - bare b64:   the 48-char base64url form TonCenter returns in
 *                 in_msg.destination (no prefix; the leading "EQ"/"UQ"
 *                 characters there are DATA — tag+workchain bytes)
 *
 * Friendly/bare payload layout: tag(1) + workchain(1) + account_id(32) + crc16(2).
 */
export function tonNormalize(addr: string): string {
  const a = addr.trim();
  if (/^0:[0-9a-fA-F]{64}$/.test(a)) return a.toLowerCase();

  let payload = a;
  // Strip the friendly prefix only when it is a real prefix: "EQ" + 48 chars.
  if (/^(EQ|UQ)[A-Za-z0-9_-]{48}$/.test(a)) {
    payload = a.slice(2);
  } else if (!/^[A-Za-z0-9_-]{48}$/.test(a)) {
    return a.toLowerCase(); // unrecognized form — compare as-is
  }

  try {
    const buf = Buffer.from(payload, "base64url"); // 48 chars → 36 bytes
    if (buf.length === 36) {
      return `0:${buf.subarray(2, 34).toString("hex")}`;
    }
  } catch {
    /* fallthrough */
  }
  return a.toLowerCase();
}

export function tonAddressMatches(a: string, b: string): boolean {
  return tonNormalize(a) === tonNormalize(b);
}

export async function fetchTonDeposits(wallet: string, apiKey?: string): Promise<Deposit[]> {
  // TonCenter accepts the raw "0:…" form in queries; friendly/bare forms are
  // normalized first so user-configured wallets work in any notation.
  const rawWallet = tonNormalize(wallet);
  const url =
    `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(rawWallet)}&limit=20` +
    (apiKey ? `&api_key=${apiKey}` : "");
  const data = await httpJson(url);
  const txs: unknown[] = data?.result ?? [];
  const deposits: Deposit[] = [];
  for (const raw of txs) {
    const tx = raw as {
      utime?: number;
      transaction_id?: { lt?: string; hash?: string };
      in_msg?: { source?: string; destination?: string; value?: string };
    };
    const im = tx.in_msg;
    // The tx id lives in transaction_id (lt + base64 hash) — there is no
    // top-level `hash` field in TonCenter's response.
    const lt = tx.transaction_id?.lt ?? "";
    const hashB64 = tx.transaction_id?.hash ?? "";
    if (!lt && !hashB64) continue;
    if (!im?.destination) continue;
    if (!tonAddressMatches(im.destination, wallet)) continue;
    const value = im.value ?? "0";
    if (!/^\d+$/.test(value) || BigInt(value) <= 0n) continue;
    const txId = `${lt}:${hashB64}`;
    deposits.push({
      txHash: txId,
      from: im.source ?? "",
      amountSmallest: BigInt(value).toString(),
      timestamp: Number(tx.utime ?? 0) * 1000,
      link: `https://tonscan.org/tx/${encodeURIComponent(txId)}`,
    });
  }
  return deposits;
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/**
 * The minimum accepted deposit for an order: 99.5% of the expected amount.
 * (Slippage/partial sends are flagged by the admin via the full deposit info.)
 */
export function minAcceptedSmallestUnits(order: Order): bigint {
  return (BigInt(order.amountSmallest) * 995n) / 1000n;
}

export function depositMatchesOrder(order: Order, deposit: Deposit): boolean {
  if (deposit.timestamp < order.createdAt - 60_000) return false; // too old
  if (deposit.timestamp > Date.now() + 60_000) return false; // clock skew guard
  return BigInt(deposit.amountSmallest) >= minAcceptedSmallestUnits(order);
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

export class PaymentWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Dedupe: tx hashes already processed this process lifetime. */
  private readonly seen = new Map<string, Set<string>>();

  constructor(
    private readonly store: OrderStore,
    private readonly keys: ExplorerKeys,
    private readonly hooks: PaymentHooks,
    private readonly pollMs: number,
  ) {}

  start(): void {
    void this.tick(); // immediate catch-up tick (important after cold start)
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    logger.info({ pollMs: this.pollMs }, "Payment watcher started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    logger.info("Payment watcher stopped");
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const actives = await this.store.listByStatus("awaiting_payment");
      const now = Date.now();

      // 1. Expire overdue orders.
      for (const o of actives.filter((o) => o.expiresAt <= now)) {
        await this.store.update(o.id, { status: "expired" });
        logger.info({ order: o.id }, "Order expired");
        try {
          await this.hooks.onExpired(o);
        } catch (err) {
          logger.warn({ err, order: o.id }, "onExpired hook failed");
        }
      }

      // 2. Group pending orders by chain+wallet to minimize API calls.
      const pending = actives.filter((o) => o.expiresAt > now);
      const groups = new Map<string, Order[]>();
      for (const o of pending) {
        const key = `${o.chainId}:${o.wallet.toLowerCase()}`;
        const list = groups.get(key) ?? [];
        list.push(o);
        groups.set(key, list);
      }

      // 3. Fetch deposits per group and match.
      for (const [key, orders] of groups) {
        const chainId = key.split(":")[0];
        const wallet = orders[0].wallet;
        let deposits: Deposit[] = [];
        try {
          if (chainId === "solana") {
            deposits = await fetchSolanaDeposits(wallet, this.keys.solanaRpcUrl);
          } else if (chainId === "ton") {
            deposits = await fetchTonDeposits(wallet, this.keys.toncenter);
          } else {
            const apiKey =
              chainId === "ethereum"
                ? this.keys.etherscan
                : chainId === "bsc"
                  ? this.keys.bscscan
                  : this.keys.basescan;
            deposits = await fetchEvmDeposits(chainId, wallet, apiKey);
          }
        } catch (err) {
          logger.warn({ err, chainId, wallet }, "Deposit fetch failed — will retry next tick");
          continue;
        }

        const seenSet = this.seen.get(key) ?? new Set<string>();
        this.seen.set(key, seenSet);

        for (const d of deposits) {
          if (seenSet.has(d.txHash)) continue;
          seenSet.add(d.txHash);
          if (BigInt(d.amountSmallest) <= 0n) continue;

          const match = orders
            .filter((o) => !o.txHash && depositMatchesOrder(o, d))
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          if (!match) continue;

          const updated = await this.store.update(match.id, {
            status: "paid",
            txHash: d.txHash,
            txLink: d.link,
            paidAt: Date.now(),
          });
          logger.info(
            { order: match.id, tx: d.txHash, amountSmallest: d.amountSmallest },
            "PAYMENT CONFIRMED on-chain",
          );
          try {
            await this.hooks.onPaid(updated ?? { ...match, txHash: d.txHash, txLink: d.link }, d);
          } catch (err) {
            logger.warn({ err, order: match.id }, "onPaid hook failed");
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Payment watcher tick failed");
    } finally {
      this.running = false;
    }
  }
}
