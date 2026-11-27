// Tiny in-memory TTL cache for read endpoints. Caching cuts latency and eases
// pressure on rate-limited upstreams. Bounded by max size; an expired entry
// is simply recomputed on its next read.

import { cancelledError, raceAbort } from "./cancel.ts";

interface Entry<T> {
  value: T;
  expires: number;
}

/** One shared in-flight compute(): aborted once its last waiter cancels. */
interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
}

export class TtlCache<T> {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #map = new Map<string, Entry<T>>();
  // In-flight compute() promises, keyed like #map. Without this, two callers
  // racing on the same cold/expired key (e.g. two tools reading the same
  // cached dictionary at once) would each fire their own upstream request;
  // the second now shares the first's promise instead.
  readonly #pending = new Map<string, Flight<T>>();
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

  /** Get-or-compute, caching the resolved value. `signal` is the caller's
   *  cancellation: the caller stops waiting on it, and the shared compute()
   *  is aborted only once every caller waiting on it has cancelled. */
  async wrap(
    key: string,
    compute: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw cancelledError();
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const flight = this.#dedupe(key, compute);
    if (!signal) {
      flight.waiters = Infinity; // a caller that can't cancel keeps the fetch alive
      return flight.promise;
    }
    flight.waiters += 1;
    const leave = () => {
      flight.waiters -= 1;
      if (flight.waiters > 0) return;
      // Nobody is waiting any more: stop the fetch, and let the next caller
      // start a fresh one instead of joining this aborted one.
      if (this.#pending.get(key) === flight) this.#pending.delete(key);
      flight.controller.abort();
    };
    signal.addEventListener("abort", leave, { once: true });
    try {
      return await raceAbort(flight.promise, signal);
    } finally {
      signal.removeEventListener("abort", leave);
    }
  }

  // Share one in-flight compute() across concurrent callers of the same key,
  // so a cold/expired key triggers exactly one upstream fetch no matter how
  // many callers race on it. The resolved value is cached exactly once (by
  // the shared promise's own .then, not per-caller); a rejection propagates
  // to every waiter and clears the slot so the next call retries.
  #dedupe(key: string, compute: (signal: AbortSignal) => Promise<T>): Flight<T> {
    const inFlight = this.#pending.get(key);
    if (inFlight) return inFlight;
    const generation = this.#generation;
    const controller = new AbortController();
    const flight: Flight<T> = {
      controller,
      waiters: 0,
      promise: compute(controller.signal)
        .then((value) => {
          if (generation === this.#generation) this.set(key, value);
          return value;
        })
        .finally(() => {
          if (generation === this.#generation && this.#pending.get(key) === flight) {
            this.#pending.delete(key);
          }
        }),
    };
    // A waiter that left must not turn the shared promise into an unhandled rejection.
    flight.promise.catch(() => {});
    this.#pending.set(key, flight);
    return flight;
  }
}
