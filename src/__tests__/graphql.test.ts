import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphQLClient } from "../lib/graphql.js";
import { ApiError } from "../lib/errors.js";
import { TtlCache } from "../lib/cache.js";
import { silentLogger, jsonResponse, mockFetch, installFetch } from "./helpers.js";

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

test("throws when data is null with no errors", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: null }));
  installFetch(t, mock);
  await assert.rejects(
    () => client().request("query{ok}"),
    (err: unknown) => err instanceof ApiError && err.code === "unknown",
  );
});
