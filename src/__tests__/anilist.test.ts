import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AniListClient } from "../clients/anilist.js";
import * as media from "../clients/anilist/media.js";
import * as user from "../clients/anilist/user.js";
import * as search from "../clients/anilist/search.js";
import * as list from "../clients/anilist/list.js";
import * as favourites from "../clients/anilist/favourites.js";
import * as activity from "../clients/anilist/activity.js";
import * as thread from "../clients/anilist/thread.js";
import * as misc from "../clients/anilist/misc.js";
import * as notification from "../clients/anilist/notification.js";
import * as recommendation from "../clients/anilist/recommendation.js";
import * as people from "../clients/anilist/people.js";
import { ApiError } from "../lib/errors.js";
import type { TokenState } from "../lib/tokenStore.js";
import type {
  MediaId,
  ListEntryId,
  MalId,
  ThreadId,
  ActivityId,
  UserId,
  CharacterId,
  StaffId,
} from "../clients/anilist/ids.js";
import { silentLogger, jsonResponse, mockFetch, installFetch, testConfig } from "./helpers.js";

// This file calls clients/anilist/*.ts functions directly, bypassing the
// zod-validated tool inputSchema that normally produces an already-branded
// value (see tools/outputSchemas.ts's mediaId/listEntryId/etc.) — a plain
// literal needs an explicit (test-only) cast to satisfy a branded signature.
// Same range/positivity constraint as tools/outputSchemas.ts's `anilistId`
// (not imported directly — this file deliberately tests only the client
// layer, never the tools layer) — a typo like `id<MediaId>(-1)` now throws
// loudly instead of silently producing a branded value the real schema
// would reject.
function id<T>(n: number): T {
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new Error(`id() test helper: ${n} is not a valid AniList numeric ID`);
  }
  return n as T;
}

function tempStorePath(name: string): string {
  return join(tmpdir(), `anilist-mcp-server-test-${name}.json`);
}

test("getMedia's compact format asks AniList for only the identifying fields", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { Page: { media: [] } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig(), silentLogger());

  await media.getMedia(client.ctx(), "ANIME", [id<MediaId>(1)], false, "compact");
  await media.getMedia(client.ctx(), "ANIME", [id<MediaId>(1)], false);

  const [compact, full] = mock.calls.map(
    (call) => (JSON.parse(call.init?.body as string) as { query: string }).query,
  ) as [string, string];
  // Trimming after the fact would still pay for the bandwidth: measured live
  // at 4,182 bytes per title full versus 169 compact.
  for (const field of ["description", "tags", "rankings", "externalLinks", "mediaListEntry"]) {
    assert.doesNotMatch(compact, new RegExp(field), `compact must not select ${field}`);
    assert.match(full, new RegExp(field), `full must still select ${field}`);
  }
  for (const field of ["idMal", "title", "episodes"]) {
    assert.match(compact, new RegExp(field), `compact must still identify the title via ${field}`);
  }
  // streamingEpisodes is a detail field; asking for it alongside compact is
  // meaningless rather than an error, so it must simply not appear. A
  // different id on purpose: with the same one this call produces a
  // byte-identical query and the read cache answers it without a request,
  // leaving nothing to assert on.
  await media.getMedia(client.ctx(), "ANIME", [id<MediaId>(2)], true, "compact");
  assert.equal(mock.calls.length, 3, "the third lookup must actually reach the network");
  const withStreaming = (JSON.parse(mock.calls[2]!.init?.body as string) as { query: string })
    .query;
  assert.doesNotMatch(withStreaming, /streamingEpisodes/);
});

test("getMediaByMalId filters on idMal and re-keys results by idMal, not id", async (t) => {
  // The AniList id and the MAL id of the same title are different numbers
  // (fixture mirrors the real pairing: AniList 30001 is MONSTER, MAL 1).
  // Re-keying by the wrong field would silently return null for everything.
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Page: {
          media: [
            { id: 30001, idMal: 1 },
            { id: 30002, idMal: 2 },
          ],
        },
      },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig(), silentLogger());

  // Requested out of ascending order: AniList returns id_in/idMal_in results
  // sorted by its own id, so the caller-order promise has to be restored here.
  const many = (await media.getMediaByMalId(client.ctx(), "MANGA", [
    id<MalId>(2),
    id<MalId>(1),
    id<MalId>(999),
  ])) as ({ idMal: number } | null)[];
  assert.deepEqual(
    many.map((m) => m?.idMal ?? null),
    [2, 1, null],
    "results must follow the requested MAL-id order, with null for one that didn't resolve",
  );

  const { query } = JSON.parse(mock.calls[0]!.init?.body as string) as { query: string };
  assert.match(query, /idMal_in:\$ids/);
  assert.doesNotMatch(query, /[^M]id_in:/, "must not fall back to the AniList-id filter");
});

test("getMedia(single id) queries Media(), getMedia(array) queries Page.media()", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("Page("))
      return jsonResponse({ data: { Page: { media: [{ id: 1 }, { id: 2 }] } } });
    return jsonResponse({ data: { Media: { id: 1 } } });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  const single = await media.getMedia(client.ctx(), "ANIME", id<MediaId>(1));
  assert.deepEqual(single, { id: 1 });

  const many = await media.getMedia(client.ctx(), "ANIME", [id<MediaId>(1), id<MediaId>(2)]);
  assert.deepEqual(many, [{ id: 1 }, { id: 2 }]);
});

test("getSchedule aliases a mediaId existence check into the same request as the schedule query", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        exists: { id: 1 },
        schedule: { pageInfo: { hasNextPage: false }, airingSchedules: [{ episode: 5 }] },
      },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  const result = await media.getSchedule(client.ctx(), id<MediaId>(1));
  assert.deepEqual(result, { schedule: [{ episode: 5 }], hasNextPage: false });
  assert.equal(mock.calls.length, 1, "the existence check and schedule query are one request");
  const query = JSON.parse(mock.calls[0]!.init?.body as string).query as string;
  assert.match(query, /exists:Media\(id:\$mediaId,type:ANIME\)/);
});

