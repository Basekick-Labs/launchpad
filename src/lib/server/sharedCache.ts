/**
 * A TTL cache with single-flight loads, for data several viewers poll at
 * once (cluster topology, node metrics). Concurrent callers for a key share
 * one load, which is deliberately not tied to any caller's request signal:
 * one viewer disconnecting must not fail it for the others. Loads bound
 * themselves with their own deadlines.
 *
 * Failures are cached too, for `errorTtlMs(err)`, so a dead upstream is not
 * re-dialled by every poll. Entries are capped; the oldest go first.
 */
export class SharedCache<T> {
  private entries = new Map<string, { value?: T; error?: unknown; expiresAt: number }>();
  private loading = new Map<string, Promise<T>>();

  constructor(
    private readonly opts: {
      ttlMs: number;
      errorTtlMs: (err: unknown) => number;
      maxEntries: number;
    },
  ) {}

  /** The cached value or error, or a shared load. `maxAgeMs` overrides the TTL for this read. */
  async get(key: string, load: () => Promise<T>, maxAgeMs?: number): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      const fresh = maxAgeMs === undefined ? hit.expiresAt > Date.now() : hit.expiresAt - this.opts.ttlMs + maxAgeMs > Date.now();
      if (fresh) {
        if ('error' in hit) throw hit.error;
        return hit.value as T;
      }
      this.entries.delete(key);
    }
    const pending = this.loading.get(key);
    if (pending) return pending;

    let run: Promise<T> | undefined = undefined;
    run = (async () => {
      try {
        const value = await load();
        this.store(key, { value, expiresAt: Date.now() + this.opts.ttlMs });
        return value;
      } catch (error) {
        this.store(key, { error, expiresAt: Date.now() + this.opts.errorTtlMs(error) });
        throw error;
      } finally {
        // Only clear our own load: clear() may have let a newer one start.
        if (this.loading.get(key) === run) this.loading.delete(key);
      }
    })();
    this.loading.set(key, run);
    return run;
  }

  private store(key: string, entry: { value?: T; error?: unknown; expiresAt: number }): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.loading.clear();
  }
}
