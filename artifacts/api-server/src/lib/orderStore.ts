/**
 * Persistent order store for the paid service flows.
 *
 * Three interchangeable backends behind one interface:
 *   - PgOrderStore   — used when DATABASE_URL is set (recommended; survives
 *                      deploys AND free-tier instance recycling). Table is
 *                      created automatically at boot.
 *   - FileOrderStore — JSON file under DATA_DIR (default ./data). Survives
 *                      restarts of the same instance (fine on Render free as
 *                      long as the instance isn't recycled), lost on deploys.
 *   - MemoryOrderStore — last resort (dev only).
 *
 * Orders are the source of truth for the payment watcher: it only verifies
 * what's recorded here, so a restart never loses or double-processes a payment.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Pool, type Pool as PoolType } from "pg";
import { logger } from "./logger.js";

export type OrderStatus =
  | "awaiting_payment"
  | "paid"
  | "fulfilled"
  | "rejected"
  | "expired"
  | "cancelled";

export interface OrderTokenRef {
  symbol: string;
  name: string;
  chain: string;
  chainId: string;
  address: string;
  dexUrl?: string;
}

export interface Order {
  id: string;
  userId: number;
  chatId: number;
  username?: string;
  service: string; // "volume" | "dex_update" | "dex_ads" | "dex_trending"
  packageName?: string;
  token: OrderTokenRef;
  /** Display amount in native units, e.g. 2.5 (SOL). */
  amount: number;
  /** Exact amount in smallest units as a decimal string (wei / lamports / nanotons). */
  amountSmallest: string;
  currency: "SOL" | "ETH" | "BNB" | "TON";
  chainId: "solana" | "ethereum" | "bsc" | "base" | "ton";
  /** Receiving wallet for this order (snapshot at creation time). */
  wallet: string;
  status: OrderStatus;
  txHash?: string;
  txLink?: string;
  paidAt?: number;
  createdAt: number;
  expiresAt: number;
  fulfilledAt?: number;
  adminNote?: string;
  /** Extra human-readable details, e.g. { "Hours": "3", "Tier": "Top 10" }. */
  details?: Record<string, string>;
}

export interface OrderStore {
  create(order: Order): Promise<void>;
  get(id: string): Promise<Order | undefined>;
  update(id: string, patch: Partial<Order>): Promise<Order | undefined>;
  listByStatus(status: OrderStatus): Promise<Order[]>;
  listForUser(userId: number, limit?: number): Promise<Order[]>;
  listRecent(limit?: number): Promise<Order[]>;
  close(): Promise<void>;
}

// ─── ID generation ────────────────────────────────────────────────────────────

const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I confusion

export function newOrderId(): string {
  const bytes = randomBytes(4);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return `DB-${out.slice(0, 6)}`;
}

// ─── Memory store ─────────────────────────────────────────────────────────────

export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, Order>();

  async create(order: Order): Promise<void> {
    this.orders.set(order.id, { ...order });
  }

  async get(id: string): Promise<Order | undefined> {
    const o = this.orders.get(id);
    return o ? { ...o } : undefined;
  }

  async update(id: string, patch: Partial<Order>): Promise<Order | undefined> {
    const current = this.orders.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.orders.set(id, next);
    return { ...next };
  }

  async listByStatus(status: OrderStatus): Promise<Order[]> {
    return [...this.orders.values()].filter((o) => o.status === status);
  }

  async listForUser(userId: number, limit = 10): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }

  async listRecent(limit = 10): Promise<Order[]> {
    return [...this.orders.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }

  async close(): Promise<void> {
    this.orders.clear();
  }
}

// ─── File store (survives instance restarts, not deploys) ────────────────────

