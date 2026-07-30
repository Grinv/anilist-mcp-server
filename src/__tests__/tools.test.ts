import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, mockFetch, installFetch, connectServer } from "./helpers.js";

test("search_media tool returns structured results end-to-end", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: { Page: { pageInfo: {}, media: [{ id: 1, title: { romaji: "Frieren" } }] } },
    }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  const res = await client.callTool({
    name: "search_media",
    arguments: { type: "ANIME", term: "frieren" },
  });
  assert.notEqual(res.isError, true);
  const structured = res.structuredContent as { results: { media: Record<string, unknown>[] } };
  assert.equal(
    (structured.results.media[0] as { title: { romaji: string } }).title.romaji,
    "Frieren",
  );
});

test("get_notifications requires a token, and returns structured results end-to-end with one", async (t) => {
  const mock = mockFetch(() => {
    throw new Error("must not be called — requireAuth() should gate before any fetch");
  });
  installFetch(t, mock);
  const { client: noTokenClient, close: closeNoToken } = await connectServer({});
  t.after(closeNoToken);
  const noTokenRes = await noTokenClient.callTool({ name: "get_notifications", arguments: {} });
  assert.equal(noTokenRes.isError, true, "get_notifications should require a token");
  assert.equal(mock.calls.length, 0);

  const okMock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { variables: Record<string, unknown> };
    assert.equal(body.variables.resetNotificationCount, true);
    return jsonResponse({
      data: {
        Page: {
          pageInfo: { hasNextPage: false },
          notifications: [{ id: 1, type: "AIRING", episode: 5 }],
        },
      },
    });
  });
  installFetch(t, okMock);
  const { client, close } = await connectServer({
    ANILIST_ACCESS_TOKEN: "tok",
    ANILIST_MIN_INTERVAL_MS: "0",
  });
  t.after(close);
  const res = await client.callTool({
    name: "get_notifications",
    arguments: { markAsRead: true },
  });
  assert.notEqual(res.isError, true, `get_notifications errored: ${JSON.stringify(res.content)}`);
  const structured = res.structuredContent as {
    results: { notifications: Record<string, unknown>[] };
  };
  assert.equal(structured.results.notifications[0]!.type, "AIRING");
});

test("the media-detail tools (characters/staff/reviews/relations/schedule/statistics) are wired end-to-end for both anime and manga", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Media: {
          characters: { pageInfo: {}, edges: [{ role: "MAIN", voiceActors: [], node: { id: 1 } }] },
          staff: { pageInfo: {}, edges: [{ role: "Director", node: { id: 1 } }] },
          reviews: { pageInfo: {}, nodes: [{ id: 1, summary: "great" }] },
          relations: { edges: [{ relationType: "SEQUEL", node: { id: 2 } }] },
          stats: { scoreDistribution: [{ score: 90, amount: 100 }], statusDistribution: [] },
        },
        schedule: { pageInfo: {}, airingSchedules: [{ episode: 5, media: { id: 1 } }] },
      },
    }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);

  const cases: [string, Record<string, unknown>, string][] = [
    ["get_media_characters", { type: "ANIME", id: 1 }, "characters"],
    ["get_media_characters", { type: "MANGA", id: 1 }, "characters"],
    ["get_media_staff", { type: "ANIME", id: 1 }, "staff"],
    ["get_media_staff", { type: "MANGA", id: 1 }, "staff"],
    ["get_media_reviews", { type: "ANIME", id: 1 }, "reviews"],
    ["get_media_reviews", { type: "MANGA", id: 1 }, "reviews"],
    ["get_media_relations", { id: 1, type: "ANIME" }, "relations"],
    ["get_anime_schedule", {}, "schedule"],
    ["get_media_statistics", { type: "ANIME", id: 1 }, "statistics"],
    ["get_media_statistics", { type: "MANGA", id: 1 }, "statistics"],
  ];
  for (const [name, args, key] of cases) {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, `${name} errored: ${JSON.stringify(res.content)}`);
    assert.ok(key in (res.structuredContent as object), `${name} missing \`${key}\` in result`);
  }
});