test("getSchedule rejects with not_found for a nonexistent mediaId, instead of silently returning an empty schedule", async (t) => {
  // Confirmed live: AniList 404s the *entire* HTTP response (not just the
  // aliased `exists` field) when Media(id) doesn't resolve, even combined
  // with other root fields in the same request — see docs/api-references.md.
  const mock = mockFetch(() =>
    jsonResponse(
      { errors: [{ message: "Not Found.", status: 404 }], data: { exists: null, schedule: null } },
      { status: 404 },
    ),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await assert.rejects(
    () => media.getSchedule(client.ctx(), id<MediaId>(999999999)),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
  assert.equal(mock.calls.length, 1, "the not-found check costs no extra request");
});

test("getSchedule's exists check filters on type:ANIME, rejecting a real manga id instead of returning an empty schedule", async (t) => {
  // Confirmed live: airingSchedules(mediaId) has no type filter of its own,
  // so a real MANGA id used to pass the (untyped) existence check and just
  // silently return an empty schedule, indistinguishable from "no upcoming
  // episodes." exists:Media(id,type:ANIME) now rejects it up front.
  const mock = mockFetch(() =>
    jsonResponse(
      { errors: [{ message: "Not Found.", status: 404 }], data: { exists: null, schedule: null } },
      { status: 404 },
    ),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await assert.rejects(
    () => media.getSchedule(client.ctx(), id<MediaId>(30013)), // a real manga id (One Piece manga)
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
  const query = JSON.parse(mock.calls[0]!.init?.body as string).query as string;
  assert.match(query, /exists:Media\(id:\$mediaId,type:ANIME\)/);
});

test("getSchedule with no mediaId skips the existence check and goes straight to the site-wide schedule", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { schedule: { pageInfo: { hasNextPage: false }, airingSchedules: [] } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await media.getSchedule(client.ctx());
  const query = JSON.parse(mock.calls[0]!.init?.body as string).query as string;
  assert.ok(!query.includes("exists:Media"), "no mediaId means no existence check to make");
});

test("getThreadComments aliases a threadId existence check into the same request as the comments query", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: { exists: { id: 1 }, Page: { pageInfo: {}, threadComments: [{ id: 5 }] } },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  const result = await thread.getThreadComments(client.ctx(), id<ThreadId>(1));
  assert.deepEqual(result, { pageInfo: {}, threadComments: [{ id: 5 }] });
  assert.equal(mock.calls.length, 1, "the existence check and comments query are one request");
  const query = JSON.parse(mock.calls[0]!.init?.body as string).query as string;
  assert.match(query, /exists:Thread\(id:\$threadId\)/);
});

test("getThreadComments rejects with not_found for a nonexistent threadId, instead of silently returning an empty page", async (t) => {
  // Confirmed live: AniList 404s the entire HTTP response (not just the
  // aliased `exists` field) when Thread(id) doesn't resolve, same as
  // getSchedule's Media(id) existence check.
  const mock = mockFetch(() =>
    jsonResponse(
      { errors: [{ message: "Not Found.", status: 404 }], data: { exists: null, Page: null } },
      { status: 404 },
    ),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await assert.rejects(
    () => thread.getThreadComments(client.ctx(), id<ThreadId>(999999999)),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
  assert.equal(mock.calls.length, 1, "the not-found check costs no extra request");
});

test("getUserProfile queries User(name:...) for a string username, not just User(id:...) for a number", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { User: { id: 1, name: "Grinv" } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await user.getUserProfile(client.ctx(), "Grinv");
  const { query, variables } = JSON.parse(mock.calls[0]!.init?.body as string) as {
    query: string;
    variables: Record<string, unknown>;
  };
  assert.match(query, /User\(name:\$name\)/);
  assert.deepEqual(variables, { name: "Grinv" });
});

test("getUserProfile/getUserStats/getFullUserInfo reject with not_found instead of returning null, for a User query that resolves to null", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { User: null } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  for (const fn of [user.getUserProfile, user.getUserStats, user.getFullUserInfo]) {
    await assert.rejects(
      () => fn(client.ctx(), "no-such-user"),
      (err: unknown) => err instanceof ApiError && err.code === "not_found",
    );
  }
});

test("searchMedia passes isAdult through when set, and omits it when left undefined", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { Page: { media: [] } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  // No filter at all (the tool layer's `sfw: false` default) → omitted, not sent as false.
  await search.searchMedia(client.ctx(), "ANIME", { term: "frieren", filter: {} });
  let vars = JSON.parse(mock.calls[0]!.init?.body as string).variables as Record<string, unknown>;
  assert.ok(
    !("isAdult" in vars),
    "an unset isAdult filter must be omitted, not sent as undefined/false",
  );

  // The tool layer's `sfw: true` maps to an explicit isAdult: false.
  await search.searchMedia(client.ctx(), "ANIME", { term: "frieren", filter: { isAdult: false } });
  vars = JSON.parse(mock.calls[1]!.init?.body as string).variables as Record<string, unknown>;
  assert.equal(vars.isAdult, false);
});

test("searchMedia defaults sort to SEARCH_MATCH only when a term is present, and trims the term", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { Page: { media: [] } } }));
  installFetch(t, mock);
  // Disable the read cache (else the no-term and whitespace-term calls, which
  // build identical variables, would collapse to one fetch) and the throttle.
  const client = new AniListClient(
    testConfig({ CACHE_TTL_MS: "0", ANILIST_MIN_INTERVAL_MS: "0" }),
    silentLogger(),
  );
  const varsOf = (i: number) =>
    JSON.parse(mock.calls[i]!.init?.body as string).variables as Record<string, unknown>;

  // A term with no explicit sort → relevance ranking.
  await search.searchMedia(client.ctx(), "ANIME", { term: "frieren", filter: {} });
  assert.equal(varsOf(0).search, "frieren");
  assert.deepEqual(varsOf(0).sort, ["SEARCH_MATCH"], "relevance sort when a term is given");

  // No term and no explicit sort → AniList's own default order (sort omitted),
  // since ranking by relevance to no term is meaningless.
  await search.searchMedia(client.ctx(), "ANIME", { filter: {} });
  assert.equal(varsOf(1).search, undefined);
  assert.equal(varsOf(1).sort, undefined, "no default sort for a term-less browse");

  // A whitespace-only term is treated as no term at all (dropped, no relevance sort).
  await search.searchMedia(client.ctx(), "ANIME", { term: "   ", filter: {} });
  assert.equal(varsOf(2).search, undefined, "whitespace-only term is dropped");
  assert.equal(varsOf(2).sort, undefined);

  // Surrounding whitespace on a real term is trimmed before sending.
  await search.searchMedia(client.ctx(), "ANIME", { term: "  bebop  ", filter: {} });
  assert.equal(varsOf(3).search, "bebop", "term is trimmed");
  assert.deepEqual(varsOf(3).sort, ["SEARCH_MATCH"]);

  // An explicit sort is always passed through unchanged.
  await search.searchMedia(client.ctx(), "ANIME", {
    sort: ["SCORE_DESC", "POPULARITY_DESC"],
    filter: {},
  });
  assert.deepEqual(varsOf(4).sort, ["SCORE_DESC", "POPULARITY_DESC"]);
});

test("getRecommendationsForMedia requests mediaListEntry and, when excludeInList is set, filters out recommendations already on the caller's list", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Media: {
          recommendations: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: 1,
                mediaRecommendation: { id: 10, mediaListEntry: { id: 99, status: "COMPLETED" } },
              },
              { id: 2, mediaRecommendation: { id: 20, mediaListEntry: null } },
            ],
          },
        },
      },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  const withoutFilter = (await recommendation.getRecommendationsForMedia(
    client.ctx(),
    id<MediaId>(1),
    1,
    10,
  )) as { nodes: unknown[] };
  assert.equal(withoutFilter.nodes.length, 2, "no filtering by default");
  assert.match(
    JSON.parse(mock.calls[0]!.init?.body as string).query as string,
    /mediaListEntry\{id status\}/,
  );

  const filtered = (await recommendation.getRecommendationsForMedia(
    client.ctx(),
    id<MediaId>(1),
    1,
    10,
    true,
  )) as { nodes: { id: number }[] };
  assert.deepEqual(
    filtered.nodes.map((n) => n.id),
    [2],
    "excludeInList must drop the node whose mediaRecommendation already has a mediaListEntry",
  );
});

test("getRecommendationsForMedia doesn't crash when nodes is null and excludeInList is set", async (t) => {
  // AniList normally returns `nodes` as an array, but the outputSchema
  // models it as `.nullish()` — excludeInList's `.filter()` must guard
  // against null rather than crashing.
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Media: {
          recommendations: {
            pageInfo: { hasNextPage: false },
            nodes: null,
          },
        },
      },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  const result = (await recommendation.getRecommendationsForMedia(
    client.ctx(),
    id<MediaId>(1),
    1,
    10,
    true,
  )) as { nodes: unknown[] };
  assert.deepEqual(result.nodes, [], "must return an empty array, not crash");
});