export class FileOrderStore implements OrderStore {
  private readonly orders = new Map<string, Order>();
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "orders.json");
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      // fall through — write will fail loudly below
    }
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Order[];
        for (const o of raw) this.orders.set(o.id, o);
        logger.info({ count: this.orders.size, file: this.file }, "File order store loaded");
      } catch (err) {
        logger.error({ err }, "Corrupt orders.json — starting empty (backup kept)");
        try {
          renameSync(this.file, `${this.file}.bak-${Date.now()}`);
        } catch {}
      }
    } else {
      logger.warn({ file: this.file }, "File order store starting empty — orders survive restarts but NOT deploys. Use DATABASE_URL for full persistence.");
    }
  }

  private persist(): void {
    const payload = JSON.stringify([...this.orders.values()], null, 2);
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, payload);
      renameSync(tmp, this.file);
    } catch (err) {
      logger.error({ err }, "Failed to persist orders to disk");
    }
  }

  private schedulePersist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, 300);
    this.saveTimer.unref?.();
  }

  async create(order: Order): Promise<void> {
    this.orders.set(order.id, { ...order });
    this.schedulePersist();
  }

  async get(id: string): Promise<Order | undefined> {
    const o = this.orders.get(id);
    return o ? { ...o } : undefined;
  }

  async update(id: string, patch: Partial<Order>): Promise<Order | undefined> {
    const current = this.orders.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.orders.set(id, next);
    this.schedulePersist();
    return { ...next };
  }

  async listByStatus(status: OrderStatus): Promise<Order[]> {
    return [...this.orders.values()].filter((o) => o.status === status);
  }

  async listForUser(userId: number, limit = 10): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }

  async listRecent(limit = 10): Promise<Order[]> {
    return [...this.orders.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.persist();
  }
}

// ─── Postgres store ───────────────────────────────────────────────────────────

const ORDERS_TABLE = `
CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  status     TEXT   NOT NULL,
  data       JSONB  NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at DESC);
`;

export class PgOrderStore implements OrderStore {
  private constructor(private readonly pool: PoolType) {}

  static async create(databaseUrl: string): Promise<PgOrderStore> {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    await pool.query(ORDERS_TABLE);
    logger.info("Postgres order store ready (table orders ensured)");
    return new PgOrderStore(pool);
  }

  async create(order: Order): Promise<void> {
    await this.pool.query(
      `INSERT INTO orders (id, user_id, status, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [order.id, order.userId, order.status, JSON.stringify(order), order.createdAt, Date.now()],
    );
  }

  async get(id: string): Promise<Order | undefined> {
    const res = await this.pool.query<{ data: Order }>(`SELECT data FROM orders WHERE id = $1`, [id]);
    return res.rows[0]?.data;
  }

  async update(id: string, patch: Partial<Order>): Promise<Order | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await this.pool.query(
      `UPDATE orders SET data = $2::jsonb, status = $3, updated_at = $4 WHERE id = $1`,
      [id, JSON.stringify(next), next.status, Date.now()],
    );
    return next;
  }

  async listByStatus(status: OrderStatus): Promise<Order[]> {
    const res = await this.pool.query<{ data: Order }>(
      `SELECT data FROM orders WHERE status = $1 ORDER BY created_at ASC`,
      [status],
    );
    return res.rows.map((r) => r.data);
  }

  async listForUser(userId: number, limit = 10): Promise<Order[]> {
    const res = await this.pool.query<{ data: Order }>(
      `SELECT data FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return res.rows.map((r) => r.data);
  }

  async listRecent(limit = 10): Promise<Order[]> {
    const res = await this.pool.query<{ data: Order }>(
      `SELECT data FROM orders ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => r.data);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export async function createOrderStore(
  databaseUrl: string | undefined,
  dataDir: string,
): Promise<OrderStore> {
  if (databaseUrl) {
    try {
      return await PgOrderStore.create(databaseUrl);
    } catch (err) {
      logger.error({ err }, "Failed to init Postgres order store — falling back to file store");
    }
  }
  try {
    return new FileOrderStore(dataDir);
  } catch (err) {
    logger.error({ err }, "Failed to init file order store — falling back to memory (orders will NOT persist)");
    return new MemoryOrderStore();
  }
}
