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
import { silentLogger, jsonResponse, mockFetch, installFetch, testConfig } from "./helpers.js";

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

  const single = await media.getMedia(client.ctx(), "ANIME", 1);
  assert.deepEqual(single, { id: 1 });

  const many = await media.getMedia(client.ctx(), "ANIME", [1, 2]);
  assert.deepEqual(many, [{ id: 1 }, { id: 2 }]);
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

test("searchMedia sends the caller's sort, or SEARCH_MATCH when omitted", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { Page: { media: [] } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await search.searchMedia(client.ctx(), "ANIME", { filter: {} });
  let vars = JSON.parse(mock.calls[0]!.init?.body as string).variables as Record<string, unknown>;
  assert.deepEqual(vars.sort, ["SEARCH_MATCH"], "default sort when none is given");

  await search.searchMedia(client.ctx(), "ANIME", {
    sort: ["SCORE_DESC", "POPULARITY_DESC"],
    filter: {},
  });
  vars = JSON.parse(mock.calls[1]!.init?.body as string).variables as Record<string, unknown>;
  assert.deepEqual(vars.sort, ["SCORE_DESC", "POPULARITY_DESC"]);
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
    1,
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
    1,
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
    () => list.saveListEntry(client.ctx(), { mediaId: 1, status: "PLANNING" }),
    (err: unknown) => err instanceof ApiError && err.code === "unauthorized",
  );
});

test("saveListEntry sends the Bearer token and omits fields left undefined", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { SaveMediaListEntry: { id: 9, status: "PLANNING" } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());

  const result = await list.saveListEntry(client.ctx(), { mediaId: 42, status: "PLANNING" });
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

  await list.saveListEntry(client.ctx(), { mediaId: 42, score: 8.5 });
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
              animeList: { advancedScoring: ["Story", "Characters"] },
              mangaList: { advancedScoring: ["Characters", "Story"] },
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
    mediaId: 42,
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

test("saveListEntry rejects advancedScores keys that don't match the entry's actual media type's configured category", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    if (body.query.includes("Media(id"))
      return jsonResponse({ data: { Media: { type: "ANIME" } } });
    return jsonResponse({
      data: {
        Viewer: {
          mediaListOptions: {
            animeList: { advancedScoring: ["Story"] },
            mangaList: { advancedScoring: ["Typo"] },
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
    () => list.saveListEntry(client.ctx(), { mediaId: 42, advancedScores: { Typo: 5 } }),
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
              animeList: { advancedScoring: [] },
              mangaList: { advancedScoring: ["Art", "Story"] },
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

  await list.saveListEntry(client.ctx(), { listEntryId: 99, advancedScores: { Story: 7, Art: 6 } });
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
    () => list.saveListEntry(client.ctx(), { mediaId: 999999, advancedScores: { Story: 8 } }),
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

test("getUserActivity queries activities(userId:...) directly for a numeric id", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { Page: { activities: [] } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({}), silentLogger());

  await activity.getUserActivity(client.ctx(), 7640432);
  assert.equal(mock.calls.length, 1, "a numeric id needs no resolution query");
  const { query, variables } = JSON.parse(mock.calls[0]!.init?.body as string) as {
    query: string;
    variables: Record<string, unknown>;
  };
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

test("deleteListEntry rejects when AniList reports deleted: false instead of reporting a false success", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({ data: { DeleteMediaListEntry: { deleted: false } } }),
  );
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());
  await assert.rejects(
    () => list.deleteListEntry(client.ctx(), 1),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
});

test("deleteActivity rejects when AniList reports deleted: false instead of reporting a false success", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { DeleteActivity: { deleted: false } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());
  await assert.rejects(
    () => activity.deleteActivity(client.ctx(), 1),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
});

test("deleteThread rejects when AniList reports deleted: false instead of reporting a false success", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: { DeleteThread: { deleted: false } } }));
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());
  await assert.rejects(
    () => thread.deleteThread(client.ctx(), 1),
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
  await media.getMedia(anon.ctx(), "ANIME", 1);
  assert.equal(
    (mock.calls[0]!.init?.headers as Record<string, string> | undefined)?.Authorization,
    undefined,
  );

  const authed = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());
  await media.getMedia(authed.ctx(), "ANIME", 1);
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
