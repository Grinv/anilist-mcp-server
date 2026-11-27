import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphQLClient } from "../lib/graphql.ts";
import { ApiError } from "../lib/errors.ts";
import { TtlCache } from "../lib/cache.ts";
import { callContext, sleep } from "../lib/cancel.ts";
import { silentLogger, jsonResponse, mockFetch, installFetch } from "./helpers.ts";

function client(): GraphQLClient {
  return new GraphQLClient({ endpoint: "https://graphql.example.test", logger: silentLogger() });
}

function cachedClient(): GraphQLClient {
  return new GraphQLClient({
    endpoint: "https://graphql.example.test",
    logger: silentLogger(),
    cache: new TtlCache<unknown>(300_000),
  });
}

test("sends {query, variables} as a JSON POST body", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { ok: true } }));
  installFetch(t, mock);
  await client().request("query{ok}", { a: 1 });
  assert.equal(mock.calls.length, 1);
  const body = JSON.parse(mock.calls[0]!.init?.body as string) as {
    query: string;
    variables: unknown;
  };
  assert.equal(body.query, "query{ok}");
  assert.deepEqual(body.variables, { a: 1 });
});

test("strips undefined variables (including nested) instead of sending them", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { ok: true } }));
  installFetch(t, mock);
  await client().request("mutation{ok}", {
    mediaId: 1,
    status: undefined,
    startedAt: { year: 2026, month: undefined, day: undefined },
    customLists: undefined,
  });
  const body = JSON.parse(mock.calls[0]!.init?.body as string) as {
    variables: Record<string, unknown>;
  };
  assert.deepEqual(body.variables, { mediaId: 1, startedAt: { year: 2026 } });
  assert.ok(!("status" in body.variables), "undefined top-level var must be omitted entirely");
  assert.ok(!("customLists" in body.variables), "undefined array var must be omitted entirely");
});

test("passes through the auth header only when provided", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { ok: true } }));
  installFetch(t, mock);
  await client().request("query{ok}", {}, { Authorization: "Bearer tok" });
  const headers = mock.calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
});

test("throws ApiError when the GraphQL response carries errors[] even on 200", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: null, errors: [{ message: "Invalid argument" }] }),
  );
  installFetch(t, mock);
  await assert.rejects(
    () => client().request("query{ok}"),
    (err: unknown) =>
      err instanceof ApiError && err.code === "bad_request" && /Invalid argument/.test(err.message),
  );
});

test("surfaces per-field detail from a validation error, not just the generic 'validation' label", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: null,
      errors: [
        {
          message: "validation",
          status: 400,
          validation: { score: ["The score may not be greater than 100."] },
        },
      ],
    }),
  );
  installFetch(t, mock);
  await assert.rejects(
    () => client().request("mutation{ok}"),
    (err: unknown) =>
      err instanceof ApiError &&
      err.code === "bad_request" &&
      /score.*may not be greater than 100/.test(err.message),
  );
});

test("an empty validation object doesn't produce a broken 'validation ()' message", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: null, errors: [{ message: "validation", validation: {} }] }),
  );
  installFetch(t, mock);
  await assert.rejects(
    () => client().request("mutation{ok}"),
    (err: unknown) =>
      err instanceof ApiError && err.code === "bad_request" && err.message === "validation",
  );
});

test("a 429 response is mapped to a retryable rate_limited ApiError by the shared HTTP layer", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse(
      { data: null, errors: [{ message: "Too Many Requests.", status: 429 }] },
      { status: 429, headers: { "retry-after": "1" } },
    ),
  );
  installFetch(t, mock);
  await assert.rejects(
    () => client().request("query{ok}"),
    (err: unknown) => err instanceof ApiError && err.code === "rate_limited" && err.retryable,
  );
});

test("a mutation isn't retried on a 5xx (a replay could re-flip a Toggle*)", async (t) => {
  const mock = mockFetch(() => jsonResponse({ message: "Server Error" }, { status: 500 }));
  installFetch(t, mock);
  await assert.rejects(
    () => client().request("mutation($id:Int){ToggleFavourite(animeId:$id){anime{nodes{id}}}}"),
    (err: unknown) =>
      err instanceof ApiError && err.code === "server_error" && err.writeMayHaveApplied,
  );
  assert.equal(mock.calls.length, 1);
});

