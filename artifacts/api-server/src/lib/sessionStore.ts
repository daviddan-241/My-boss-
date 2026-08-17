/**
 * Session persistence for the Telegram bot.
 *
 * Two interchangeable stores behind one interface:
 *  - MemorySessionStore  — zero-config default (dev / tiny deployments)
 *  - PgSessionStore      — used automatically when DATABASE_URL is set, so
 *    conversation state survives restarts and platform redeploys.
 *
 * The Postgres store self-creates its table at boot (CREATE TABLE IF NOT
 * EXISTS), so no separate migration step is required on deploy.
 */

import { Pool, type Pool as PoolType } from "pg";
import { logger } from "./logger.js";
import { setSessionCount } from "./statusRegistry.js";

export interface BotSession {
  step: string;
  /** Chain hint selected by the user for EVM addresses, e.g. "ethereum". */
  chainHint?: string;
  /** Address being resolved while the user picks a chain manually. */
  pendingAddress?: string;
  /** In-progress order draft (service flow data, JSON-safe). */
  draft?: Record<string, unknown>;
  /** Last successfully resolved token, kept for refresh flows. */
  lastToken?: {
    name: string;
    symbol: string;
    chain: string;
    chainId: string;
    chainEmoji: string;
    address: string;
    price?: string;
    priceRaw?: number;
    marketCap?: number;
    liquidity?: number;
    volume24h?: number;
    bondingCurve?: number;
    status: string;
    dexUrl?: string;
    source: string;
    sources?: string[];
  };
}

export interface SessionStore {
  get(userId: number): Promise<BotSession | undefined>;
  set(userId: number, session: BotSession): Promise<void>;
  delete(userId: number): Promise<void>;
  count(): Promise<number>;
  close(): Promise<void>;
}

// ─── Memory store ────────────────────────────────────────────────────────────

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<number, BotSession>();

  async get(userId: number): Promise<BotSession | undefined> {
    return this.sessions.get(userId);
  }

  async set(userId: number, session: BotSession): Promise<void> {
    this.sessions.set(userId, session);
    setSessionCount(this.sessions.size);
  }

  async delete(userId: number): Promise<void> {
    this.sessions.delete(userId);
    setSessionCount(this.sessions.size);
  }

  async count(): Promise<number> {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }
}

// ─── Postgres store ──────────────────────────────────────────────────────────

const SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS bot_sessions (
  user_id    BIGINT PRIMARY KEY,
  step       TEXT        NOT NULL DEFAULT 'idle',
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export class PgSessionStore implements SessionStore {
  private constructor(
    private readonly pool: PoolType,
  ) {}

  /** Creates the store (and its table) from DATABASE_URL. */
  static async create(databaseUrl: string): Promise<PgSessionStore> {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Fail fast on unreachable DB: a configured-but-broken DATABASE_URL should
    // not silently downgrade the bot to in-memory sessions.
    await pool.query(SESSIONS_TABLE);
    logger.info("Postgres session store ready (table bot_sessions ensured)");
    return new PgSessionStore(pool);
  }

  async get(userId: number): Promise<BotSession | undefined> {
    const res = await this.pool.query<{ data: BotSession }>(
      `SELECT data FROM bot_sessions WHERE user_id = $1`,
      [userId],
    );
    return res.rows[0]?.data;
  }

  async set(userId: number, session: BotSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO bot_sessions (user_id, step, data, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (user_id)
       DO UPDATE SET step = EXCLUDED.step, data = EXCLUDED.data, updated_at = now()`,
      [userId, session.step, JSON.stringify(session)],
    );
  }

  async delete(userId: number): Promise<void> {
    await this.pool.query(`DELETE FROM bot_sessions WHERE user_id = $1`, [userId]);
  }

  async count(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM bot_sessions`);
    return Number(res.rows[0]?.n ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export async function createSessionStore(databaseUrl: string | undefined): Promise<SessionStore> {
  if (databaseUrl) {
    try {
      return await PgSessionStore.create(databaseUrl);
    } catch (err) {
      logger.error({ err }, "Failed to init Postgres session store — falling back to memory");
      logger.warn("Sessions will NOT survive restarts until DATABASE_URL is reachable");
    }
  } else {
    logger.warn("No DATABASE_URL — sessions live in memory and do NOT survive restarts");
  }
  return new MemorySessionStore();
}
