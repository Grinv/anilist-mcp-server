import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../lib/rateLimit.ts";

// Small windows keep the test fast while exercising the real timing logic.
async function timeAcquires(limiter: RateLimiter, n: number): Promise<number[]> {
  const start = Date.now();
  const stamps: number[] = [];
  for (let i = 0; i < n; i += 1) {
    await limiter.acquire();
    stamps.push(Date.now() - start);
  }
  return stamps;
}

test("zero interval imposes no delay", async () => {
  const stamps = await timeAcquires(new RateLimiter(0), 5);
  assert.ok(stamps[4]! < 30, `expected near-instant, got ${stamps[4]}ms`);
});

test("min interval spaces consecutive acquisitions", async () => {
  const stamps = await timeAcquires(new RateLimiter(40), 3);
  assert.ok(stamps[1]! >= 35, `2nd should wait ~40ms, got ${stamps[1]}ms`);
  assert.ok(stamps[2]! >= 75, `3rd should wait ~80ms, got ${stamps[2]}ms`);
});

test("first acquisition never waits, even when the clock starts at/near the epoch", async (t) => {
  // Regression: acquire() used to compare against a `#lastStart = 0` sentinel,
  // silently relying on Date.now() always being far from 0 — true for any real
  // clock, but not for one mocked to start at 0. Mock only Date
  // (not setTimeout) and measure REAL elapsed time via performance.now()
  // (unaffected by the Date mock): if the bug were back, the first acquire()
  // would await a genuine ~40ms setTimeout, which this would catch.
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const limiter = new RateLimiter(40);
  const realStart = performance.now();
  await limiter.acquire();
  const realElapsed = performance.now() - realStart;
  assert.ok(realElapsed < 20, `first acquisition should not really wait, took ${realElapsed}ms`);
});

test("a cancelled waiter rejects at once and neither stalls the queue nor lets the next jump ahead", async () => {
  const limiter = new RateLimiter(150);
  const start = Date.now();
  await limiter.acquire(); // t=0
  const second = limiter.acquire(); // sleeps until ~150
  const call = new AbortController();
  const cancelled = limiter.acquire(call.signal); // queued behind `second`
  const third = limiter.acquire(); // queued behind `cancelled`
  call.abort();
  await assert.rejects(cancelled, { name: "ApiError", code: "cancelled" });
  assert.ok(Date.now() - start < 50, "the cancelled waiter must not wait out its turn");
  await second;
  await third;
  const elapsed = Date.now() - start;
  // `third` takes the slot `cancelled` gave up: ~300ms, not ~150 (jumping
  // ahead of `second`'s spacing) nor ~450 (a slot wasted on the cancelled one).
  assert.ok(elapsed >= 280 && elapsed < 420, `third should start at ~300ms, got ${elapsed}ms`);
});

test("a waiter cancelled while sleeping out the interval gives its slot back", async () => {
  const limiter = new RateLimiter(150);
  const start = Date.now();
  await limiter.acquire();
  const call = new AbortController();
  const cancelled = limiter.acquire(call.signal); // sleeping until ~150
  const next = limiter.acquire();
  setTimeout(() => call.abort(), 20);
  await assert.rejects(cancelled, { code: "cancelled" });
  await next;
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 130 && elapsed < 270, `next should take the ~150ms slot, got ${elapsed}ms`);
});