test("a mutation is retried on a 429 — AniList rejected it before applying anything", async (t) => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls += 1;
    return calls === 1
      ? jsonResponse(
          { data: null, errors: [{ message: "Too Many Requests.", status: 429 }] },
          { status: 429, headers: { "retry-after": "0" } },
        )
      : jsonResponse({ data: { ok: true } });
  });
  installFetch(t, mock);
  assert.deepEqual(await client().request("mutation{ok}"), { ok: true });
  assert.equal(calls, 2);
});

test("a mutation rejected outright (e.g. validation) isn't flagged as possibly applied", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: null, errors: [{ message: "validation", status: 400 }] }),
  );
  installFetch(t, mock);
  await assert.rejects(
    () => client().request("mutation{ok}"),
    (err: unknown) => err instanceof ApiError && !err.writeMayHaveApplied,
  );
});

test("a failed mutation still clears the read cache — it may have been applied upstream", async (t) => {
  let calls = 0;
  const mock = mockFetch((_url, init) => {
    if (/mutation/.test(init?.body as string)) {
      return jsonResponse({ message: "Server Error" }, { status: 500 });
    }
    calls += 1;
    return jsonResponse({ data: { Viewer: { id: calls } } });
  });
  installFetch(t, mock);
  const c = cachedClient();

  await c.request("query{Viewer{id}}");
  await assert.rejects(() => c.request("mutation{ok}"));
  await c.request("query{Viewer{id}}");
  assert.equal(calls, 2, "the read checking a failed write must re-hit the network");
});

test("the read cache is keyed by the actual auth header value, not just whether one was present", async (t) => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls += 1;
    return jsonResponse({ data: { Viewer: { id: calls } } });
  });
  installFetch(t, mock);
  const c = cachedClient();

  const asA = await c.request("query{Viewer{id}}", {}, { Authorization: "Bearer tokenA" });
  const asB = await c.request("query{Viewer{id}}", {}, { Authorization: "Bearer tokenB" });
  assert.equal(calls, 2, "two different accounts' tokens must not share a cache entry");
  assert.notDeepEqual(asA, asB, "each account must get its own (uncached-from-the-other) response");

  // Same token again — now this one really is a cache hit.
  const asAAgain = await c.request("query{Viewer{id}}", {}, { Authorization: "Bearer tokenA" });
  assert.equal(calls, 2, "a repeated request with the same token must hit the cache");
  assert.deepEqual(asAAgain, asA);
});

test("a successful mutation clears the read cache, so a repeated query re-hits the network", async (t) => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls += 1;
    return jsonResponse({ data: { Viewer: { id: calls }, ok: true } });
  });
  installFetch(t, mock);
  const c = cachedClient();

  await c.request("query{Viewer{id}}", {}, { Authorization: "Bearer tok" });
  await c.request("query{Viewer{id}}", {}, { Authorization: "Bearer tok" });
  assert.equal(calls, 1, "second identical query should still be a cache hit before any mutation");

  await c.request("mutation{ok}", {}, { Authorization: "Bearer tok" });
  assert.equal(calls, 2, "the mutation itself is never cached");

  await c.request("query{Viewer{id}}", {}, { Authorization: "Bearer tok" });
  assert.equal(
    calls,
    3,
    "a query repeated after a mutation must re-hit the network, not serve the pre-mutation cache",
  );
});

test("skipCache bypasses the read cache even for a query", async (t) => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls += 1;
    return jsonResponse({ data: { ok: calls } });
  });
  installFetch(t, mock);
  const c = cachedClient();

  await c.request("query{ok}", {}, undefined, { skipCache: true });
  await c.request("query{ok}", {}, undefined, { skipCache: true });
  assert.equal(calls, 2, "skipCache must re-hit the network every time, never the cache");
});

test("a 200 with data null, or a body that isn't a JSON object, is bad_response", async (t) => {
  for (const body of [{ data: null }, null, "text"]) {
    t.mock.method(globalThis, "fetch", mockFetch(() => jsonResponse(body)).fn);
    await assert.rejects(
      () => client().request("query{ok}"),
      (err: unknown) => err instanceof ApiError && err.code === "bad_response",
      JSON.stringify(body),
    );
  }
});

