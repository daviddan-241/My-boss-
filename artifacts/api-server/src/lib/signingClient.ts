/// <reference lib="dom" />
/**
 * Wallet-connect signing client (bundled to public/signing.js by build.mjs).
 *
 * Flow:
 *   1. Load the order from /api/signing/order/:id
 *   2. User connects their wallet (Phantom / any Wallet-Standard provider)
 *   3. We fetch a REAL on-chain transaction from /api/signing/build
 *   4. The user signs it in their own wallet (no keys ever touch our server)
 *   5. We submit the signature; the server verifies it on-chain and fulfills
 *      the order automatically
 */

import { Connection, PublicKey, Transaction } from "@solana/web3.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const msg = (text: string, cls: "ok" | "err" | "" = ""): void => {
  const el = $<HTMLDivElement>("msg");
  el.textContent = text;
  el.className = `msg ${cls}`.trim();
};

const orderId = new URLSearchParams(window.location.search).get("order");
if (!orderId) {
  msg("Missing order id. Open this page from the bot's Connect Wallet button.", "err");
  throw new Error("missing order id");
}

interface OrderView {
  id: string;
  service: string;
  packageName?: string;
  token: { symbol: string; address: string; chain: string };
  details: Record<string, string>;
  status: string;
  txLink?: string;
}

let order: OrderView | null = null;

// ── Step 1: load order ───────────────────────────────────────────────────────
async function loadOrder(): Promise<void> {
  try {
    const res = await fetch(`/api/signing/order/${encodeURIComponent(orderId!)}`);
    if (!res.ok) throw new Error(`order ${orderId} not found`);
    order = (await res.json()) as OrderView;

    $("subtitle").textContent =
      order.service === "burn" ? "Burn Token — real on-chain transaction" : "Lock Supply — real on-chain transaction";
    $("d-id").textContent = order.id;
    $("d-service").textContent = order.packageName ?? order.service;
    $("d-token").textContent = `${order.token.symbol} · ${order.token.chain}`;
    $("d-ca").textContent = order.token.address.slice(0, 12) + "…" + order.token.address.slice(-8);
    $("d-details").textContent = Object.entries(order.details).map(([k, v]) => `${k}: ${v}`).join(" · ");
    const statusEl = $("d-status");
    statusEl.textContent = order.status === "fulfilled" ? "Completed ✅" : order.status;
    if (order.status === "fulfilled") statusEl.classList.add("ok");
    if (order.txLink) {
      $("row-tx").style.display = "flex";
      $<HTMLAnchorElement>("d-txlink").textContent = order.txLink;
      $<HTMLAnchorElement>("d-txlink").href = order.txLink;
    }

    $("details").style.display = "block";
    $("warn").style.display = "block";
    $("hint").style.display = "block";

    if (order.status === "fulfilled") {
      $("btn-done").style.display = "block";
      msg("This order is already completed. ✅");
    } else if (order.service === "burn" || order.service === "lock_supply") {
      $("btn-connect").style.display = "block";
    } else {
      msg("This order does not use wallet signing.", "err");
    }
  } catch (err) {
    msg(err instanceof Error ? err.message : "failed to load order", "err");
  }
}

// ── Wallet provider detection (Phantom / Wallet-Standard) ────────────────────
type Provider = {
  publicKey: { toString(): string } | null;
  connect: () => Promise<{ publicKey: { toString(): string } }>;
  signAndSendTransaction?: (tx: Transaction) => Promise<{ signature: string }>;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
};

function getProvider(): Provider {
  const w = window as unknown as {
    phantom?: { solana?: Provider };
    solana?: Provider;
  };
  const p = w.phantom?.solana ?? w.solana;
  if (!p) throw new Error("No Solana wallet detected — install Phantom (phantom.app) and try again.");
  return p;
}

// ── Step 2: connect ──────────────────────────────────────────────────────────
let provider: Provider | null = null;

async function connect(): Promise<void> {
  try {
    provider = getProvider();
    await provider.connect();
    if (!provider.publicKey) throw new Error("wallet did not provide a public key");
    msg(`Connected: ${provider.publicKey.toString().slice(0, 8)}…`, "ok");
    $("btn-connect").style.display = "none";
    $("btn-sign").style.display = "block";
    $<HTMLButtonElement>("btn-sign").disabled = false;
  } catch (err) {
    msg(err instanceof Error ? err.message : "connection failed", "err");
  }
}

// ── Step 3: build + sign + send the REAL transaction ─────────────────────────
function pctFromDetails(): number {
  const raw = order?.details["Target %"] ?? order?.details["target %"] ?? "";
  const n = parseFloat(raw.replace("%", ""));
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 100;
}

async function signAndSend(): Promise<void> {
  if (!provider || !order) return;
  const btn = $<HTMLButtonElement>("btn-sign");
  btn.disabled = true;
  try {
    const mint = order.token.address;
    const owner = provider.publicKey!.toString();
    const pct = pctFromDetails();

    msg("Building the on-chain transaction…");
    const res = await fetch("/api/signing/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: order.service, mint, owner, pct }),
    });
    const data = (await res.json()) as { error?: string; txBase64?: string; amountHuman?: string };
    if (!res.ok || !data.txBase64) throw new Error(data.error ?? "failed to build transaction");
    msg(`Confirm in your wallet: ${data.amountHuman ?? ""} — approve the transaction`);

    const tx = Transaction.from(Buffer.from(data.txBase64, "base64"));

    // Modern wallets: one-call sign+send.
    let signature: string;
    if (provider.signAndSendTransaction) {
      const r = await provider.signAndSendTransaction(tx);
      signature = r.signature;
    } else if (provider.signTransaction) {
      const signed = await provider.signTransaction(tx);
      const conn = new Connection("https://solana-rpc.publicnode.com", "confirmed");
      signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    } else {
      throw new Error("your wallet does not support transaction signing here");
    }

    msg("⏳ Transaction sent — verifying on-chain…");
    const submit = await fetch("/api/signing/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: order.id, signature }),
    });
    const result = (await submit.json()) as { ok?: boolean; error?: string; link?: string };
    if (!submit.ok || !result.ok) throw new Error(result.error ?? "verification failed");

    $("btn-sign").style.display = "none";
    $("btn-done").style.display = "block";
    $("d-status").textContent = "Completed ✅";
    $("d-status").classList.add("ok");
    $("row-tx").style.display = "flex";
    $<HTMLAnchorElement>("d-txlink").textContent = result.link ?? signature;
    $<HTMLAnchorElement>("d-txlink").href = result.link ?? `https://solscan.io/tx/${signature}`;
    msg("✅ Transaction confirmed on-chain! The bot will notify you in Telegram.", "ok");
  } catch (err) {
    msg(err instanceof Error ? err.message : "signing failed", "err");
    btn.disabled = false;
  }
}

$("btn-connect").addEventListener("click", () => void connect());
$("btn-sign").addEventListener("click", () => void signAndSend());

void loadOrder();