test("getMedia rejects with not_found when Media returns null on a single-id lookup", async (t) => {
  // AniList returns HTTP 404 (not 200+null) for a bad id live, so the HTTP
  // layer throws before data.Media is read — but assertFound() guards the
  // case where a type-mismatch or future API change returns 200 with
  // {Media: null}, matching every sibling (getMediaStatistics/Characters/etc).
  const mock = mockFetch(() => jsonResponse({ data: { Media: null } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await assert.rejects(
    () => media.getMedia(client.ctx(), "ANIME", id<MediaId>(99999999)),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
});

test("saveListEntry refuses without a configured access token", async () => {
  const client = new AniListClient(testConfig({}), silentLogger());
  await assert.rejects(
    () => list.saveListEntry(client.ctx(), { mediaId: id<MediaId>(1), status: "PLANNING" }),
    (err: unknown) => err instanceof ApiError && err.code === "unauthorized",
  );
});

test("saveListEntry sends the Bearer token and omits fields left undefined", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { SaveMediaListEntry: { id: 9, status: "PLANNING" } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  const result = await list.saveListEntry(client.ctx(), {
    mediaId: id<MediaId>(42),
    status: "PLANNING",
  });
  assert.deepEqual(result, { id: 9, status: "PLANNING" });

  const call = mock.calls[0]!;
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  const vars = JSON.parse(call.init?.body as string).variables as Record<string, unknown>;
  assert.deepEqual(vars, { mediaId: 42, status: "PLANNING" });
  assert.ok(
    !("startedAt" in vars) && !("scoreRaw" in vars),
    "unset optional fields must be omitted entirely",
  );
});

test("saveListEntry converts the 0-10 `score` to AniList's raw 0-100 scoreRaw (not the format-dependent `score` arg)", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { SaveMediaListEntry: { id: 9 } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await list.saveListEntry(client.ctx(), { mediaId: id<MediaId>(42), score: 8.5 });
  const { query, variables } = JSON.parse(mock.calls[0]!.init?.body as string) as {
    query: string;
    variables: Record<string, unknown>;
  };
  assert.equal(variables.scoreRaw, 85, "8.5/10 must convert to AniList's raw 0-100 scale (85)");
  assert.ok(!("score" in variables), "must not send the format-dependent `score` arg at all");
  assert.match(query, /scoreRaw:\$scoreRaw/);
});

test("every read path that returns a personal list-entry score pins POINT_10_DECIMAL, so the scale can't follow the account's display scoreFormat", async (t) => {
  // Regression: get_media's mediaListEntry.score used to be requested with no
  // `format` arg, which makes AniList return it in the account's own
  // scoreFormat — the same entry read back as 94 there and 9.4 from
  // get_user_list on a POINT_100 account (confirmed live against a public
  // POINT_100 list). Every path that emits a personal score must pin the
  // format so the 0-10 scale the write side documents holds everywhere.
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Media: { id: 1 },
        MediaListCollection: { lists: [], hasNextChunk: false },
        SaveMediaListEntry: { id: 9 },
      },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await media.getMedia(client.ctx(), "ANIME", id<MediaId>(1));
  await list.getUserList(client.ctx(), "ANIME", "someone");
  await list.saveListEntry(client.ctx(), { mediaId: id<MediaId>(42), status: "PLANNING" });

  for (const call of mock.calls) {
    const { query } = JSON.parse(call.init?.body as string) as { query: string };
    assert.doesNotMatch(
      query,
      // Case-sensitive on purpose: only the bare `score` GraphQL field is a
      // personal score — `averageScore`/`advancedScores` capitalize theirs.
      /(?<![A-Za-z$])score(?!Raw|Format|Distribution|\(format:POINT_10_DECIMAL\))/,
      `a personal score must never be selected unformatted:\n${query}`,
    );
  }
});

test("getUserList's compact format flattens the grouped response into unique TSV rows", async (t) => {
  // Fixture mirrors a real MediaListCollection compact response (verified live
  // against a public list): AniList repeats the SAME entry once per group it
  // belongs to, so an entry filed under a custom list arrives twice — 325 rows
  // for 324 unique entries on the list this was taken from.
  const entry = (id: number, status: string, score: number, progress: number, title: string) => ({
    id,
    status,
    score,
    progress,
    media: { id: id * 10, idMal: id * 100, title: { romaji: title, english: null } },
  });
  const duplicated = entry(3, "COMPLETED", 9, 12, "Filed under a custom list");
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        MediaListCollection: {
          hasNextChunk: false,
          lists: [
            {
              entries: [
                entry(1, "CURRENT", 8.5, 4, "A title"),
                // Whitespace that would otherwise break the TSV apart.
                entry(2, "PLANNING", 0, 0, "Tabbed\tand\nbroken   title"),
                duplicated,
              ],
            },
            { entries: [duplicated] },
            { entries: null },
          ],
        },
      },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig(), silentLogger());

  const result = await list.getUserList(client.ctx(), "ANIME", "someone");
  assert.equal(result.format, "compact");
  if (result.format !== "compact") return;

  assert.equal(result.columns, "entryId\tmediaId\tidMal\tstatus\tscore\tprogress\ttitle");
  assert.equal(result.count, 3, "the entry repeated across two groups must be counted once");
  const rows = result.rows.split("\n");
  assert.equal(rows.length, 3);
  assert.equal(rows[0], "1\t10\t100\tCURRENT\t8.5\t4\tA title");
  assert.equal(
    rows[1],
    "2\t20\t200\tPLANNING\t0\t0\tTabbed and broken title",
    "a title's own whitespace must never introduce extra columns or rows",
  );
  for (const row of rows) assert.equal(row.split("\t").length, 7);
});

test("getUserList requests only the fields its format needs, and filters by status server-side", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { MediaListCollection: { hasNextChunk: false, lists: [] } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig(), silentLogger());

  await list.getUserList(client.ctx(), "ANIME", "someone", { statuses: ["CURRENT"] });
  await list.getUserList(client.ctx(), "ANIME", "someone", { format: "full" });

  const sent = mock.calls.map(
    (call) => JSON.parse(call.init?.body as string) as { query: string; variables: object },
  );
  assert.equal(sent.length, 2);
  const [compact, full] = sent as [(typeof sent)[number], (typeof sent)[number]];
  // Compact must not pay for the heavy per-entry fields upstream — trimming
  // the response after the fact would still cost the bandwidth and the
  // upstream work.
  for (const field of ["notes", "advancedScores", "customLists", "createdAt", "priority"]) {
    assert.doesNotMatch(
      compact.query,
      new RegExp(field),
      `compact must not select ${field}:\n${compact.query}`,
    );
    assert.match(full.query, new RegExp(field), `full must still select ${field}`);
  }
  assert.deepEqual(
    (compact.variables as { statusIn?: string[] }).statusIn,
    ["CURRENT"],
    "statuses must reach AniList as status_in, not be filtered client-side",
  );
  assert.equal(
    "statusIn" in full.variables,
    false,
    "an absent status filter must be omitted from the request, not sent as null",
  );
});

/** The advanced-scores pre-read is ONE query carrying both `Viewer` and the
 *  media-type lookup as sibling root fields, so its fixture is one response
 *  with both keys — mirroring that combined selection. `typeField` is the
 *  `Media`/`MediaList` half exactly as AniList shapes it for that path. */
function advancedScoringPreRead(
  lists: { animeList: object; mangaList: object },
  typeField: Record<string, unknown>,
) {
  return jsonResponse({ data: { Viewer: { mediaListOptions: lists }, ...typeField } });
}

const isMutation = (init: RequestInit | undefined) =>
  /^\s*mutation\b/.test((JSON.parse(init?.body as string) as { query: string }).query);

