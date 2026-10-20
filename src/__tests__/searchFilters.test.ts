import { test } from "node:test";
import assert from "node:assert/strict";
import { AniListClient } from "../clients/anilist.js";
import * as activity from "../clients/anilist/activity.js";
import * as search from "../clients/anilist/search.js";
import {
  jsonResponse,
  mockFetch,
  installFetch,
  connectServer,
  testConfig,
  silentLogger,
} from "./helpers.js";
import type { UserId } from "../clients/anilist/ids.js";

// Tool-level tests for search_media's `isAdult` and the activity tools'
// multi-value `type` / search_activity's `isFollowing`. Every fixture below is
// an empty page: AniList's real shape for these selections is
// `Page{pageInfo{...}, media|activities:[...]}`, and an empty list is a real
// response (no fields invented for the code to read) — these tests assert on
// the request sent, not on result content.
const emptyPageInfo = { total: 0, currentPage: 1, lastPage: 1, hasNextPage: false };
const emptyMediaPage = () =>
  jsonResponse({ data: { Page: { pageInfo: { ...emptyPageInfo, perPage: 10 }, media: [] } } });
const emptyActivityPage = () =>
  jsonResponse({ data: { Page: { pageInfo: emptyPageInfo, activities: [] } } });

type Sent = { query: string; variables: Record<string, unknown> };
const sent = (mock: ReturnType<typeof mockFetch>, i: number) =>
  JSON.parse(mock.calls[i]!.init?.body as string) as Sent;
const errorText = (res: { content?: unknown }) =>
  (res.content as { type: "text"; text: string }[])[0]!.text;

test("tools/list still lists search_media/search_activity/get_user_activity with the new fields", async (t) => {
  installFetch(
    t,
    mockFetch(() => emptyMediaPage()),
  );
  const { client, close } = await connectServer({
    ANILIST_MIN_INTERVAL_MS: "0",
    CACHE_TTL_MS: "0",
  });
  t.after(close);
  const { tools } = await client.listTools();
  const props = (name: string) =>
    (tools.find((x) => x.name === name)!.inputSchema as { properties: Record<string, unknown> })
      .properties;
  assert.ok("isAdult" in props("search_media"));
  assert.ok("sfw" in props("search_media"), "sfw is kept for backward compatibility");
  assert.ok("isFollowing" in props("search_activity"));
  assert.ok("anyOf" in (props("search_activity").type as object), "type is one value or an array");
  const { description: _a, ...searchType } = props("search_activity").type as Record<
    string,
    unknown
  >;
  const { description: _b, ...userType } = props("get_user_activity").type as Record<
    string,
    unknown
  >;
  assert.deepEqual(searchType, userType, "both tools take the same `type` shape");
});

test("search_media maps sfw/isAdult to AniList's isAdult, and rejects sfw:true + isAdult:true before any fetch", async (t) => {
  const mock = mockFetch(() => emptyMediaPage());
  installFetch(t, mock);
  const { client, close } = await connectServer({
    ANILIST_MIN_INTERVAL_MS: "0",
    CACHE_TTL_MS: "0",
  });
  t.after(close);

  const cases: [Record<string, unknown>, boolean | undefined][] = [
    [{}, undefined],
    [{ sfw: true }, false],
    [{ isAdult: true }, true],
    [{ isAdult: false }, false],
    [{ sfw: true, isAdult: false }, false],
    [{ sfw: false, isAdult: true }, true],
  ];
  for (const [i, [args, expected]] of cases.entries()) {
    const res = await client.callTool({
      name: "search_media",
      arguments: { type: "ANIME", ...args },
    });
    assert.notEqual(res.isError, true, `${JSON.stringify(args)}: ${JSON.stringify(res.content)}`);
    const vars = sent(mock, i).variables;
    if (expected === undefined) assert.ok(!("isAdult" in vars), "no filter → omitted");
    else assert.equal(vars.isAdult, expected, JSON.stringify(args));
  }

  const before = mock.calls.length;
  const res = await client.callTool({
    name: "search_media",
    arguments: { type: "ANIME", sfw: true, isAdult: true },
  });
  assert.equal(res.isError, true);
  assert.match(errorText(res), /isAdult/);
  assert.equal(mock.calls.length, before, "contradiction rejected before any request");
});

