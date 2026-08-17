/**
 * Tiny in-process status registry.
 *
 * The API server and the Telegram bot write their runtime state here so the
 * health endpoints (/api/healthz, /api/health/bot) can report real values
 * (bot mode, uptime, session count, lookup stats) instead of a static "ok".
 */

export interface BotStatus {
  enabled: boolean;
  mode: "polling" | "webhook";
  startedAt: string | null;
  webhookUrl: string | null;
  lastError: string | null;
  pollErrors: number;
}

export interface LookupStats {
  total: number;
  cacheHits: number;
  failures: number;
  cacheSize: number;
  /** Per-source counters: { [sourceName]: { ok, fail, avgMs, lastError } } */
  sources: Record<
    string,
    { ok: number; fail: number; avgMs: number; lastError: string | null }
  >;
}

export interface StatusSnapshot {
  server: {
    startedAt: string;
    uptimeSec: number;
    memoryRssMb: number;
    nodeVersion: string;
  };
  bot: BotStatus;
  sessions: number;
  lookups: LookupStats;
}

const botStatus: BotStatus = {
  enabled: false,
  mode: "polling",
  startedAt: null,
  webhookUrl: null,
  lastError: null,
  pollErrors: 0,
};

const lookupStats: LookupStats = {
  total: 0,
  cacheHits: 0,
  failures: 0,
  cacheSize: 0,
  sources: {},
};

let sessionCount = 0;
let serverStartedAt: Date = new Date();

export function setServerStartedAt(d: Date): void {
  serverStartedAt = d;
}

export function setBotStatus(patch: Partial<BotStatus>): void {
  Object.assign(botStatus, patch);
}

export function setSessionCount(n: number): void {
  sessionCount = n;
}

export function recordLookupResult(ok: boolean, cacheHit: boolean): void {
  lookupStats.total += 1;
  if (cacheHit) lookupStats.cacheHits += 1;
  if (!ok) lookupStats.failures += 1;
}

export function setLookupCacheSize(n: number): void {
  lookupStats.cacheSize = n;
}

export function recordSourceResult(
  source: string,
  ok: boolean,
  elapsedMs: number,
  error?: string,
): void {
  const s = (lookupStats.sources[source] ??= { ok: 0, fail: 0, avgMs: 0, lastError: null });
  if (ok) {
    s.ok += 1;
  } else {
    s.fail += 1;
    if (error) s.lastError = error.slice(0, 200);
  }
  s.avgMs = s.avgMs === 0 ? elapsedMs : (s.avgMs * 0.9 + elapsedMs * 0.1);
}

export function getStatusSnapshot(): StatusSnapshot {
  const now = Date.now();
  return {
    server: {
      startedAt: serverStartedAt.toISOString(),
      uptimeSec: Math.round((now - serverStartedAt.getTime()) / 1000),
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      nodeVersion: process.version,
    },
    bot: { ...botStatus },
    sessions: sessionCount,
    lookups: { ...lookupStats, sources: { ...lookupStats.sources } },
  };
}