test("saveListEntry resolves advancedScores against the account's own configured category order for the entry's actual media type", async (t) => {
  const mock = mockFetch((_url, init) => {
    if (isMutation(init)) return jsonResponse({ data: { SaveMediaListEntry: { id: 9 } } });
    return advancedScoringPreRead(
      {
        // Deliberately overlapping: both lists contain Story/Characters,
        // so a subset-guess (the old, buggy behavior) would also pass
        // for manga — only resolving the real media type gets this right.
        animeList: { advancedScoring: ["Story", "Characters"], advancedScoringEnabled: true },
        mangaList: { advancedScoring: ["Characters", "Story"], advancedScoringEnabled: true },
      },
      { Media: { type: "MANGA" } },
    );
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  // Keys given out of order — must land in the MANGA list's [Characters, Story]
  // order (not the anime list's [Story, Characters]), proving the real media
  // type (not a key-subset guess) decided which list was used.
  await list.saveListEntry(client.ctx(), {
    mediaId: id<MediaId>(42),
    advancedScores: { Story: 8, Characters: 9 },
  });
  const saveCall = mock.calls.find((c) => isMutation(c.init))!;
  const variables = JSON.parse(saveCall.init?.body as string).variables as Record<string, unknown>;
  assert.deepEqual(
    variables.advancedScores,
    [90, 80],
    "must be ordered per the MANGA list [Characters, Story], raw 0-100",
  );
});

test("saveListEntry fetches the advanced-scoring categories and the media type in ONE pre-read", async (t) => {
  const mock = mockFetch((_url, init) => {
    if (isMutation(init)) return jsonResponse({ data: { SaveMediaListEntry: { id: 9 } } });
    return advancedScoringPreRead(
      {
        animeList: { advancedScoring: ["Story"], advancedScoringEnabled: true },
        mangaList: { advancedScoring: [], advancedScoringEnabled: false },
      },
      { Media: { type: "ANIME" } },
    );
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await list.saveListEntry(client.ctx(), {
    mediaId: id<MediaId>(42),
    advancedScores: { Story: 8 },
  });
  assert.equal(mock.calls.length, 2, "one combined pre-read + the mutation, not three requests");
  const [preRead, save] = mock.calls.map(
    (c) => JSON.parse(c.init?.body as string) as { query: string; variables: object },
  ) as [{ query: string; variables: object }, { query: string; variables: object }];
  assert.match(preRead.query, /Viewer\{mediaListOptions/);
  assert.match(preRead.query, /Media\(id:\$id\)\{type\}/);
  assert.deepEqual(preRead.variables, { id: 42 });
  assert.match(save.query, /^\s*mutation\b/);
});

test("saveListEntry surfaces an unknown mediaId in the advanced-scores pre-read as not_found", async (t) => {
  // Confirmed live: an unknown Media(id) fails the WHOLE response with HTTP
  // 404, nulling its sibling root fields too — so `Viewer` is null here.
  const mock = mockFetch(() =>
    jsonResponse(
      { errors: [{ message: "Not Found.", status: 404 }], data: { Viewer: null, Media: null } },
      { status: 404 },
    ),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await assert.rejects(
    () =>
      list.saveListEntry(client.ctx(), {
        mediaId: id<MediaId>(999999999),
        advancedScores: { Story: 8 },
      }),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
  assert.equal(mock.calls.length, 1, "must never reach the mutation");
});

test("saveListEntry rejects advancedScores when advancedScoringEnabled is false, even if a category list is still configured", async (t) => {
  // Confirmed live: disabling advanced scoring on the site does NOT clear a
  // previously-configured category list, so a non-empty `advancedScoring`
  // array is not itself proof the feature is enabled — the flag must be
  // checked explicitly.
  const mock = mockFetch(() =>
    advancedScoringPreRead(
      {
        animeList: {
          advancedScoring: ["Story", "Characters", "Visuals", "Audio", "Enjoyment"],
          advancedScoringEnabled: false,
        },
        mangaList: { advancedScoring: [], advancedScoringEnabled: false },
      },
      { Media: { type: "ANIME" } },
    ),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await assert.rejects(
    () =>
      list.saveListEntry(client.ctx(), { mediaId: id<MediaId>(42), advancedScores: { Story: 8 } }),
    (err: unknown) =>
      err instanceof ApiError &&
      err.code === "bad_request" &&
      /advanced scoring isn't enabled for anime/i.test(err.message),
  );
});

test("saveListEntry rejects advancedScores keys that don't match the entry's actual media type's configured category", async (t) => {
  const mock = mockFetch(() =>
    advancedScoringPreRead(
      {
        animeList: { advancedScoring: ["Story"], advancedScoringEnabled: true },
        mangaList: { advancedScoring: ["Typo"], advancedScoringEnabled: true },
      },
      { Media: { type: "ANIME" } },
    ),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  // "Typo" matches the MANGA list, but this entry resolves to ANIME — must
  // reject rather than silently accepting it against the wrong list. Must be
  // a classified ApiError (bad_request), not a bare Error, so guard() can
  // surface the specific message instead of a generic "Unexpected error".
  await assert.rejects(
    () =>
      list.saveListEntry(client.ctx(), { mediaId: id<MediaId>(42), advancedScores: { Typo: 5 } }),
    (err: unknown) =>
      err instanceof ApiError &&
      err.code === "bad_request" &&
      /don't match this account's configured advanced scoring categories for anime/.test(
        err.message,
      ),
  );
});

test("saveListEntry resolves media type from listEntryId (update path) when no mediaId is given", async (t) => {
  const mock = mockFetch((_url, init) => {
    if (isMutation(init)) return jsonResponse({ data: { SaveMediaListEntry: { id: 9 } } });
    return advancedScoringPreRead(
      {
        animeList: { advancedScoring: [], advancedScoringEnabled: false },
        mangaList: { advancedScoring: ["Art", "Story"], advancedScoringEnabled: true },
      },
      { MediaList: { media: { type: "MANGA" } } },
    );
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await list.saveListEntry(client.ctx(), {
    listEntryId: id<ListEntryId>(99),
    advancedScores: { Story: 7, Art: 6 },
  });
  const preRead = JSON.parse(mock.calls[0]!.init?.body as string) as {
    query: string;
    variables: object;
  };
  assert.match(preRead.query, /MediaList\(id:\$id\)\{media\{type\}\}/);
  assert.doesNotMatch(preRead.query, /[^t]Media\(id/, "the update path must not look up Media");
  assert.deepEqual(preRead.variables, { id: 99 });
  const saveCall = mock.calls.find((c) => isMutation(c.init))!;
  const variables = JSON.parse(saveCall.init?.body as string).variables as Record<string, unknown>;
  assert.deepEqual(variables.advancedScores, [60, 70], "ordered per the MANGA list [Art, Story]");
});

test("saveListEntry throws (rather than silently defaulting to ANIME) when the media type can't be resolved", async (t) => {
  // Defensive path, not observed live: AniList 404s an unknown Media(id)
  // (see the not_found test above) rather than returning a 200 with
  // `Media: null`. This guards against that changing upstream.
  const mock = mockFetch(() =>
    advancedScoringPreRead(
      {
        animeList: { advancedScoring: ["Story"] },
        mangaList: { advancedScoring: ["Story"] },
      },
      { Media: null },
    ),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  // Must be a classified ApiError (bad_request), not a bare Error — see the
  // "Typo" test above for why.
  await assert.rejects(
    () =>
      list.saveListEntry(client.ctx(), {
        mediaId: id<MediaId>(999999),
        advancedScores: { Story: 8 },
      }),
    (err: unknown) =>
      err instanceof ApiError &&
      err.code === "bad_request" &&
      /Could not determine whether this entry is anime or manga/.test(err.message),
  );
});

test("toggleFavourite uses the correct AniList argument name and selects only that kind's connection", async (t) => {
  const expected = {
    ANIME: ["animeId", "anime"],
    MANGA: ["mangaId", "manga"],
    CHARACTER: ["characterId", "characters"],
    STAFF: ["staffId", "staff"],
    STUDIO: ["studioId", "studios"],
  } as const;
  const connections = ["anime", "manga", "characters", "staff", "studios"];
  for (const [kind, [argName, connection]] of Object.entries(expected)) {
    await t.test(kind, async (st) => {
      const mock = mockFetch(() =>
        jsonResponse({ data: { ToggleFavourite: { [connection]: { nodes: [{ id: 7 }] } } } }),
      );
      installFetch(st, mock);
      const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

      const result = await favourites.toggleFavourite(
        client.ctx(),
        kind as keyof typeof expected,
        7,
      );
      const query = JSON.parse(mock.calls[0]!.init?.body as string).query as string;
      assert.match(query, new RegExp(`ToggleFavourite\\(${argName}:\\$id\\)`));
      const selected = connections.filter((c) => new RegExp(`[{}]${c}\\{nodes`).test(query));
      assert.deepEqual(selected, [connection], `only ${connection} may be selected:\n${query}`);
      assert.deepEqual(result, { [connection]: { nodes: [{ id: 7 }] } });
    });
  }
});

test("getUserList forwards sort as MediaListCollection's own [MediaListSort] argument", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { MediaListCollection: { hasNextChunk: false, lists: [] } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig(), silentLogger());

  await list.getUserList(client.ctx(), "ANIME", "someone", {
    sort: ["SCORE_DESC", "UPDATED_TIME_DESC"],
  });
  await list.getUserList(client.ctx(), "ANIME", "someone");

  const [sorted, unsorted] = mock.calls.map(
    (call) => JSON.parse(call.init?.body as string) as { query: string; variables: object },
  ) as [{ query: string; variables: object }, { query: string; variables: object }];
  assert.match(sorted.query, /\$sort:\[MediaListSort\]/);
  assert.match(sorted.query, /MediaListCollection\([^)]*sort:\$sort/);
  assert.deepEqual(
    (sorted.variables as { sort?: string[] }).sort,
    ["SCORE_DESC", "UPDATED_TIME_DESC"],
    "sort keys must reach AniList in the caller's order (later keys break ties)",
  );
  assert.equal("sort" in unsorted.variables, false, "an absent sort must not be sent as null");
});

test("getUserList compact keeps AniList's sorted order and still dedupes a sorted entry repeated in a custom list", async (t) => {
  // Shape as AniList returns it with `sort` set (confirmed live): every group
  // is sorted by the key, and an entry filed under a custom list repeats
  // there. Compact selects no group metadata, so groups carry only entries.
  const entry = (entryId: number, status: string, score: number) => ({
    id: entryId,
    status,
    score,
    progress: 0,
    media: { id: entryId * 10, idMal: null, title: { romaji: `T${entryId}`, english: null } },
  });
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        MediaListCollection: {
          hasNextChunk: false,
          lists: [
            { entries: [entry(3, "COMPLETED", 9), entry(1, "COMPLETED", 7)] },
            { entries: [entry(3, "COMPLETED", 9)] },
            { entries: [entry(2, "CURRENT", 8)] },
          ],
        },
      },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig(), silentLogger());

  const result = await list.getUserList(client.ctx(), "ANIME", "someone", {
    sort: ["SCORE_DESC"],
  });
  assert.equal(result.format, "compact");
  if (result.format !== "compact") return;
  assert.equal(result.count, 3);
  assert.deepEqual(
    result.rows.split("\n").map((row) => row.split("\t")[0]),
    ["3", "1", "2"],
    "rows keep AniList's per-group order, first occurrence wins",
  );
});

test("getUserActivity forwards type and the createdAfter/createdBefore window as AniList's own filters", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        exists: { id: 7640432 },
        feed: { pageInfo: { hasNextPage: false }, activities: [] },
      },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await activity.getUserActivity(client.ctx(), id<UserId>(7640432), 1, 10, {
    type: "ANIME_LIST",
    createdAfter: "2026-01-01T00:00:00.500Z",
    createdBefore: "2026-01-02T03:00:00.250+03:00",
  });
  await activity.getUserActivity(client.ctx(), id<UserId>(7640432));
  const [filtered, unfiltered] = mock.calls.map(
    (c) =>
      JSON.parse(c.init?.body as string) as { query: string; variables: Record<string, unknown> },
  ) as [
    { query: string; variables: Record<string, unknown> },
    { query: string; variables: Record<string, unknown> },
  ];
  assert.match(
    filtered.query,
    /activities\(userId:\$userId,type:\$type,type_in:\$typeIn,createdAt_greater:\$createdAtGreater,createdAt_lesser:\$createdAtLesser/,
  );
  assert.equal(filtered.variables.type, "ANIME_LIST");
  // Both bounds are strict upstream, so the sub-second part rounds outward:
  // 2026-01-01T00:00:00.5Z -> floor 1767225600; 2026-01-02T00:00:00.25Z
  // (the +03:00 offset applied) -> ceil 1767312001.
  assert.equal(filtered.variables.createdAtGreater, 1767225600);
  assert.equal(filtered.variables.createdAtLesser, 1767312001);
  for (const key of ["type", "createdAtGreater", "createdAtLesser"]) {
    assert.equal(key in unfiltered.variables, false, `absent ${key} must not be sent as null`);
  }
});

test("getUserActivity applies the same filters on the username path", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("User(name")) return jsonResponse({ data: { User: { id: 42 } } });
    return jsonResponse({ data: { Page: { pageInfo: { hasNextPage: false }, activities: [] } } });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await activity.getUserActivity(client.ctx(), "Grinv", 1, 10, {
    type: "TEXT",
    createdAfter: "2026-01-01T00:00:00Z",
  });
  const activitiesCall = mock.calls.find(
    (c) => !JSON.parse(c.init?.body as string).query.includes("User(name"),
  )!;
  const { query, variables } = JSON.parse(activitiesCall.init?.body as string) as {
    query: string;
    variables: Record<string, unknown>;
  };
  assert.match(query, /type:\$type,type_in:\$typeIn,createdAt_greater:\$createdAtGreater/);
  assert.deepEqual(variables, {
    userId: 42,
    page: 1,
    perPage: 10,
    type: "TEXT",
    createdAtGreater: 1767225600,
  });
});

test("getUserActivity aliases a numeric id's existence check into the same request as activities(userId:...)", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { exists: { id: 7640432 }, feed: { activities: [] } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await activity.getUserActivity(client.ctx(), id<UserId>(7640432));
  assert.equal(mock.calls.length, 1, "the existence check and activities query are one request");
  const { query, variables } = JSON.parse(mock.calls[0]!.init?.body as string) as {
    query: string;
    variables: Record<string, unknown>;
  };
  assert.match(query, /exists:User\(id:\$userId\)/);
  assert.match(query, /activities\(userId:\$userId/);
  assert.ok(!query.includes("userName"), "AniList's activities field has no userName argument");
  assert.equal(variables.userId, 7640432);
});

test("getUserActivity resolves a username to an id first, since activities() has no userName argument", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("User(name")) return jsonResponse({ data: { User: { id: 42 } } });
    return jsonResponse({ data: { Page: { activities: [] } } });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await activity.getUserActivity(client.ctx(), "Grinv");
  const activitiesCall = mock.calls.find(
    (c) => !JSON.parse(c.init?.body as string).query.includes("User(name"),
  )!;
  const variables = JSON.parse(activitiesCall.init?.body as string).variables as Record<
    string,
    unknown
  >;
  assert.equal(variables.userId, 42, "must query activities with the resolved numeric id");
});

test("getUserActivity rejects with not_found when the username doesn't resolve to any user, instead of silently returning the global feed", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("User(name")) return jsonResponse({ data: { User: null } });
    return jsonResponse({ data: { Page: { activities: [{ id: 1 }] } } });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await assert.rejects(
    () => activity.getUserActivity(client.ctx(), "no-such-user"),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
  // Must fail before ever reaching the activities() query.
  assert.equal(
    mock.calls.length,
    1,
    "must not query the global activity feed after an unresolved username",
  );
});

test("getUserActivity rejects with not_found when a numeric user id doesn't resolve to any user, instead of silently returning an empty page", async (t) => {
  // Confirmed live: AniList 404s the *entire* HTTP response (not just the
  // aliased `exists` field) when User(id) doesn't resolve, even combined
  // with other root fields in the same request — see docs/api-references.md.
  const mock = mockFetch(() =>
    jsonResponse(
      { errors: [{ message: "Not Found.", status: 404 }], data: { exists: null, feed: null } },
      { status: 404 },
    ),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await assert.rejects(
    () => activity.getUserActivity(client.ctx(), id<UserId>(999999999)),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
  assert.equal(mock.calls.length, 1, "the not-found check costs no extra request");
});

test("searchActivity aliases a numeric id's existence check into the same request as activities(userId:...)", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        exists: { id: 7640432 },
        feed: { pageInfo: { hasNextPage: false }, activities: [{ id: 1 }] },
      },
    }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  const result = (await search.searchActivity(client.ctx(), id<UserId>(7640432))) as {
    activities: unknown[];
  };
  assert.equal(mock.calls.length, 1, "the existence check and activities query are one request");
  const query = JSON.parse(mock.calls[0]!.init?.body as string).query as string;
  assert.match(query, /exists:User\(id:\$userId\)/);
  assert.ok(result.activities, "must return the feed, not the raw {exists,feed} envelope");
});

test("searchActivity rejects with not_found when a numeric user id doesn't resolve to any user, instead of silently returning an empty page", async (t) => {
  // Confirmed live: AniList 404s the *entire* HTTP response (not just the
  // aliased `exists` field) when User(id) doesn't resolve, even combined
  // with other root fields in the same request — see docs/api-references.md.
  const mock = mockFetch(() =>
    jsonResponse(
      { errors: [{ message: "Not Found.", status: 404 }], data: { exists: null, feed: null } },
      { status: 404 },
    ),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await assert.rejects(
    () => search.searchActivity(client.ctx(), id<UserId>(999999999)),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
  assert.equal(mock.calls.length, 1, "the not-found check costs no extra request");
});

test("searchActivity resolves a username to an id first, since activities() has no userName argument", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("User(name")) return jsonResponse({ data: { User: { id: 42 } } });
    return jsonResponse({ data: { Page: { activities: [] } } });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await search.searchActivity(client.ctx(), "Grinv");
  const activitiesCall = mock.calls.find(
    (c) => !JSON.parse(c.init?.body as string).query.includes("User(name"),
  )!;
  const variables = JSON.parse(activitiesCall.init?.body as string).variables as Record<
    string,
    unknown
  >;
  assert.equal(variables.userId, 42, "must query activities with the resolved numeric id");
});

test("searchActivity rejects with not_found when the username doesn't resolve to any user, instead of silently returning the global feed", async (t) => {
  // Regression test: passing the wrong-but-plausible field name (`user`
  // instead of `userId`) used to be silently dropped by the tool's own
  // non-strict Zod object, making the tool fall back to no filter at all —
  // this only guards the client function's own username-resolution path,
  // not the tool schema, but confirms the underlying data-dependency is
  // enforced now that the tool accepts `user` (via userIdOrName) directly.
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("User(name")) return jsonResponse({ data: { User: null } });
    return jsonResponse({ data: { Page: { activities: [{ id: 1 }] } } });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await assert.rejects(
    () => search.searchActivity(client.ctx(), "no-such-user"),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
  assert.equal(
    mock.calls.length,
    1,
    "must not query the global activity feed after an unresolved username",
  );
});

test("deleteListEntry rejects when AniList reports deleted: false instead of reporting a false success", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { DeleteMediaListEntry: { deleted: false } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());
  await assert.rejects(
    () => list.deleteListEntry(client.ctx(), id<ListEntryId>(1)),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
});

test("deleteActivity rejects when AniList reports deleted: false instead of reporting a false success", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { DeleteActivity: { deleted: false } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());
  await assert.rejects(
    () => activity.deleteActivity(client.ctx(), id<ActivityId>(1)),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
});

test("deleteThread rejects when AniList reports deleted: false instead of reporting a false success", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { DeleteThread: { deleted: false } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());
  await assert.rejects(
    () => thread.deleteThread(client.ctx(), id<ThreadId>(1)),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
});

test("isConfigured/canLogin reflect the configured credentials", () => {
  assert.equal(new AniListClient(testConfig({}), silentLogger()).isConfigured(), false);
  assert.equal(
    new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger()).isConfigured(),
    true,
  );
  assert.equal(new AniListClient(testConfig({}), silentLogger()).canLogin(), false);
  assert.equal(
    new AniListClient(
      testConfig({ ANILIST_CLIENT_ID: "id", ANILIST_CLIENT_SECRET: "secret" }),
      silentLogger(),
    ).canLogin(),
    true,
  );
});

test("startLogin refuses when no client id/secret is configured", async () => {
  const client = new AniListClient(testConfig({}), silentLogger());
  await assert.rejects(
    () => client.startLogin(),
    (err: unknown) => err instanceof ApiError && err.code === "bad_request",
  );
});

test("submitRedirect exchanges the code for a token and persists it (no client_secret leak)", async (t) => {
  const storePath = tempStorePath("login");
  rmSync(storePath, { force: true });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

  const mock = mockFetch((url, init) => {
    assert.match(url, /\/token$/);
    const body = JSON.parse(init?.body as string) as Record<string, string>;
    assert.equal(body.grant_type, "authorization_code");
    assert.equal(body.client_id, "id");
    assert.equal(body.client_secret, "secret");
    assert.equal(body.code, "AUTHCODE");
    return jsonResponse({ access_token: jwt });
  });
  installFetch(t, mock);

  try {
    const client = new AniListClient(
      testConfig({
        ANILIST_CLIENT_ID: "id",
        ANILIST_CLIENT_SECRET: "secret",
        ANILIST_TOKEN_STORE: storePath,
      }),
      silentLogger(),
    );
    assert.equal(client.isConfigured(), false);
    await client.submitRedirect("http://localhost:8082/callback?code=AUTHCODE");
    assert.equal(client.isConfigured(), true);

    const persisted = JSON.parse(readFileSync(storePath, "utf8")) as TokenState;
    assert.equal(persisted.accessToken, jwt);
    assert.equal(persisted.expiresAt, exp * 1000);
  } finally {
    rmSync(storePath, { force: true });
  }
});

test("submitRedirect rejects a state that doesn't match the login attempt that started it", async (t) => {
  const mock = mockFetch(() => jsonResponse({ access_token: "unused" }));
  installFetch(t, mock);
  const client = new AniListClient(
    testConfig({
      ANILIST_CLIENT_ID: "id",
      ANILIST_CLIENT_SECRET: "secret",
      ANILIST_OAUTH_PORT: "41825",
    }),
    silentLogger(),
  );
  const { authorizeUrl, listening } = await client.startLogin({ open: () => {} });
  assert.ok(listening, "expected to bind the test port");
  const state = new URL(authorizeUrl).searchParams.get("state");
  assert.ok(state, "startLogin must generate a state");

  // The submitRedirect→finally cleanup (added alongside this check) closes
  // the localhost listener startLogin() opened, even though this rejects.
  await assert.rejects(
    () => client.submitRedirect(`http://localhost:41825/callback?code=X&state=wrong-${state}`),
    (err: unknown) =>
      err instanceof ApiError && err.code === "unauthorized" && /state mismatch/i.test(err.message),
  );
});

test("submitRedirect with a bare code after login_anilist asks for the full URL", async (t) => {
  const mock = mockFetch(() => jsonResponse({ access_token: "unused" }));
  installFetch(t, mock);
  const client = new AniListClient(
    testConfig({
      ANILIST_CLIENT_ID: "id",
      ANILIST_CLIENT_SECRET: "secret",
      ANILIST_OAUTH_PORT: "41827",
    }),
    silentLogger(),
  );
  await client.startLogin({ open: () => {} });
  await assert.rejects(
    () => client.submitRedirect("BARECODE"),
    (err: unknown) =>
      err instanceof ApiError &&
      err.code === "bad_request" &&
      /full redirected URL/.test(err.message),
  );
  assert.equal(mock.calls.length, 0, "no token exchange for an unverifiable code");
});

test("read queries attach the Authorization header when a token is configured, and omit it otherwise", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { Media: { id: 1 } } }));
  installFetch(t, mock);

  const anon = new AniListClient(testConfig({}), silentLogger());
  await media.getMedia(anon.ctx(), "ANIME", id<MediaId>(1));
  assert.equal(
    (mock.calls[0]!.init?.headers as Record<string, string> | undefined)?.Authorization,
    undefined,
  );

  const authed = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());
  await media.getMedia(authed.ctx(), "ANIME", id<MediaId>(1));
  assert.equal(
    (mock.calls[1]!.init?.headers as Record<string, string>).Authorization,
    "Bearer tok",
  );
});