test("one caller cancelling a shared read doesn't abort it for another caller", async (t) => {
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  let fetchSignal: AbortSignal | undefined | null = null;
  const mock = mockFetch(async (_url, init) => {
    fetchSignal = init?.signal;
    await gate;
    return jsonResponse({ data: { ok: true } });
  });
  installFetch(t, mock);
  const c = cachedClient();
  const one = new AbortController();
  const a = callContext.run({ signal: one.signal, wrote: false }, () => c.request("query{ok}"));
  const b = callContext.run({ signal: new AbortController().signal, wrote: false }, () =>
    c.request("query{ok}"),
  );
  one.abort();
  await assert.rejects(a, { name: "ApiError", code: "cancelled" });
  open();
  assert.deepEqual(await b, { ok: true });
  assert.equal(mock.calls.length, 1, "identical reads share one fetch");
  assert.equal((fetchSignal as AbortSignal | null)?.aborted, false, "the shared fetch ran on");
});

test("a cancelled mutation aborts its fetch, isn't retried, and logs that its outcome is unknown", async (t) => {
  const mock = mockFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  installFetch(t, mock);
  const infos: string[] = [];
  const c = new GraphQLClient({
    endpoint: "https://graphql.example.test",
    logger: { ...silentLogger(), info: (m: string) => infos.push(m) },
    retries: 2,
  });
  const call = new AbortController();
  const pending = callContext.run({ signal: call.signal, wrote: false }, () =>
    c.request("mutation{x}"),
  );
  call.abort();
  await assert.rejects(pending, { name: "ApiError", code: "cancelled" });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(infos, ["mutation cancelled in flight, outcome unknown"]);
});

test("a mutation cancelled while queued is logged as never sent", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { x: 1 } }));
  installFetch(t, mock);
  const infos: string[] = [];
  const c = new GraphQLClient({
    endpoint: "https://graphql.example.test",
    logger: { ...silentLogger(), info: (m: string) => infos.push(m) },
    // Stands in for the RateLimiter queue.
    beforeRequest: (signal) => sleep(60_000, signal),
  });
  const call = new AbortController();
  const pending = callContext.run({ signal: call.signal, wrote: false }, () =>
    c.request("mutation{x}"),
  );
  call.abort();
  await assert.rejects(pending, { name: "ApiError", code: "cancelled" });
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(infos, ["mutation cancelled before it was sent"]);
});

test("a mutation answered 2xx with an unreadable body may have applied", async (t) => {
  installFetch(
    t,
    mockFetch(() => new Response("", { status: 200 })),
  );
  const c = new GraphQLClient({ endpoint: "https://graphql.example.test", logger: silentLogger() });
  await assert.rejects(
    c.request("mutation{x}"),
    (err: unknown) =>
      err instanceof ApiError && err.code === "bad_response" && err.writeMayHaveApplied,
  );
});

test("a successful mutation marks the call as having written", async (t) => {
  installFetch(
    t,
    mockFetch(() => jsonResponse({ data: { x: 1 } })),
  );
  const c = new GraphQLClient({ endpoint: "https://graphql.example.test", logger: silentLogger() });
  const call = { signal: new AbortController().signal, wrote: false };
  await callContext.run(call, () => c.request("query{x}"));
  assert.equal(call.wrote, false);
  await callContext.run(call, () => c.request("mutation{x}"));
  assert.equal(call.wrote, true);
});

test("a skipCache read doesn't clear the read cache; a mutation does", async (t) => {
  installFetch(
    t,
    mockFetch(() => jsonResponse({ data: { ok: 1 } })),
  );
  const cache = new TtlCache<unknown>(60_000);
  const c = new GraphQLClient({
    endpoint: "https://graphql.example.test",
    logger: silentLogger(),
    cache,
  });
  await c.request("query{ok}");
  const key = JSON.stringify({ query: "query{ok}", variables: {}, auth: null });
  assert.notEqual(cache.get(key), undefined);
  await c.request("query{fresh}", {}, undefined, { skipCache: true });
  assert.notEqual(cache.get(key), undefined, "a skipCache read leaves the cache alone");
  await c.request("mutation{x}");
  assert.equal(cache.get(key), undefined, "a mutation clears it");
});
