// Serializes calls and spaces them by a minimum interval, so sustained traffic
// stays under AniList's per-minute ceiling (config's ANILIST_MIN_INTERVAL_MS).
// AniList publishes a single per-minute limit, which even spacing satisfies
// directly — no sliding-window accounting needed.
//
// Acquisitions are ordered through a tail-promise chain, so only one runs at a
// time. In-flight network time still overlaps because acquire() resolves before
// the request itself runs.

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

  /** Resolves when the caller is allowed to proceed. */
  acquire(): Promise<void> {
    const prev = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return prev.then(async () => {
      const wait =
        this.#lastStart !== null ? this.#lastStart + this.#minIntervalMs - Date.now() : 0;
      if (wait > 0) await delay(wait);
      this.#lastStart = Date.now();
      // Release the next waiter's gate; the spacing above keeps them in line.
      release();
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