test("query (not mutation) responses are cached, so a repeated read doesn't re-hit the network", async (t) => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls += 1;
    return jsonResponse({ data: { GenreCollection: ["Action"] } });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ CACHE_TTL_MS: "300000" }), silentLogger());

  const first = await misc.getGenres(client.ctx());
  const second = await misc.getGenres(client.ctx());
  assert.deepEqual(first, ["Action"]);
  assert.deepEqual(second, ["Action"]);
  assert.equal(calls, 1, "the second call must be served from cache, not the network");
});

test("a failed token exchange surfaces an actionable, classified ApiError (routed through the shared HttpClient)", async (t) => {
  const mock = mockFetch(() => jsonResponse({ error: "invalid_grant" }, { status: 400 }));
  installFetch(t, mock);
  const client = new AniListClient(
    testConfig({ ANILIST_CLIENT_ID: "id", ANILIST_CLIENT_SECRET: "secret" }),
    silentLogger(),
  );
  await assert.rejects(
    () => client.submitRedirect("http://localhost:8082/callback?code=BADCODE"),
    (err: unknown) =>
      err instanceof ApiError &&
      err.code === "bad_request" &&
      /run login_anilist again/.test(err.message),
  );
  // A 400 on the token endpoint must not be retried — the code is single-use,
  // so replaying it would only ever fail again.
  assert.equal(mock.calls.length, 1, "the token exchange must not be retried");
});

