import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../lib/cache.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("wrap caches and reuses the fresh value", async () => {
  const cache = new TtlCache<number>(60_000);
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return 42;
  };
  assert.equal(await cache.wrap("k", compute), 42);
  assert.equal(await cache.wrap("k", compute), 42);
  assert.equal(calls, 1);
});

test("clear() drops cached entries so the next wrap() recomputes", async () => {
  const cache = new TtlCache<number>(60_000);
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return calls;
  };
  assert.equal(await cache.wrap("k", compute), 1);
  cache.clear();
  assert.equal(
    await cache.wrap("k", compute),
    2,
    "cleared key must recompute, not reuse the old value",
  );
  assert.equal(calls, 2);
});

test("a compute() in flight across a clear() doesn't cache its pre-clear result", async () => {
  const cache = new TtlCache<string>(60_000);
  let release!: (v: string) => void;
  const slow = cache.wrap("k", () => new Promise<string>((r) => (release = r)));
  cache.clear(); // e.g. a mutation finished while this read was in flight
  release("stale");
  assert.equal(await slow, "stale", "the in-flight caller still gets its own answer");
  assert.equal(cache.get("k"), undefined, "but the pre-clear result must not be cached");
});

test("a pre-clear compute() settling doesn't drop the post-clear in-flight slot", async () => {
  const cache = new TtlCache<string>(60_000);
  let releaseOld!: (v: string) => void;
  let releaseNew!: (v: string) => void;
  let calls = 0;
  const old = cache.wrap("k", () => new Promise<string>((r) => (releaseOld = r)));
  cache.clear();
  const fresh = cache.wrap("k", () => {
    calls += 1;
    return new Promise<string>((r) => (releaseNew = r));
  });
  releaseOld("stale");
  await old;
  // The old compute's cleanup must not have removed the new one's slot: a
  // third caller still shares the in-flight request instead of starting one.
  const third = cache.wrap("k", async () => {
    calls += 1;
    return "duplicate";
  });
  releaseNew("fresh");
  assert.equal(await fresh, "fresh");
  assert.equal(await third, "fresh");
  assert.equal(calls, 1);
});

test("ttl <= 0 disables caching", async () => {
  const cache = new TtlCache<number>(0);
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return 1;
  };
  await cache.wrap("k", compute);
  await cache.wrap("k", compute);
  assert.equal(calls, 2);
});

test("wrap: concurrent calls on a cold key share one in-flight compute()", async () => {
  const cache = new TtlCache<number>(60_000);
  let calls = 0;
  const compute = async () => {
    calls += 1;
    await tick(5);
    return 7;
  };
  // Two callers race on the same key before either resolves.
  const [a, b] = await Promise.all([cache.wrap("k", compute), cache.wrap("k", compute)]);
  assert.equal(a, 7);
  assert.equal(b, 7);
  assert.equal(calls, 1); // only one real compute(), not two
  // A later, non-concurrent call still gets the (now cached) value without recomputing.
  assert.equal(await cache.wrap("k", compute), 7);
  assert.equal(calls, 1);
});

test("wrap: a failed in-flight compute() clears the slot so the next call retries", async () => {
  const cache = new TtlCache<number>(60_000);
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("boom");
  };
  await assert.rejects(() => cache.wrap("k", failing));
  await assert.rejects(() => cache.wrap("k", failing));
  assert.equal(calls, 2); // second call retried, not stuck on a resolved rejection
});

test("set() evicts the oldest-inserted entry once max is reached, keeping the newer ones", () => {
  const cache = new TtlCache<number>(60_000, 3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);

  // A 4th distinct key, past `max` — must evict "a" (the oldest insertion), not "b" or "c".
  cache.set("d", 4);
  assert.equal(cache.get("a"), undefined, "oldest entry must be evicted at the max boundary");
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.get("d"), 4);
});

test("set() on an already-present key doesn't evict anything, even at max capacity", () => {
  const cache = new TtlCache<number>(60_000, 2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 10); // overwrite, not a new key — must not trigger eviction
  assert.equal(cache.get("a"), 10);
  assert.equal(
    cache.get("b"),
    2,
    "b must survive — overwriting an existing key isn't a new insert",
  );
});