test("search_activity and get_user_activity send a single type as `type` and an array as `type_in`", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as Sent;
    if (body.query.includes("exists:User")) {
      return jsonResponse({
        data: { exists: { id: 7640432 }, feed: { pageInfo: emptyPageInfo, activities: [] } },
      });
    }
    return emptyActivityPage();
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({
    ANILIST_MIN_INTERVAL_MS: "0",
    CACHE_TTL_MS: "0",
  });
  t.after(close);

  const calls: [string, Record<string, unknown>][] = [
    ["search_activity", { type: "TEXT" }],
    ["search_activity", { type: ["TEXT", "MEDIA_LIST"] }],
    ["get_user_activity", { user: 7640432, type: "MESSAGE" }],
    ["get_user_activity", { user: 7640432, type: ["ANIME_LIST", "TEXT"] }],
  ];
  for (const [name, args] of calls) {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
  }
  assert.equal(sent(mock, 0).variables.type, "TEXT");
  assert.ok(!("type_in" in sent(mock, 0).variables));
  assert.deepEqual(sent(mock, 1).variables.type_in, ["TEXT", "MEDIA_LIST"]);
  assert.ok(!("type" in sent(mock, 1).variables));
  assert.match(sent(mock, 1).query, /type_in:\$type_in/);
  assert.equal(sent(mock, 2).variables.type, "MESSAGE");
  assert.deepEqual(sent(mock, 3).variables.typeIn, ["ANIME_LIST", "TEXT"]);
  assert.ok(!("type" in sent(mock, 3).variables));
  assert.match(sent(mock, 3).query, /type_in:\$typeIn/);

  const before = mock.calls.length;
  for (const [name, args] of [
    ["search_activity", { type: [] }],
    ["get_user_activity", { user: 1, type: ["TEXT", "POST"] }],
  ] as const) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} ${JSON.stringify(args)} must be rejected`);
  }
  assert.equal(mock.calls.length, before);
});

test("activityTypeVars leaves both arguments unset when no type is given", () => {
  assert.deepEqual(activity.activityTypeVars(undefined), {});
  assert.deepEqual(activity.activityTypeVars("TEXT"), { type: "TEXT" });
  assert.deepEqual(activity.activityTypeVars(["TEXT"]), { typeIn: ["TEXT"] });
});

test("search_activity's isFollowing requires login (AniList ignores it unauthenticated) and can't be combined with user", async (t) => {
  const mock = mockFetch(() => {
    throw new Error("must not be called — gated before any fetch");
  });
  installFetch(t, mock);
  const { client: anon, close: closeAnon } = await connectServer({
    ANILIST_MIN_INTERVAL_MS: "0",
    CACHE_TTL_MS: "0",
  });
  t.after(closeAnon);
  const noToken = await anon.callTool({
    name: "search_activity",
    arguments: { isFollowing: true },
  });
  assert.equal(noToken.isError, true);
  assert.match(errorText(noToken), /login_anilist/);

  const both = await anon.callTool({
    name: "search_activity",
    arguments: { isFollowing: true, user: "Grinv" },
  });
  assert.equal(both.isError, true);
  assert.match(errorText(both), /not both/);
  assert.equal(mock.calls.length, 0);

  const okMock = mockFetch(() => emptyActivityPage());
  installFetch(t, okMock);
  const { client, close } = await connectServer({
    ANILIST_ACCESS_TOKEN: "tok",
    ANILIST_MIN_INTERVAL_MS: "0",
    CACHE_TTL_MS: "0",
  });
  t.after(close);
  const res = await client.callTool({
    name: "search_activity",
    arguments: { isFollowing: true, type: ["TEXT", "MEDIA_LIST"] },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const call = sent(okMock, 0);
  assert.equal(call.variables.isFollowing, true);
  assert.match(call.query, /isFollowing:\$isFollowing/);
  assert.match(
    String((okMock.calls[0]!.init?.headers as Record<string, string>).Authorization),
    /Bearer tok/,
  );

  // isFollowing: false means no restriction — no token needed, not sent.
  const off = await anon.callTool({ name: "search_activity", arguments: { isFollowing: false } });
  assert.notEqual(off.isError, true, JSON.stringify(off.content));
  assert.ok(!("isFollowing" in sent(okMock, 1).variables));
});

test("searchActivity rejects isFollowing + a numeric user too, before any fetch", async (t) => {
  const mock = mockFetch(() => {
    throw new Error("must not be called");
  });
  installFetch(t, mock);
  const client = new AniListClient(testConfig({ ANILIST_ACCESS_TOKEN: "tok" }), silentLogger());
  await assert.rejects(
    () =>
      search.searchActivity(client.ctx(), 7640432 as UserId, undefined, 1, 10, {
        isFollowing: true,
      }),
    { code: "bad_request" },
  );
  assert.equal(mock.calls.length, 0);
});
