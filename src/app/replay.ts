/**
 * jti replay protection for Wire action calls.
 *
 * Every action call carries a one-time `jti`. The app records each one until
 * the token could no longer verify anyway (exp + clock tolerance), and refuses
 * a second call carrying the same one.
 *
 * The default store is in memory, which protects exactly one process (one
 * Node server, one Bun server, one Workers isolate). An app that runs more
 * than one instance — any Cloudflare Worker under real traffic, any
 * horizontally scaled server — must pass a shared store, or a captured call
 * can be replayed once against each other instance within its 60 seconds.
 */

/**
 * A place to record used `jti`s. `markUsed` must be ATOMIC: it records the key
 * and reports whether it was new in one step (Redis `SET key 1 NX EX ttl`, a
 * Durable Object, a unique-key INSERT). A read-then-write pair across
 * instances lets two concurrent replays both pass, and Workers KV is
 * eventually consistent, so it is not a replay store.
 *
 * Throwing (store unreachable) fails the call closed with 503.
 */
export interface ReplayStore {
  /**
   * Record `key` as used for the next `ttlSeconds` (a whole number, at least
   * 1: long enough that the token can no longer verify when it lapses).
   * Return true if it was not already recorded, false if it was.
   */
  markUsed(key: string, ttlSeconds: number): boolean | Promise<boolean>;
}

export interface MemoryReplayStoreOptions {
  /**
   * Most live entries held at once. When full and nothing has expired, new
   * calls fail closed (503) rather than evicting a live entry, since evicting
   * one would reopen its replay window. Default 100,000, which covers well
   * over 1,000 calls a second at the 60-second token lifetime.
   */
  maxEntries?: number;
  /** Clock for expiry, epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
}

/** In-process replay store with TTL. See the module note on multi-instance apps. */
export class MemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private writes = 0;

  constructor(options: MemoryReplayStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100_000;
    this.now = options.now ?? Date.now;
  }

  markUsed(key: string, ttlSeconds: number): boolean {
    const nowSec = this.now() / 1000;
    const expiresAt = nowSec + Math.max(1, ttlSeconds);
    const existing = this.entries.get(key);
    if (existing !== undefined && existing > nowSec) return false;

    // Sweep expired entries now and then so a quiet store does not sit at its
    // high-water mark.
    if (++this.writes % 1024 === 0) this.prune(nowSec);

    if (existing === undefined && this.entries.size >= this.maxEntries) {
      this.prune(nowSec);
      if (this.entries.size >= this.maxEntries) {
        throw new Error('MemoryReplayStore is full');
      }
    }
    // Map iteration is insertion order; delete first so a re-recorded key
    // moves to the end and pruning stays oldest-first.
    this.entries.delete(key);
    this.entries.set(key, expiresAt);
    return true;
  }

  /** Live entries (for tests and metrics). */
  get size(): number {
    return this.entries.size;
  }

  private prune(nowSec: number): void {
    for (const [key, exp] of this.entries) {
      if (exp <= nowSec) this.entries.delete(key);
    }
  }
}

let defaultStore: MemoryReplayStore | undefined;

/** The process-wide default store used when none is passed. */
export function defaultReplayStore(): MemoryReplayStore {
  defaultStore ??= new MemoryReplayStore();
  return defaultStore;
}