test("a failed token exchange leaves the pending state intact, so a later mismatched retry is still rejected", async (t) => {
  const mock = mockFetch(() => jsonResponse({ error: "invalid_grant" }, { status: 400 }));
  installFetch(t, mock);
  const client = new AniListClient(
    testConfig({
      ANILIST_CLIENT_ID: "id",
      ANILIST_CLIENT_SECRET: "secret",
      ANILIST_OAUTH_PORT: "41826",
    }),
    silentLogger(),
  );
  const { authorizeUrl } = await client.startLogin({ open: () => {} });
  const state = new URL(authorizeUrl).searchParams.get("state")!;

  // First attempt: correct state, but the exchange itself fails.
  await assert.rejects(() =>
    client.submitRedirect(`http://localhost:41826/callback?code=X&state=${state}`),
  );

  // Regression: if #pendingState were cleared unconditionally after the state
  // check (instead of only after a successful exchange), this second call
  // with a WRONG state would now skip the check entirely and reach the
  // (still-failing) exchange instead of being rejected for the state mismatch.
  await assert.rejects(
    () => client.submitRedirect(`http://localhost:41826/callback?code=X&state=wrong-${state}`),
    (err: unknown) => err instanceof ApiError && /state mismatch/i.test(err.message),
  );
});

test("getNotifications requires auth — the Notification query has no userId arg", async (t) => {
  const mock = mockFetch(() => {
    throw new Error("must not be called — requireAuth() should throw before any fetch");
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await assert.rejects(
    () => notification.getNotifications(client.ctx(), {}),
    (err: unknown) => err instanceof ApiError && err.code === "unauthorized",
  );
  assert.equal(mock.calls.length, 0);
});

test("getNotifications sends type_in/resetNotificationCount/pagination as variables", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { Page: { pageInfo: {}, notifications: [{ id: 1, type: "AIRING" }] } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  const result = await notification.getNotifications(client.ctx(), {
    typeIn: ["AIRING", "FOLLOWING"],
    resetNotificationCount: true,
    page: 2,
    perPage: 5,
  });

  const body = JSON.parse(mock.calls[0]!.init?.body as string) as {
    query: string;
    variables: Record<string, unknown>;
  };
  assert.deepEqual(body.variables, {
    page: 2,
    perPage: 5,
    type_in: ["AIRING", "FOLLOWING"],
    resetNotificationCount: true,
  });
  assert.match(body.query, /\.\.\. on AiringNotification/);
  assert.deepEqual(result, { pageInfo: {}, notifications: [{ id: 1, type: "AIRING" }] });
});

test("getNotifications is never cached, even with a nonzero CACHE_TTL_MS — resetNotificationCount and the notification list must always be fresh", async (t) => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls += 1;
    return jsonResponse({ data: { Page: { pageInfo: {}, notifications: [{ id: calls }] } } });
  });
  installFetch(t, mock);
  const client = new AniListClient(
    testConfig({ ANILIST_ACCESS_TOKEN: "tok", CACHE_TTL_MS: "300000" }),
    silentLogger(),
  );

  const first = await notification.getNotifications(client.ctx(), { resetNotificationCount: true });
  const second = await notification.getNotifications(client.ctx(), {
    resetNotificationCount: true,
  });
  assert.equal(calls, 2, "an identical repeat call must re-hit AniList, not be served from cache");
  assert.notDeepEqual(first, second, "a cached repeat would wrongly return the first call's data");
});

