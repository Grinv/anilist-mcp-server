// Query-shape regressions for the versioned/paginated media and people
// selections: each of these was a live bug where the query AniList received
// silently returned the wrong (or truncated) data without erroring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, mockFetch, installFetch, connectServer } from "./helpers.js";
import {
  MEDIA_FIELDS,
  MEDIA_COMPACT_FIELDS,
  USER_DETAIL_FIELDS,
} from "../clients/anilist/fields.js";

type Body = { query: string; variables: Record<string, unknown> };
const bodyOf = (init: RequestInit | undefined): Body => JSON.parse(init?.body as string) as Body;

test("media selections ask for status(version:2), so HIATUS isn't reported as RELEASING", () => {
  // Confirmed live: Hunter×Hunter's manga (30026) reads RELEASING bare,
  // HIATUS at version 2.
  for (const fields of [MEDIA_FIELDS, MEDIA_COMPACT_FIELDS]) {
    assert.match(fields, /\bstatus\(version:2\)/);
    assert.doesNotMatch(fields, /\bstatus\s*\n/, "no bare (v1) status selection left");
  }
});

test("get_media passes a v2 HIATUS status through its output schema", async (t) => {
  // Mirrors the live compact response for Media(id:30026,type:MANGA).
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Media: {
          id: 30026,
          idMal: 26,
          type: "MANGA",
          format: "MANGA",
          status: "HIATUS",
          episodes: null,
          chapters: null,
          title: { romaji: "HUNTER×HUNTER", english: "Hunter x Hunter" },
        },
      },
    }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  const res = await client.callTool({
    name: "get_media",
    arguments: { type: "MANGA", ids: 30026, format: "compact" },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  assert.equal((res.structuredContent as { media: { status: string } }).media.status, "HIATUS");
  assert.match(bodyOf(mock.calls[0]!.init).query, /status\(version:2\)/);
});

test("get_media_relations asks for relationType(version:3) and keeps the `relationType` key", async (t) => {
  // Confirmed live: AoT (16498) → its manga (53390) is ADAPTATION bare but
  // SOURCE at version 3.
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Media: {
          relations: {
            edges: [
              {
                relationType: "SOURCE",
                node: {
                  id: 53390,
                  type: "MANGA",
                  format: "MANGA",
                  title: { romaji: "Shingeki no Kyojin", english: "Attack on Titan" },
                  siteUrl: "https://anilist.co/manga/53390",
                },
              },
            ],
          },
        },
      },
    }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  const res = await client.callTool({
    name: "get_media_relations",
    arguments: { type: "ANIME", id: 16498 },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  assert.match(bodyOf(mock.calls[0]!.init).query, /relationType\(version:3\)/);
  const edges = (res.structuredContent as { relations: { edges: { relationType: string }[] } })
    .relations.edges;
  assert.equal(edges[0]!.relationType, "SOURCE");
});

