// Tiny in-memory TTL cache for read endpoints. Caching cuts latency and eases
// pressure on rate-limited upstreams. Bounded by max size; an expired entry
// is simply recomputed on its next read.

interface Entry<T> {
  value: T;
  expires: number;
}

export class TtlCache<T> {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #map = new Map<string, Entry<T>>();
  // In-flight compute() promises, keyed like #map. Without this, two callers
  // racing on the same cold/expired key (e.g. two tools reading the same
  // cached dictionary at once) would each fire their own upstream request;
  // the second now shares the first's promise instead.
  readonly #pending = new Map<string, Promise<T>>();
  // Bumped by clear(). A compute() started before a clear() (e.g. a read
  // racing a mutation) must not write its now-stale result back afterwards.
  #generation = 0;

  constructor(ttlMs: number, max = 500) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  /** Fresh (non-expired) value, or undefined. */
  get(key: string): T | undefined {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    return hit.expires > Date.now() ? hit.value : undefined;
  }

  /** Drop every cached entry. A successful mutation can change the answer to
   *  any previously-cached read (e.g. `isFavourite`/`isFollowing`, or the
   *  mutated resource itself) — call this after one so the next read is
   *  guaranteed fresh instead of serving up to `ttlMs` of pre-mutation data. */
  clear(): void {
    this.#map.clear();
    this.#pending.clear();
    this.#generation += 1;
  }

  set(key: string, value: T): void {
    if (this.#ttlMs <= 0) return;
    if (!this.#map.has(key) && this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, { value, expires: Date.now() + this.#ttlMs });
  }

  /** Get-or-compute, caching the resolved value. */
  async wrap(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    return this.#dedupe(key, compute);
  }

  // Share one in-flight compute() promise across concurrent callers of the
  // same key, so a cold/expired key triggers exactly one upstream fetch no
  // matter how many callers race on it. The resolved value is cached exactly
  // once (by the shared promise's own .then, not per-caller); a rejection
  // propagates to every waiter and clears the slot so the next call retries.
  #dedupe(key: string, compute: () => Promise<T>): Promise<T> {
    const inFlight = this.#pending.get(key);
    if (inFlight) return inFlight;
    const generation = this.#generation;
    const promise = compute()
      .then((value) => {
        if (generation === this.#generation) this.set(key, value);
        return value;
      })
      .finally(() => {
        if (generation === this.#generation) this.#pending.delete(key);
      });
    this.#pending.set(key, promise);
    return promise;
  }
}