test("CACHE_TTL_MS=0 disables caching (every read hits the network)", async (t) => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls += 1;
    return jsonResponse({ data: { GenreCollection: ["Action"] } });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ CACHE_TTL_MS: "0" }), silentLogger());

  await misc.getGenres(client.ctx());
  await misc.getGenres(client.ctx());
  assert.equal(calls, 2, "caching must be off when CACHE_TTL_MS is 0");
});

// A person's bio is the single largest part of these three tools' responses
// (measured live at 57-85% of the payload), so the multi-entry queries must
// leave it out unless the caller opts in — the same rule MEDIA_FIELDS already
// follows for a media synopsis. search_user's `about` follows the same rule.
test("search/birthday/user queries only request a bio when the caller opts in", async (t) => {
  const queries: string[] = [];
  const mock = mockFetch((_url, init) => {
    queries.push((JSON.parse(init?.body as string) as { query: string }).query);
    return jsonResponse({
      data: { Page: { pageInfo: { hasNextPage: false }, characters: [], staff: [], users: [] } },
    });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());
  const ctx = client.ctx();

  await search.searchCharacter(ctx, "frieren");
  await search.searchStaff(ctx, "hideaki");
  await search.searchUser(ctx, "grinv");
  await people.getTodaysBirthdays(ctx, "CHARACTER");
  await people.getTodaysBirthdays(ctx, "STAFF");
  for (const [i, query] of queries.entries()) {
    assert.ok(!query.includes("description"), `query ${i} must omit the bio by default`);
    assert.ok(!query.includes("about"), `query ${i} must omit the about field by default`);
  }

  queries.length = 0;
  await search.searchCharacter(ctx, "frieren", 1, 10, true);
  await search.searchStaff(ctx, "hideaki", 1, 10, true);
  await search.searchUser(ctx, "grinv", 1, 10, true);
  await people.getTodaysBirthdays(ctx, "CHARACTER", true);
  await people.getTodaysBirthdays(ctx, "STAFF", true);
  for (const [i, query] of queries.entries()) {
    assert.match(
      query,
      /description\(asHtml: false\)|about\(asHtml: false\)/,
      `query ${i} must include the opted-in bio`,
    );
  }
});

test("getCharacter/getStaff/getUserProfile/getFullUserInfo/getAuthorizedUser always request the bio (single-item lookups)", async (t) => {
  const queries: string[] = [];
  const mock = mockFetch((_url, init) => {
    queries.push((JSON.parse(init?.body as string) as { query: string }).query);
    return jsonResponse({
      data: {
        Character: { id: 1 },
        Staff: { id: 2 },
        User: { id: 3 },
        Viewer: { id: 4 },
      },
    });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await people.getCharacter(client.ctx(), id<CharacterId>(1));
  await people.getStaff(client.ctx(), id<StaffId>(2));
  await user.getUserProfile(client.ctx(), id<UserId>(3));
  await user.getFullUserInfo(client.ctx(), id<UserId>(3));
  await user.getAuthorizedUser(client.ctx());
  assert.equal(queries.length, 5);
  for (const [i, query] of queries.entries()) {
    assert.match(
      query,
      /description\(asHtml: false\)|about\(asHtml: false\)/,
      `query ${i} must include the bio`,
    );
  }
});

// The mutation used to select back only id/status/score/progress/mediaId/
// hiddenFromStatusLists, so a write to priority, notes, dates, customLists or
// advancedScores could only be verified with a follow-up read.
/** The mutation's own ARGUMENT list also mentions customLists/advancedScores
 *  (`customLists:$customLists`), so a naive substring check on the whole
 *  query passes even when the selection set omits them — slice from the
 *  arguments' closing `){` to test what's actually asked back. */
function savedSelection(query: string): string {
  const afterName = query.slice(query.indexOf("SaveMediaListEntry"));
  return afterName.slice(afterName.indexOf("){") + 2);
}

test("saveListEntry asks back for the fields AniList doesn't store verbatim, but only when they were sent", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { SaveMediaListEntry: { id: 9 } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await list.saveListEntry(client.ctx(), { mediaId: id<MediaId>(42), customLists: ["Favourites"] });
  const withLists = savedSelection(JSON.parse(mock.calls[0]!.init?.body as string).query as string);
  for (const field of [
    "progressVolumes",
    "repeat",
    "priority",
    "private",
    "notes",
    "startedAt",
    "completedAt",
    "customLists(asArray: true)",
    "advancedScores",
  ]) {
    assert.ok(withLists.includes(field), `${field} must be selected back when customLists was set`);
  }

  // Nothing that AniList stores verbatim needs echoing on the common path —
  // and `notes` is up to 6000 characters the caller just supplied.
  await list.saveListEntry(client.ctx(), { mediaId: id<MediaId>(42), progress: 3 });
  const trimmed = savedSelection(JSON.parse(mock.calls[1]!.init?.body as string).query as string);
  for (const field of ["customLists", "advancedScores", "notes", "createdAt", "updatedAt"]) {
    assert.ok(
      !trimmed.includes(field),
      `${field} must not be echoed when the caller didn't set it:\n${trimmed}`,
    );
  }
  // Still enough to confirm the write, including the one field AniList fills
  // in by itself (startedAt is auto-set on a new CURRENT entry).
  for (const field of ["id", "mediaId", "status", "progress", "startedAt"]) {
    assert.ok(trimmed.includes(field), `${field} must still be echoed`);
  }
});

test("updateListEntries sends one bulk mutation and never customLists or advancedScores", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { UpdateMediaListEntries: [{ id: 1 }, { id: 2 }] } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  const result = await list.updateListEntries(
    client.ctx(),
    [id<ListEntryId>(1), id<ListEntryId>(2)],
    { status: "COMPLETED", score: 8.5 },
  );
  assert.deepEqual(result, { updated: 2, listEntryIds: [1, 2] });
  assert.equal(mock.calls.length, 1, "a batch must cost exactly one request");

  const body = JSON.parse(mock.calls[0]!.init?.body as string) as {
    query: string;
    variables: Record<string, unknown>;
  };
  assert.match(body.query, /UpdateMediaListEntries/);
  // AniList's bulk mutation has no customLists argument at all, and
  // advancedScores is excluded on purpose (it zeroes omitted categories —
  // across a whole batch that is silent data loss).
  assert.doesNotMatch(body.query, /customLists|advancedScores/);
  assert.deepEqual(body.variables.ids, [1, 2]);
  // 0-10 in, AniList's raw 0-100 out — same conversion saveListEntry does.
  assert.equal(body.variables.scoreRaw, 85);
  assert.equal("score" in body.variables, false);
});

test("updateListEntries refuses a call that would write nothing", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { UpdateMediaListEntries: [] } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await assert.rejects(
    () => list.updateListEntries(client.ctx(), [id<ListEntryId>(1)], {}),
    /No values to apply/,
  );
  assert.equal(mock.calls.length, 0, "an empty update must not reach AniList at all");
});

// An empty page is a real AniList response shape for these selections
// (pageInfo plus an empty list), so it doubles as an accurate fixture for
// every variables-only assertion below.
const emptyPageInfo = { total: 0, currentPage: 1, lastPage: 1, hasNextPage: false };

test("searchMedia forwards the exclusion/length/country/licensor filters, and omits each when unset", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { Page: { pageInfo: { ...emptyPageInfo, perPage: 10 }, media: [] } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(
    testConfig({ CACHE_TTL_MS: "0", ANILIST_MIN_INTERVAL_MS: "0" }),
    silentLogger(),
  );
  const filter = {
    genre_not_in: ["Action"],
    tag_not_in: ["Isekai"],
    minimumTagRank: 90,
    format_not_in: ["MOVIE"],
    status_not_in: ["CANCELLED"],
    countryOfOrigin: "KR",
    duration_greater: 20,
    duration_lesser: 30,
    chapters_greater: 100,
    chapters_lesser: 500,
    volumes_greater: 1,
    volumes_lesser: 10,
    licensedBy_in: ["Crunchyroll"],
  };
  await search.searchMedia(client.ctx(), "MANGA", { filter });
  const body = JSON.parse(mock.calls[0]!.init?.body as string) as {
    query: string;
    variables: Record<string, unknown>;
  };
  for (const [key, value] of Object.entries(filter)) {
    assert.deepEqual(body.variables[key], value, `${key} must reach the GraphQL variables`);
    assert.match(body.query, new RegExp(`\\$${key}:`), `${key} must be declared in the query`);
    assert.match(body.query, new RegExp(`${key}:\\$${key}`), `${key} must be passed to media()`);
  }
  assert.match(body.query, /\$countryOfOrigin:CountryCode/);

  await search.searchMedia(client.ctx(), "MANGA", { filter: {} });
  const unset = JSON.parse(mock.calls[1]!.init?.body as string).variables as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(filter)) {
    assert.ok(!(key in unset), `an unset ${key} must be omitted, not sent as null`);
  }
});