test("the four nested-connection tools cap perPage at 25 (AniList clamps them there)", async (t) => {
  const mock = mockFetch(() => {
    throw new Error("must not be called — Zod should reject perPage 26 before any fetch");
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({});
  t.after(close);
  const cases: [string, Record<string, unknown>][] = [
    ["get_media_characters", { type: "ANIME", id: 1 }],
    ["get_media_staff", { type: "ANIME", id: 1 }],
    ["get_media_reviews", { type: "ANIME", id: 1 }],
    ["get_recommendations_for_media", { mediaId: 1 }],
  ];
  const { tools } = await client.listTools();
  for (const [name, args] of cases) {
    const res = await client.callTool({ name, arguments: { ...args, perPage: 26 } });
    assert.equal(res.isError, true, `${name} must reject perPage 26`);
    const perPage = (
      tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<
        string,
        { maximum?: number; description?: string }
      >
    ).perPage!;
    assert.equal(perPage.maximum, 25, `${name} advertises max 25`);
    assert.match(perPage.description!, /max 25/);
  }
  assert.equal(mock.calls.length, 0);
});

test("get_media_characters sorts by role then relevance and forwards voiceActorLanguage/role only when set", async (t) => {
  // Mirrors the live shape for Media(id:16498){characters{...}} with
  // voiceActors(language:JAPANESE).
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Media: {
          characters: {
            pageInfo: { hasNextPage: true },
            edges: [
              {
                role: "MAIN",
                voiceActors: [{ id: 95991, name: { full: "Yuuki Kaji" }, languageV2: "Japanese" }],
                node: {
                  id: 40882,
                  name: { full: "Eren Yeager", native: "エレン・イェーガー" },
                  siteUrl: "https://anilist.co/character/40882",
                },
              },
            ],
          },
        },
      },
    }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);

  const plain = await client.callTool({
    name: "get_media_characters",
    arguments: { type: "ANIME", id: 16498 },
  });
  assert.notEqual(plain.isError, true, JSON.stringify(plain.content));
  const first = bodyOf(mock.calls[0]!.init);
  assert.match(first.query, /characters\(page:\$page,perPage:\$perPage,sort:\[ROLE,RELEVANCE,ID\]/);
  assert.match(first.query, /voiceActors\(language:\$language/);
  // Absent → dropped from variables, so AniList sees the argument as omitted
  // (every language / every role), not as a filter.
  assert.ok(!("language" in first.variables), "no language filter by default");
  assert.ok(!("role" in first.variables), "no role filter by default");

  const filtered = await client.callTool({
    name: "get_media_characters",
    arguments: { type: "ANIME", id: 16498, voiceActorLanguage: "JAPANESE", role: "MAIN" },
  });
  assert.notEqual(filtered.isError, true, JSON.stringify(filtered.content));
  const second = bodyOf(mock.calls[1]!.init);
  assert.equal(second.variables.language, "JAPANESE");
  assert.equal(second.variables.role, "MAIN");

  const bad = await client.callTool({
    name: "get_media_characters",
    arguments: { type: "ANIME", id: 16498, voiceActorLanguage: "KLINGON" },
  });
  assert.equal(bad.isError, true, "an unknown StaffLanguage is rejected, not sent upstream");
});

test("get_anime_schedule converts airingAfter/airingBefore to unix seconds and lets the window decide notYetAired", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        schedule: {
          pageInfo: { hasNextPage: false },
          airingSchedules: [
            {
              airingAt: 1792454400,
              timeUntilAiring: 3600,
              episode: 3,
              media: {
                id: 198312,
                title: { romaji: "Example", english: null },
                siteUrl: "https://anilist.co/anime/198312",
              },
            },
          ],
        },
      },
    }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);

  // No window: the historical "upcoming only" default still applies.
  await client.callTool({ name: "get_anime_schedule", arguments: {} });
  const plain = bodyOf(mock.calls[0]!.init).variables;
  assert.equal(plain.notYetAired, true);
  assert.ok(!("after" in plain) && !("before" in plain));

  // A window: offsets are honoured, and notYetAired is left unset so a window
  // spanning now keeps both halves (confirmed live: ANDed upstream).
  const res = await client.callTool({
    name: "get_anime_schedule",
    arguments: {
      airingAfter: "2026-10-20T09:00:00+09:00",
      airingBefore: "2026-10-21T00:00:00.900Z",
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const windowed = bodyOf(mock.calls[1]!.init);
  assert.equal(windowed.variables.after, Date.UTC(2026, 9, 20) / 1000);
  assert.equal(
    windowed.variables.before,
    Date.UTC(2026, 9, 21) / 1000 + 1,
    "rounded up: airingAt_lesser is strict",
  );
  assert.ok(!("notYetAired" in windowed.variables), "window alone decides");
  assert.match(windowed.query, /airingAt_greater:\$after,airingAt_lesser:\$before/);

  // An explicit notYetAired still wins inside a window.
  await client.callTool({
    name: "get_anime_schedule",
    arguments: { airingBefore: "2026-10-21T00:00:00Z", notYetAired: false },
  });
  assert.equal(bodyOf(mock.calls[2]!.init).variables.notYetAired, false);

  // No offset → rejected (an unzoned time is ambiguous), never sent upstream.
  const before = mock.calls.length;
  const bad = await client.callTool({
    name: "get_anime_schedule",
    arguments: { airingAfter: "2026-10-20T00:00:00" },
  });
  assert.equal(bad.isError, true);
  assert.equal(mock.calls.length, before);
});

test("get_todays_birthdays paginates, sorts by favourites and returns hasNextPage", async (t) => {
  // Mirrors the live Page{pageInfo{hasNextPage} characters(isBirthday:true,...)}
  // shape (one list field per Page, plus its pageInfo).
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Page: {
          pageInfo: { hasNextPage: true },
          characters: [
            {
              id: 123212,
              name: { full: "Kiyotaka Ayanokouji", native: "綾小路清隆" },
              image: { large: "https://s4.anilist.co/file/anilistcdn/character/large/b123212.png" },
              favourites: 15694,
              isFavourite: false,
              siteUrl: "https://anilist.co/character/123212",
            },
          ],
        },
      },
    }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  const res = await client.callTool({
    name: "get_todays_birthdays",
    arguments: { kind: "CHARACTER", page: 2, perPage: 5 },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const body = bodyOf(mock.calls[0]!.init);
  assert.match(body.query, /Page\(page:\$page,perPage:\$perPage\)/);
  assert.match(body.query, /characters\(isBirthday:true,sort:FAVOURITES_DESC\)/);
  assert.deepEqual(body.variables, { page: 2, perPage: 5 });
  const structured = res.structuredContent as { results: unknown[]; hasNextPage: boolean };
  assert.equal(structured.hasNextPage, true);
  assert.equal(structured.results.length, 1);
});

test("profile/UpdateUser selections no longer read the deprecated MediaListTypeOptions.theme", async (t) => {
  assert.doesNotMatch(USER_DETAIL_FIELDS, /\btheme\b/);
  const listOptions = {
    sectionOrder: ["Watching", "Completed"],
    splitCompletedSectionByFormat: false,
    customLists: [],
    advancedScoring: ["Story", "Characters"],
    advancedScoringEnabled: false,
  };
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        UpdateUser: {
          id: 1,
          name: "Grinv",
          about: null,
          donatorBadge: "Donator",
          options: {
            titleLanguage: "ROMAJI",
            displayAdultContent: false,
            airingNotifications: true,
            profileColor: "blue",
            timezone: null,
            activityMergeTime: 720,
            staffNameLanguage: "ROMAJI_WESTERN",
            restrictMessagesToFollowing: false,
            notificationOptions: [{ type: "AIRING", enabled: true }],
            disabledListActivity: [{ type: "CURRENT", disabled: false }],
          },
          mediaListOptions: {
            scoreFormat: "POINT_10_DECIMAL",
            rowOrder: "score",
            animeList: listOptions,
            mangaList: listOptions,
          },
        },
      },
    }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({
    ANILIST_ACCESS_TOKEN: "tok",
    ANILIST_MIN_INTERVAL_MS: "0",
  });
  t.after(close);
  // The write side still accepts `theme` (MediaListOptionsInput.theme isn't
  // deprecated) — only the read-back selection is gone.
  const res = await client.callTool({
    name: "update_user",
    arguments: { animeListOptions: { theme: "default" } },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const body = bodyOf(mock.calls[0]!.init);
  const selection = body.query.slice(body.query.indexOf("UpdateUser("));
  assert.doesNotMatch(selection.slice(selection.indexOf("){")), /\btheme\b/);
  assert.deepEqual(body.variables.animeListOptions, { theme: "default" });
});
