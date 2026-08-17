/**
 * Real on-chain signing engine for Lock Supply / Burn Token.
 *
 * The wallet-connect webapp (public/signing.html + signing.js) calls these
 * builders, the user signs the transaction in THEIR wallet (Phantom and any
 * Wallet-Standard wallet), and the resulting signature is verified here
 * against the chain before the order is fulfilled. No seed phrases, no
 * private keys — ever. Signing happens in the user's own wallet.
 *
 *   BURN: a real spl-token `Burn` instruction — supply actually decreases.
 *         Amount = min(wallet balance, supply × pct%) — the exact amount is
 *         returned so the UI can show the user precisely what will be burned.
 *
 *   LOCK: a real on-chain transfer into the operator's lock vault
 *         (LOCK_VAULT_WALLET) with the term recorded on the order. The vault
 *         wallet's key stays with the operator for the duration.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  type TransactionSignature,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { logger } from "./logger.js";

const SOLANA_RPC_FALLBACKS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

function rpcUrls(): string[] {
  const custom = process.env["SOLANA_RPC_URL"]?.trim();
  return custom ? [custom, ...SOLANA_RPC_FALLBACKS.filter((u) => u !== custom)] : SOLANA_RPC_FALLBACKS;
}

function getConnection(): Connection {
  return new Connection(rpcUrls()[0], "confirmed");
}

export interface BuiltTx {
  txBase64: string;
  /** Human-readable amount that will be moved. */
  amountHuman: string;
  symbol: string;
  mint: string;
  pct: number;
}

/** Compute the amount to move: min(wallet balance, supply × pct%). */
async function computeAmount(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  pct: number,
): Promise<{ amount: bigint }> {
  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  const supply = mintInfo.supply;
  const target = (supply * BigInt(Math.round(pct * 100))) / 10000n; // pct% of supply

  let walletBalance = 0n;
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
    const ataInfo = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    walletBalance = ataInfo.amount;
  } catch {
    walletBalance = 0n;
  }

  if (target <= 0n) throw new Error("invalid percentage");
  const amount = walletBalance < target ? walletBalance : target;
  if (amount <= 0n) {
    throw new Error("connected wallet holds no tokens of this mint");
  }
  return { amount };
}

async function finalizeTx(connection: Connection, owner: PublicKey, tx: Transaction): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  tx.lastValidBlockHeight = lastValidBlockHeight;
}

export async function buildBurnTransaction(
  mintStr: string,
  ownerStr: string,
  pct: number,
): Promise<BuiltTx> {
  const connection = getConnection();
  const mint = new PublicKey(mintStr);
  const owner = new PublicKey(ownerStr);

  const { amount } = await computeAmount(connection, mint, owner, pct);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);

  const tx = new Transaction().add(createBurnInstruction(ata, mint, owner, amount, [], TOKEN_PROGRAM_ID));
  await finalizeTx(connection, owner, tx);

  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  const decimals = mintInfo.decimals;
  const amountHuman = `${(Number(amount) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals })} tokens`;

  logger.info({ mint: mintStr, owner: ownerStr, pct, amount: amount.toString() }, "Burn transaction built");
  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    amountHuman,
    symbol: "tokens",
    mint: mintStr,
    pct,
  };
}

export async function buildLockTransaction(
  mintStr: string,
  ownerStr: string,
  pct: number,
): Promise<BuiltTx> {
  const vaultStr = process.env["LOCK_VAULT_WALLET"]?.trim();
  if (!vaultStr) throw new Error("LOCK_VAULT_WALLET is not configured — lock signing is disabled");

  const connection = getConnection();
  const mint = new PublicKey(mintStr);
  const owner = new PublicKey(ownerStr);
  const vault = new PublicKey(vaultStr);

  const { amount } = await computeAmount(connection, mint, owner, pct);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  const vaultAta = getAssociatedTokenAddressSync(mint, vault, false, TOKEN_PROGRAM_ID);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(owner, vaultAta, vault, mint, TOKEN_PROGRAM_ID),
    createTransferInstruction(ata, vaultAta, owner, amount, [], TOKEN_PROGRAM_ID),
  );
  await finalizeTx(connection, owner, tx);

  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  const decimals = mintInfo.decimals;
  const amountHuman = `${(Number(amount) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals })} tokens`;

  logger.info({ mint: mintStr, owner: ownerStr, vault: vaultStr, pct, amount: amount.toString() }, "Lock transaction built");
  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    amountHuman,
    symbol: "tokens",
    mint: mintStr,
    pct,
  };
}

export interface VerifiedTx {
  signature: string;
  ok: boolean;
  err: string | null;
  slot: number;
  blockTime: number | null;
  link: string;
}

/** Verify a submitted signature actually landed on-chain and succeeded. */
export async function verifySignedTransaction(signature: TransactionSignature): Promise<VerifiedTx> {
  const connection = getConnection();
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error("transaction not found on-chain (yet) — try again in a few seconds");
  const err = tx.meta?.err;
  return {
    signature,
    ok: err == null,
    err: err ? JSON.stringify(err) : null,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    link: `https://solscan.io/tx/${signature}`,
  };
}
