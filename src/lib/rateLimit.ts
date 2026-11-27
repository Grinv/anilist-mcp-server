// Serializes calls and spaces them by a minimum interval, so sustained traffic
// stays under AniList's per-minute ceiling (config's ANILIST_MIN_INTERVAL_MS).
// AniList publishes a single per-minute limit, which even spacing satisfies
// directly — no sliding-window accounting needed.
//
// Acquisitions are ordered through a tail-promise chain, so only one runs at a
// time. In-flight network time still overlaps because acquire() resolves before
// the request itself runs.
import { raceAbort, sleep } from "./cancel.ts";

export class RateLimiter {
  readonly #minIntervalMs: number;
  #tail: Promise<void> = Promise.resolve();
  // null = no acquisition has happened yet, so the min-interval gate doesn't
  // apply to the first call. An explicit sentinel rather than 0: comparing
  // against 0 relied on Date.now() always being far from the epoch, which holds
  // for any real clock but not for a clock mocked to start at 0 (e.g. in tests).
  #lastStart: number | null = null;

  constructor(minIntervalMs: number) {
    this.#minIntervalMs = Math.max(0, minIntervalMs);
  }

  /** Resolves when the caller is allowed to proceed; rejects as cancelled as
   *  soon as `signal` aborts, giving up its place without taking a slot. */
  async acquire(signal?: AbortSignal): Promise<void> {
    const prev = this.#tail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    this.#tail = promise;
    try {
      await raceAbort(prev, signal);
      const wait =
        this.#lastStart !== null ? this.#lastStart + this.#minIntervalMs - Date.now() : 0;
      if (wait > 0) await sleep(wait, signal);
      this.#lastStart = Date.now();
    } finally {
      // Release the next waiter's gate only once ours would have opened, so a
      // cancelled waiter neither stalls the queue nor lets the next one jump
      // ahead of the waiter before it.
      void prev.then(release);
    }
  }
}
