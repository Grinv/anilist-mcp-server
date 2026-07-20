import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../lib/cache.js";

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

test("wrapStaleOnError serves the stale value when compute fails", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const cache = new TtlCache<number>(1); // 1ms TTL → expires almost immediately
  await cache.wrapStaleOnError("k", async () => 1);
  t.mock.timers.tick(5);
  const v = await cache.wrapStaleOnError("k", async () => {
    throw new Error("upstream down");
  });
  assert.equal(v, 1);
});

test("wrapStaleOnError rethrows when nothing was ever cached", async () => {
  const cache = new TtlCache<number>(60_000);
  await assert.rejects(() =>
    cache.wrapStaleOnError("missing", async () => {
      throw new Error("boom");
    }),
  );
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

test("wrapStaleOnError: concurrent calls on a cold key share one in-flight compute()", async () => {
  const cache = new TtlCache<number>(60_000);
  let calls = 0;
  const compute = async () => {
    calls += 1;
    await tick(5);
    return 9;
  };
  const [a, b] = await Promise.all([
    cache.wrapStaleOnError("k", compute),
    cache.wrapStaleOnError("k", compute),
  ]);
  assert.equal(a, 9);
  assert.equal(b, 9);
  assert.equal(calls, 1);
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

test("wrapStaleOnError: concurrent failures each independently fall back to the same stale value", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const cache = new TtlCache<number>(1); // 1ms TTL → expires almost immediately
  await cache.wrapStaleOnError("k", async () => 5);
  t.mock.timers.tick(5);
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("upstream down");
  };
  const [a, b] = await Promise.all([
    cache.wrapStaleOnError("k", failing),
    cache.wrapStaleOnError("k", failing),
  ]);
  assert.equal(a, 5);
  assert.equal(b, 5);
  assert.equal(calls, 1); // shared failure, not two independent upstream hits
});