test("a representative read tool from each category is wired end-to-end", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    // A generic object payload satisfies every top-level query field these
    // tools request — we only need the request to succeed and a plausible
    // shape to flow through, not full field-accurate fixtures per case.
    const key =
      /Genre|MediaTag|Studio\(|Character\(|Staff\(|Recommendation\(|Media\(|Thread\(|User\(|Viewer|Activity\(|Page\(/.exec(
        body.query,
      );
    void key;
    return jsonResponse({
      data: {
        GenreCollection: ["Action"],
        MediaTagCollection: [{ name: "Tragedy" }],
        Studio: { id: 1, name: "Bones" },
        Character: { id: 1, name: { full: "Frieren" } },
        Staff: { id: 1, name: { full: "Someone" } },
        Recommendation: { id: 1 },
        Media: { id: 1 },
        Thread: { id: 1 },
        exists: { id: 1 },
        User: { id: 1, name: "Grinv" },
        Activity: { id: 1 },
        Page: {
          pageInfo: {},
          media: [],
          characters: [],
          staff: [],
          studios: [],
          users: [],
          activities: [],
          threadComments: [],
          threads: [],
        },
      },
    });
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);

  const cases: [string, Record<string, unknown>][] = [
    ["get_genres", {}],
    ["get_media_tags", {}],
    ["get_studio", { id: 1 }],
    ["get_character", { id: 1 }],
    ["get_staff", { id: 1 }],
    ["get_recommendation", { id: 1 }],
    ["get_media", { type: "ANIME", ids: 1 }],
    ["get_media", { type: "MANGA", ids: 1 }],
    ["get_thread", { id: 1 }],
    ["get_thread_comments", { threadId: 1 }],
    ["search_thread", {}],
    ["get_user_profile", { user: 1 }],
    ["get_activity", { id: 1 }],
    ["search_character", { term: "frieren" }],
    ["search_staff", { term: "frieren" }],
    ["search_studio", { term: "bones" }],
    ["search_user", { term: "grinv" }],
    ["search_activity", {}],
    ["get_todays_birthdays", { kind: "CHARACTER" }],
    ["get_todays_birthdays", { kind: "STAFF" }],
  ];
  for (const [name, args] of cases) {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, `${name} errored: ${JSON.stringify(res.content)}`);
  }
});

test("get_studio reports an actionable error (isError: true) when neither id nor name is given", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: {} }));
  installFetch(t, mock);
  const { client, close } = await connectServer({});
  t.after(close);

  const res = await client.callTool({ name: "get_studio", arguments: {} });
  assert.equal(res.isError, true, "must be a real tool error, not a success-shaped {error} field");
  assert.equal(mock.calls.length, 0, "must not call AniList at all without an id or name");
});

test("post_thread requires categories when creating (no id), but not when updating (id given)", async (t) => {
  const badMock = mockFetch(() => {
    throw new Error("must not be called — Zod should reject before any fetch");
  });
  installFetch(t, badMock);
  const { client, close } = await connectServer({ ANILIST_ACCESS_TOKEN: "tok" });
  t.after(close);

  const createRes = await client.callTool({
    name: "post_thread",
    arguments: { title: "thread!", body: "b" },
  });
  assert.equal(createRes.isError, true, "creating without categories must be rejected");
  assert.equal(badMock.calls.length, 0);

  const okMock = mockFetch(() => jsonResponse({ data: { SaveThread: { id: 1 } } }));
  installFetch(t, okMock);
  const updateRes = await client.callTool({
    name: "post_thread",
    arguments: { title: "thread!", body: "b", id: 1 },
  });
  assert.notEqual(updateRes.isError, true, "updating via id must not require categories");
});

test("post_thread requires title/body when creating (no id), but not when updating (id given)", async (t) => {
  // Confirmed live via raw GraphQL: SaveThread's title/body args are nullable,
  // and an update omitting them leaves the thread's existing title/body
  // unchanged rather than clearing or rejecting them — same "required only
  // on create" shape as categories above.
  const badMock = mockFetch(() => {
    throw new Error("must not be called — Zod should reject before any fetch");
  });
  installFetch(t, badMock);
  const { client, close } = await connectServer({ ANILIST_ACCESS_TOKEN: "tok" });
  t.after(close);

  const missingTitle = await client.callTool({
    name: "post_thread",
    arguments: { body: "b", categories: [1] },
  });
  assert.equal(missingTitle.isError, true, "creating without title must be rejected");

  const missingBody = await client.callTool({
    name: "post_thread",
    arguments: { title: "thread!", categories: [1] },
  });
  assert.equal(missingBody.isError, true, "creating without body must be rejected");
  assert.equal(badMock.calls.length, 0);

  const okMock = mockFetch(() => jsonResponse({ data: { SaveThread: { id: 1 } } }));
  installFetch(t, okMock);
  const updateRes = await client.callTool({
    name: "post_thread",
    arguments: { id: 1, sticky: true },
  });
  assert.notEqual(updateRes.isError, true, "updating via id must not require title/body");
});

test("mutation tools reject text below AniList's own documented minimum length before any fetch", async (t) => {
  const mock = mockFetch(() => {
    throw new Error("must not be called — Zod should reject before any fetch");
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({});
  t.after(close);

  const tooShort: [string, Record<string, unknown>][] = [
    ["post_text_activity", { text: "hi" }], // AniList: Min 5
    ["post_message_activity", { recipientId: 1, message: "h" }], // AniList: Min 2
    ["post_thread", { title: "abcde", body: "b" }], // AniList: Min 6
  ];
  for (const [name, args] of tooShort) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} with too-short text should be a validation error`);
  }
  assert.equal(mock.calls.length, 0, "none of these should have reached AniList");
});

test("update_user's notificationOptions/disabledListActivity reject a duplicated type even when every type is still covered", async (t) => {
  // Regression: the .refine() only checked Set(types).size === the full
  // count, which passes for a 21-entry array that duplicates one type and
  // omits none — it never checked the array's own length, so "exactly
  // once" wasn't actually enforced despite both tools' descriptions
  // promising it.
  const NOTIFICATION_TYPES = [
    "ACTIVITY_MESSAGE",
    "ACTIVITY_REPLY",
    "FOLLOWING",
    "ACTIVITY_MENTION",
    "THREAD_COMMENT_MENTION",
    "THREAD_SUBSCRIBED",
    "THREAD_COMMENT_REPLY",
    "AIRING",
    "ACTIVITY_LIKE",
    "ACTIVITY_REPLY_LIKE",
    "THREAD_LIKE",
    "THREAD_COMMENT_LIKE",
    "ACTIVITY_REPLY_SUBSCRIBED",
    "RELATED_MEDIA_ADDITION",
    "MEDIA_DATA_CHANGE",
    "MEDIA_MERGE",
    "MEDIA_DELETION",
    "MEDIA_SUBMISSION_UPDATE",
    "STAFF_SUBMISSION_UPDATE",
    "CHARACTER_SUBMISSION_UPDATE",
  ];
  const MEDIA_LIST_STATUSES = [
    "CURRENT",
    "PLANNING",
    "COMPLETED",
    "DROPPED",
    "PAUSED",
    "REPEATING",
  ];

  const badMock = mockFetch(() => {
    throw new Error("must not be called — Zod should reject before any fetch");
  });
  installFetch(t, badMock);
  const { client, close } = await connectServer({ ANILIST_ACCESS_TOKEN: "tok" });
  t.after(close);

  const duplicatedNotificationOptions = [
    ...NOTIFICATION_TYPES.map((type) => ({ type, enabled: true })),
    { type: NOTIFICATION_TYPES[0], enabled: false }, // 21 entries, all 20 types still covered
  ];
  const res1 = await client.callTool({
    name: "update_user",
    arguments: { notificationOptions: duplicatedNotificationOptions },
  });
  assert.equal(res1.isError, true, "a duplicated notification type must be rejected");

  const duplicatedDisabledListActivity = [
    ...MEDIA_LIST_STATUSES.map((type) => ({ type, disabled: false })),
    { type: MEDIA_LIST_STATUSES[0], disabled: true }, // 7 entries, all 6 statuses still covered
  ];
  const res2 = await client.callTool({
    name: "update_user",
    arguments: { disabledListActivity: duplicatedDisabledListActivity },
  });
  assert.equal(res2.isError, true, "a duplicated list status must be rejected");
  assert.equal(badMock.calls.length, 0);
});

test("update_user's timezone regex accepts AniList's documented -?HH:MM format and rejects garbage", async (t) => {
  const okMock = mockFetch(() => jsonResponse({ data: { UpdateUser: { id: 1 } } }));
  installFetch(t, okMock);
  const { client, close } = await connectServer({ ANILIST_ACCESS_TOKEN: "tok" });
  t.after(close);

  for (const timezone of ["09:00", "-05:00"]) {
    const res = await client.callTool({ name: "update_user", arguments: { timezone } });
    assert.notEqual(res.isError, true, `"${timezone}" should be accepted`);
  }

  const badMock = mockFetch(() => {
    throw new Error("must not be called — Zod should reject before any fetch");
  });
  installFetch(t, badMock);
  for (const timezone of ["banana", "+09:00", "9:00", "09:0"]) {
    const res = await client.callTool({ name: "update_user", arguments: { timezone } });
    assert.equal(res.isError, true, `"${timezone}" should be rejected`);
  }
  assert.equal(badMock.calls.length, 0);
});

test("get_media's ids validation error distinguishes a missing value from a wrongly-typed one", async (t) => {
  // Regression: idsSchema's z.union used a single string `error`, which fires
  // for EVERY union-mismatch reason alike — so a wrongly-typed-but-present
  // value (e.g. a decimal) used to get the same "ids is required" message as
  // omitting it entirely, which is misleading since something WAS passed.
  // Input validation failures come back as a normal isError:true tool result
  // (not a rejected callTool()), same as get_studio's own validation test.
  const { client, close } = await connectServer({});
  t.after(close);

  const missing = await client.callTool({ name: "get_media", arguments: { type: "ANIME" } });
  assert.equal(missing.isError, true);
  assert.match(
    (missing.content as { type: "text"; text: string }[])[0]!.text,
    /ids is required — pass a single AniList ID/,
    "omitting ids entirely must say it's required",
  );

  const wrongType = await client.callTool({
    name: "get_media",
    arguments: { type: "ANIME", ids: 1.5 },
  });
  assert.equal(wrongType.isError, true);
  assert.match(
    (wrongType.content as { type: "text"; text: string }[])[0]!.text,
    /ids must be a single AniList ID/,
    'a wrongly-typed (non-integer) ids must not be told it\'s "required" — it WAS provided',
  );
});

test("get_media's ids array rejects a batch larger than 25", async (t) => {
  // Regression: idsSchema's array branch had .min(1) but no upper bound —
  // confirmed live an unbounded batch (up to at least 1000 ids) succeeds
  // against AniList with no server-side rejection, so nothing but this
  // client-side cap protects a caller from an unboundedly large response
  // (each entry includes the full synopsis/tags/rankings).
  const { client, close } = await connectServer({});
  t.after(close);

  const tooMany = await client.callTool({
    name: "get_media",
    arguments: { type: "ANIME", ids: Array.from({ length: 26 }, (_, i) => i + 1) },
  });
  assert.equal(tooMany.isError, true);
  assert.match(
    (tooMany.content as { type: "text"; text: string }[])[0]!.text,
    /ids: Too big: expected array to have <=25 items/,
  );
});

test("get_user_profile's user validation error distinguishes a missing value from a wrongly-typed one", async (t) => {
  // Same fix/regression as idsSchema above, applied to the shared
  // userIdOrName union used by every user-scoped tool.
  const { client, close } = await connectServer({});
  t.after(close);

  const missing = await client.callTool({ name: "get_user_profile", arguments: {} });
  assert.equal(missing.isError, true);
  assert.match(
    (missing.content as { type: "text"; text: string }[])[0]!.text,
    /user is required — pass an AniList numeric ID/,
    "omitting user entirely must say it's required",
  );

  const wrongType = await client.callTool({
    name: "get_user_profile",
    arguments: { user: 1.5 },
  });
  assert.equal(wrongType.isError, true);
  assert.match(
    (wrongType.content as { type: "text"; text: string }[])[0]!.text,
    /user must be an AniList numeric ID/,
    'a wrongly-typed (non-integer) user must not be told it\'s "required" — it WAS provided',
  );
});

test("personal/mutation tools without a token return an actionable error instead of calling AniList", async (t) => {
  // A real fetch mock that always throws — proves the requireAuth() gate is
  // actually checked *before* any network call, not just that the result
  // happens to be an error (a regression here would otherwise make a live
  // network call during this test instead of failing the assertion).
  const mock = mockFetch(() => {
    throw new Error("must not be called — requireAuth() should gate before any fetch");
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({});
  t.after(close);
  const mutationTools: [string, Record<string, unknown>][] = [
    ["add_list_entry", { mediaId: 1 }],
    ["update_list_entry", { listEntryId: 1 }],
    ["remove_list_entry", { listEntryId: 1 }],
    ["toggle_favourite", { kind: "ANIME", id: 1 }],
    ["toggle_favourite", { kind: "MANGA", id: 1 }],
    ["toggle_favourite", { kind: "CHARACTER", id: 1 }],
    ["toggle_favourite", { kind: "STAFF", id: 1 }],
    ["toggle_favourite", { kind: "STUDIO", id: 1 }],
    ["get_authorized_user", {}],
    ["get_notifications", {}],
    ["toggle_follow_user", { id: 1 }],
    ["update_user", {}],
    ["post_text_activity", { text: "hello" }],
    ["post_message_activity", { recipientId: 1, message: "hi" }],
    ["delete_activity", { id: 1 }],
    ["post_thread", { title: "thread!", body: "b", categories: [1] }],
    ["post_thread_comment", { threadId: 1, comment: "hi" }],
    ["delete_thread", { id: 1 }],
    ["delete_thread_comment", { id: 1 }],
  ];
  for (const [name, args] of mutationTools) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} should require a token`);
    const text = (res.content as { type: "text"; text: string }[])[0]!.text;
    assert.match(text, /login_anilist|ANILIST_ACCESS_TOKEN/);
  }
  assert.equal(mock.calls.length, 0, "no gated tool should ever reach fetch without a token");
});

test("mutation tools return the unwrapped GraphQL field, not the raw response envelope, end-to-end", async (t) => {
  // Regression: saveListEntry/toggleFavourite/postTextActivity/deleteActivity/
  // deleteListEntry/deleteThread/followUser/updateUser all used to `return
  // ctx.gql.request(...)` directly, which returns the FULL response object
  // (e.g. `{SaveMediaListEntry: {...}}`), not the field itself. Every mocked
  // client-level test asserted that wrapped shape as if it were correct, so
  // nothing caught it until `outputSchema` runtime validation failed on a real
  // account (`entry.id` was `undefined`). This test drives the real MCP
  // server + a real token through `callTool`, so `outputSchema` validation is
  // actually exercised — the same layer that caught the original bug.
  const mock = mockFetch(() =>
    jsonResponse({ data: { SaveMediaListEntry: { id: 9, status: "PLANNING", mediaId: 1 } } }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({
    ANILIST_ACCESS_TOKEN: "tok",
    ANILIST_MIN_INTERVAL_MS: "0",
  });
  t.after(close);
  const res = await client.callTool({ name: "add_list_entry", arguments: { mediaId: 1 } });
  assert.notEqual(res.isError, true, `add_list_entry errored: ${JSON.stringify(res.content)}`);
  const structured = res.structuredContent as { entry: { id: number } };
  assert.equal(structured.entry.id, 9, "entry must be the unwrapped SaveMediaListEntry field");
});

test("every gated mutation tool succeeds end-to-end with a token, not just add_list_entry", async (t) => {
  // Previously only add_list_entry was ever driven through the real MCP
  // server with a token — the other 11 gated tools were only exercised by
  // the no-token rejection path. Since the unwrap bug (above) could in
  // principle recur independently in any one of these, this loops all of
  // them through a real callTool() with a minimal valid mocked response.
  const responses: Record<string, unknown> = {
    SaveMediaListEntry: { id: 1, status: "PLANNING" },
    DeleteMediaListEntry: { deleted: true },
    ToggleFavourite: {},
    ToggleFollow: { id: 1, name: "someone" },
    UpdateUser: { id: 1, name: "me" },
    SaveTextActivity: { id: 1, text: "hi" },
    SaveMessageActivity: { id: 1, message: "hi" },
    DeleteActivity: { deleted: true },
    // SaveThreadComment must be checked before SaveThread below — its own
    // mutation name contains "SaveThread" as a substring, so a naive
    // first-match search in the wrong order would misfire on it.
    SaveThreadComment: { id: 1, comment: "hi" },
    SaveThread: { id: 1, title: "t", siteUrl: "https://anilist.co/forum/thread/1" },
    // DeleteThreadComment must be checked before DeleteThread for the same
    // substring-prefix reason as SaveThreadComment/SaveThread above.
    DeleteThreadComment: { deleted: true },
    DeleteThread: { deleted: true },
  };
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string };
    const field = Object.keys(responses).find((f) => body.query.includes(f));
    return jsonResponse({ data: field ? { [field]: responses[field] } : {} });
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({
    ANILIST_ACCESS_TOKEN: "tok",
    ANILIST_MIN_INTERVAL_MS: "0",
  });
  t.after(close);

  const cases: [string, Record<string, unknown>][] = [
    ["update_list_entry", { listEntryId: 1 }],
    ["remove_list_entry", { listEntryId: 1 }],
    ["toggle_favourite", { kind: "ANIME", id: 1 }],
    ["toggle_favourite", { kind: "MANGA", id: 1 }],
    ["toggle_favourite", { kind: "CHARACTER", id: 1 }],
    ["toggle_favourite", { kind: "STAFF", id: 1 }],
    ["toggle_favourite", { kind: "STUDIO", id: 1 }],
    ["toggle_follow_user", { id: 1 }],
    ["update_user", {}],
    ["post_text_activity", { text: "hello" }],
    ["post_message_activity", { recipientId: 1, message: "hi" }],
    ["delete_activity", { id: 1 }],
    ["post_thread", { title: "thread!", body: "b", categories: [1] }],
    ["post_thread_comment", { threadId: 1, comment: "hi" }],
    ["delete_thread", { id: 1 }],
    ["delete_thread_comment", { id: 1 }],
  ];
  for (const [name, args] of cases) {
    const res = await client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, `${name} errored: ${JSON.stringify(res.content)}`);
  }
});

test("get_studio: when both id and name are given, id takes precedence", async (t) => {
  const mock = mockFetch((_url, init) => {
    const body = JSON.parse(init?.body as string) as { variables: Record<string, unknown> };
    // Only the id-branch query is ever built; confirm it used the id, not the name.
    assert.equal(body.variables.id, 1);
    return jsonResponse({ data: { Studio: { id: 1, name: "Madhouse" } } });
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({});
  t.after(close);
  const res = await client.callTool({ name: "get_studio", arguments: { id: 1, name: "ignored" } });
  assert.notEqual(res.isError, true);
  assert.equal(mock.calls.length, 1);
});

test("add_list_entry surfaces a clean tool error (not a crash) when AniList returns a null mutation field", async (t) => {
  // Settles a question an earlier review round could only mark PLAUSIBLE:
  // SaveMediaListEntry is nullable per AniList's schema; savedListEntry's
  // outputSchema requires a non-null object. The MCP SDK validates
  // structuredContent against outputSchema in the same try/catch as tool
  // execution, so this must still come back as isError: true with SOME
  // message — not an uncaught exception or a broken connection.
  const mock = mockFetch(() => jsonResponse({ data: { SaveMediaListEntry: null } }));
  installFetch(t, mock);
  const { client, close } = await connectServer({
    ANILIST_ACCESS_TOKEN: "tok",
    ANILIST_MIN_INTERVAL_MS: "0",
  });
  t.after(close);
  const res = await client.callTool({ name: "add_list_entry", arguments: { mediaId: 1 } });
  assert.equal(res.isError, true, "a null mutation field must still degrade to a tool error");
  const text = (res.content as { type: "text"; text: string }[])[0]?.text;
  assert.ok(text && text.length > 0, "the agent must receive some actionable text, not nothing");
});

test("login_anilist reports a clear error when no client id/secret is configured", async (t) => {
  const { client, close } = await connectServer({});
  t.after(close);
  const res = await client.callTool({ name: "login_anilist", arguments: {} });
  assert.equal(res.isError, true);
  const text = (res.content as { type: "text"; text: string }[])[0]!.text;
  assert.match(text, /ANILIST_CLIENT_ID/);
});
