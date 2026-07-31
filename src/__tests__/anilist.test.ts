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
import { ApiError } from "../lib/errors.js";
import type { TokenState } from "../lib/tokenStore.js";
import type { MediaId, ListEntryId, ThreadId, ActivityId, UserId } from "../clients/anilist/ids.js";
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

test("saveListEntry resolves advancedScores against the account's own configured category order for the entry's actual media type", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("mediaListOptions")) {
      return jsonResponse({
        data: {
          Viewer: {
            mediaListOptions: {
              // Deliberately overlapping: both lists contain Story/Characters,
              // so a subset-guess (the old, buggy behavior) would also pass
              // for manga — only resolving the real media type gets this right.
              animeList: { advancedScoring: ["Story", "Characters"], advancedScoringEnabled: true },
              mangaList: { advancedScoring: ["Characters", "Story"], advancedScoringEnabled: true },
            },
          },
        },
      });
    }
    if (body.query.includes("Media(id"))
      return jsonResponse({ data: { Media: { type: "MANGA" } } });
    return jsonResponse({ data: { SaveMediaListEntry: { id: 9 } } });
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
  const saveCall = mock.calls.find((c) => {
    const q = JSON.parse(c.init?.body as string).query as string;
    return !q.includes("mediaListOptions") && !q.includes("Media(id");
  })!;
  const variables = JSON.parse(saveCall.init?.body as string).variables as Record<string, unknown>;
  assert.deepEqual(
    variables.advancedScores,
    [90, 80],
    "must be ordered per the MANGA list [Characters, Story], raw 0-100",
  );
});

test("saveListEntry rejects advancedScores when advancedScoringEnabled is false, even if a category list is still configured", async (t) => {
  // Confirmed live: disabling advanced scoring on the site does NOT clear a
  // previously-configured category list, so a non-empty `advancedScoring`
  // array is not itself proof the feature is enabled — the flag must be
  // checked explicitly.
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("Media(id"))
      return jsonResponse({ data: { Media: { type: "ANIME" } } });
    return jsonResponse({
      data: {
        Viewer: {
          mediaListOptions: {
            animeList: {
              advancedScoring: ["Story", "Characters", "Visuals", "Audio", "Enjoyment"],
              advancedScoringEnabled: false,
            },
            mangaList: { advancedScoring: [], advancedScoringEnabled: false },
          },
        },
      },
    });
  });
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
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("Media(id"))
      return jsonResponse({ data: { Media: { type: "ANIME" } } });
    return jsonResponse({
      data: {
        Viewer: {
          mediaListOptions: {
            animeList: { advancedScoring: ["Story"], advancedScoringEnabled: true },
            mangaList: { advancedScoring: ["Typo"], advancedScoringEnabled: true },
          },
        },
      },
    });
  });
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
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("mediaListOptions")) {
      return jsonResponse({
        data: {
          Viewer: {
            mediaListOptions: {
              animeList: { advancedScoring: [], advancedScoringEnabled: false },
              mangaList: { advancedScoring: ["Art", "Story"], advancedScoringEnabled: true },
            },
          },
        },
      });
    }
    if (body.query.includes("MediaList(id"))
      return jsonResponse({ data: { MediaList: { media: { type: "MANGA" } } } });
    return jsonResponse({ data: { SaveMediaListEntry: { id: 9 } } });
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await list.saveListEntry(client.ctx(), {
    listEntryId: id<ListEntryId>(99),
    advancedScores: { Story: 7, Art: 6 },
  });
  const saveCall = mock.calls.find((c) => {
    const q = JSON.parse(c.init?.body as string).query as string;
    return !q.includes("mediaListOptions") && !q.includes("MediaList(id");
  })!;
  const variables = JSON.parse(saveCall.init?.body as string).variables as Record<string, unknown>;
  assert.deepEqual(variables.advancedScores, [60, 70], "ordered per the MANGA list [Art, Story]");
});

test("saveListEntry throws (rather than silently defaulting to ANIME) when the media type can't be resolved", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("mediaListOptions")) {
      return jsonResponse({
        data: {
          Viewer: {
            mediaListOptions: {
              animeList: { advancedScoring: ["Story"] },
              mangaList: { advancedScoring: ["Story"] },
            },
          },
        },
      });
    }
    // mediaId doesn't resolve to any media.
    return jsonResponse({ data: { Media: null } });
  });
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

test("toggleFavourite uses the correct AniList argument name per media kind", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { ToggleFavourite: {} } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  await favourites.toggleFavourite(client.ctx(), "STUDIO", 7);
  const query = JSON.parse(mock.calls[0]!.init?.body as string).query as string;
  assert.match(query, /studioId:\$id/);
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

test("searchActivity passes a numeric user straight through as the userId filter", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { Page: { activities: [] } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await search.searchActivity(client.ctx(), id<UserId>(7640432));
  assert.equal(mock.calls.length, 1);
  const { variables } = JSON.parse(mock.calls[0]!.init?.body as string) as {
    variables: Record<string, unknown>;
  };
  assert.equal(variables.userId, 7640432);
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