test("searchThread trims the term, relevance-sorts only with a term, and sorts a term-less browse by latest reply", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { Page: { pageInfo: emptyPageInfo, threads: [] } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(
    testConfig({ CACHE_TTL_MS: "0", ANILIST_MIN_INTERVAL_MS: "0" }),
    silentLogger(),
  );
  const varsOf = (i: number) =>
    JSON.parse(mock.calls[i]!.init?.body as string).variables as Record<string, unknown>;

  await search.searchThread(client.ctx(), "  spring season  ");
  assert.equal(varsOf(0).search, "spring season", "term is trimmed before sending");
  assert.deepEqual(varsOf(0).sort, ["SEARCH_MATCH"]);

  // Term-less SEARCH_MATCH degrades to oldest-ID-first live, so browse by latest reply.
  await search.searchThread(client.ctx());
  assert.equal(varsOf(1).search, undefined);
  assert.deepEqual(varsOf(1).sort, ["REPLIED_AT_DESC"]);

  await search.searchThread(client.ctx(), "   ");
  assert.equal(varsOf(2).search, undefined, "whitespace-only term is dropped");
  assert.deepEqual(varsOf(2).sort, ["REPLIED_AT_DESC"]);
});

test("searchActivity converts createdAfter/createdBefore to unix seconds on both query paths, and omits them when unset", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("exists:User")) {
      return jsonResponse({
        data: { exists: { id: 7640432 }, feed: { pageInfo: emptyPageInfo, activities: [] } },
      });
    }
    return jsonResponse({ data: { Page: { pageInfo: emptyPageInfo, activities: [] } } });
  });
  installFetch(t, mock);
  const client = new AniListClient(
    testConfig({ CACHE_TTL_MS: "0", ANILIST_MIN_INTERVAL_MS: "0" }),
    silentLogger(),
  );
  const callOf = (i: number) =>
    JSON.parse(mock.calls[i]!.init?.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
  const created = { after: "2026-10-01T09:00:00+09:00", before: "2026-10-02T00:00:00.999Z" };

  // Global feed (no user).
  await search.searchActivity(client.ctx(), undefined, undefined, 1, 10, created);
  assert.equal(callOf(0).variables.createdAt_greater, 1790812800, "offset honored");
  assert.equal(
    callOf(0).variables.createdAt_lesser,
    1790899201,
    "sub-second part rounded outward (strict bound)",
  );
  assert.match(callOf(0).query, /createdAt_greater:\$createdAt_greater/);

  // Numeric-id path (aliased existence check).
  await search.searchActivity(client.ctx(), id<UserId>(7640432), undefined, 1, 10, created);
  assert.equal(callOf(1).variables.createdAt_greater, 1790812800);
  assert.equal(callOf(1).variables.createdAt_lesser, 1790899201);
  assert.match(callOf(1).query, /createdAt_lesser:\$createdAt_lesser/);

  await search.searchActivity(client.ctx());
  assert.ok(!("createdAt_greater" in callOf(2).variables), "unset bound is omitted");
  assert.ok(!("createdAt_lesser" in callOf(2).variables), "unset bound is omitted");
});
