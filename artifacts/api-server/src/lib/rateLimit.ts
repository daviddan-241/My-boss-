/**
 * Minimal sliding-window rate limiter for Telegram handlers.
 *
 * Cheap protection against a single chat hammering the bot (which would also
 * hammer the upstream token-data APIs). Drops excess events inside a window;
 * the bot tells the user to slow down at most once per window.
 */

interface WindowCount {
  timestamps: number[];
  warnedAt: number;
}

export class SlidingWindowLimiter {
  private readonly windows = new Map<string, WindowCount>();

  constructor(
    private readonly maxEvents: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Returns true when the key is allowed. The optional `notify` callback fires
   * at most once per window when a key is being throttled, so the caller can
   * tell the user what happened.
   */
  allow(key: string, notify?: () => void): boolean {
    const now = Date.now();
    let w = this.windows.get(key);

    if (!w) {
      w = { timestamps: [], warnedAt: 0 };
      this.windows.set(key, w);
    }

    // Drop timestamps older than the window.
    w.timestamps = w.timestamps.filter((t) => now - t < this.windowMs);

    if (w.timestamps.length >= this.maxEvents) {
      if (now - w.warnedAt > this.windowMs) {
        w.warnedAt = now;
        notify?.();
      }
      return false;
    }

    w.timestamps.push(now);
    return true;
  }

  /** Periodic cleanup so long-lived processes don't leak keys. */
  prune(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    for (const [key, w] of this.windows) {
      if (w.timestamps.length === 0 || w.timestamps[w.timestamps.length - 1] < cutoff) {
        this.windows.delete(key);
      }
    }
  }

  size(): number {
    return this.windows.size;
  }
}
