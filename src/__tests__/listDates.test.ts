// get_user_list's server-side startedAt/completedAt bounds: they must reach
// AniList as FuzzyDateInt (YYYYMMDD) MediaListCollection args, and only when
// the caller actually set them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, mockFetch, installFetch, connectServer } from "./helpers.js";
import { encodeFuzzyDateInt } from "../clients/anilist/fuzzyDate.js";
import { ApiError } from "../lib/errors.js";

type Body = { query: string; variables: Record<string, unknown> };
const bodyOf = (init: RequestInit | undefined): Body => JSON.parse(init?.body as string) as Body;

// Mirrors the live compact response for joshjoshjosh's ANIME list with
// sort:[FINISHED_ON_DESC], chunk 1, perChunk 1, completedAt_greater:20241231,
// completedAt_lesser:20260000 (compact selects no group metadata).
const liveCompletedIn2025 = {
  data: {
    MediaListCollection: {
      hasNextChunk: true,
      lists: [
        {
          entries: [
            {
              id: 466213786,
              status: "COMPLETED",
              score: 10,
              progress: 25,
              media: {
                id: 139630,
                idMal: 49918,
                title: {
                  romaji: "Boku no Hero Academia 6",
                  english: "My Hero Academia Season 6",
                },
              },
            },
          ],
        },
      ],
    },
  },
};

test("encodeFuzzyDateInt packs YYYYMMDD with 0 for a missing month/day", () => {
  assert.equal(encodeFuzzyDateInt({ year: 2025, month: 12, day: 31 }), 20251231);
  assert.equal(encodeFuzzyDateInt({ year: 2027 }), 20270000);
  assert.equal(encodeFuzzyDateInt({ year: 2026, month: 4 }), 20260400);
  assert.equal(encodeFuzzyDateInt({}), undefined);
  assert.equal(encodeFuzzyDateInt(undefined), undefined);
  assert.throws(
    () => encodeFuzzyDateInt({ year: 2020, day: 15 }),
    (err: unknown) => err instanceof ApiError && err.code === "bad_request",
    "a day without a month must not silently become YYYY00DD",
  );
});

test("get_user_list forwards date bounds as FuzzyDateInt args", async (t) => {
  const mock = mockFetch(() => jsonResponse(liveCompletedIn2025));
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  const res = await client.callTool({
    name: "get_user_list",
    arguments: {
      type: "ANIME",
      user: "joshjoshjosh",
      sort: ["FINISHED_ON_DESC"],
      perChunk: 1,
      completedAt_greater: { year: 2024, month: 12, day: 31 },
      completedAt_lesser: { year: 2026 },
      startedAt_greater: { year: 2024, month: 6 },
      startedAt_lesser: { year: 2025, month: 5, day: 1 },
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const { query, variables } = bodyOf(mock.calls[0]!.init);
  assert.match(query, /completedAt_greater:\$completedGreater/);
  assert.match(query, /completedAt_lesser:\$completedLesser/);
  assert.match(query, /startedAt_greater:\$startedGreater/);
  assert.match(query, /startedAt_lesser:\$startedLesser/);
  assert.equal(variables.completedGreater, 20241231);
  assert.equal(variables.completedLesser, 20260000);
  assert.equal(variables.startedGreater, 20240600);
  assert.equal(variables.startedLesser, 20250501);
  const out = res.structuredContent as { count: number; rows: string; hasNextChunk: boolean };
  assert.equal(out.count, 1);
  assert.equal(out.hasNextChunk, true);
  assert.match(
    out.rows,
    /^466213786\t139630\t49918\tCOMPLETED\t10\t25\tMy Hero Academia Season 6$/,
  );
});

test("get_user_list omits unset date bounds from the request", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { MediaListCollection: { hasNextChunk: false, lists: [] } } }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  const res = await client.callTool({
    name: "get_user_list",
    arguments: { type: "ANIME", user: "joshjoshjosh", completedAt_greater: { year: 2025 } },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const { variables } = bodyOf(mock.calls[0]!.init);
  assert.equal(variables.completedGreater, 20250000);
  for (const key of ["completedLesser", "startedGreater", "startedLesser"]) {
    assert.equal(key in variables, false, `${key} must be omitted, not sent as null`);
  }
});

test("get_user_list rejects a date bound without a year before any request", async (t) => {
  const mock = mockFetch(() => jsonResponse({}));
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  const res = await client.callTool({
    name: "get_user_list",
    arguments: { type: "ANIME", user: "joshjoshjosh", completedAt_lesser: { month: 3 } },
  });
  assert.equal(res.isError, true);
  assert.equal(mock.calls.length, 0);
});
