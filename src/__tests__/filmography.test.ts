// get_character / get_staff / get_studio filmography pagination and filters.
// Fixtures are trimmed copies of real unauthenticated responses for the same
// selections (captured live 2026-10-20, perPage cut to 2 to keep them short;
// `description` text truncated) — see the fixture-accuracy-check skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, mockFetch, installFetch, connectServer } from "./helpers.js";

interface SentBody {
  query: string;
  variables: Record<string, unknown>;
}

const sent = (init: RequestInit | undefined): SentBody =>
  JSON.parse(init?.body as string) as SentBody;

test("get_character forwards filmography page/perPage/type/onList and returns media.pageInfo", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Character: {
          id: 40,
          name: { full: "Luffy Monkey", native: "モンキー・D・ルフィ" },
          image: {
            large: "https://s4.anilist.co/file/anilistcdn/character/large/b40-MNypXsxSRb1R.png",
          },
          favourites: 35998,
          isFavourite: false,
          siteUrl: "https://anilist.co/character/40",
          description: "__Height:__ 174 cm ...",
          media: {
            pageInfo: { hasNextPage: true },
            edges: [
              {
                characterRole: "SUPPORTING",
                node: {
                  id: 103252,
                  title: { romaji: "Shokugeki no Sanji", english: "One Piece: Shokugeki no Sanji" },
                  type: "MANGA",
                  format: "MANGA",
                },
              },
              {
                characterRole: "MAIN",
                node: {
                  id: 30793,
                  title: {
                    romaji: "WANTED! Oda Eiichiro Tanpenshuu",
                    english: "Wanted! Eiichiro Oda Before One Piece",
                  },
                  type: "MANGA",
                  format: "MANGA",
                },
              },
            ],
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
  const res = await client.callTool({
    name: "get_character",
    arguments: { id: 40, page: 2, perPage: 2, type: "MANGA", onList: false },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const body = sent(mock.calls[0]!.init);
  assert.deepEqual(body.variables, { id: 40, page: 2, perPage: 2, type: "MANGA", onList: false });
  assert.match(body.query, /\$type:MediaType/);
  assert.match(body.query, /media\(page: \$page, perPage: \$perPage, [^)]*type: \$type/);
  assert.match(body.query, /pageInfo \{ hasNextPage \}/);
  const character = (
    res.structuredContent as {
      character: { media: { pageInfo: { hasNextPage: boolean }; edges: unknown[] } };
    }
  ).character;
  assert.equal(character.media.pageInfo.hasNextPage, true);
  assert.equal(character.media.edges.length, 2);
});

test("get_character/get_staff leave unset filmography filters out of the request", async (t) => {
  const mock = mockFetch((_url, init) => {
    const { query } = sent(init);
    return jsonResponse({
      data: query.includes("Staff(")
        ? {
            Staff: {
              id: 95185,
              name: { full: "Kana Hanazawa", native: "花澤香菜" },
              image: {
                large: "https://s4.anilist.co/file/anilistcdn/staff/large/n95185-x8ZYvtN7SegC.png",
              },
              primaryOccupations: ["Voice Actor", "Vocalist"],
              favourites: 17287,
              isFavourite: false,
              siteUrl: "https://anilist.co/staff/95185",
              description: "Kana Hanazawa is a Japanese voice actress ...",
              staffMedia: {
                pageInfo: { hasNextPage: true },
                edges: [
                  {
                    staffRole: "Theme Song Performance (OP4)",
                    node: {
                      id: 5081,
                      title: { romaji: "Bakemonogatari", english: "Bakemonogatari" },
                      type: "ANIME",
                      format: "TV",
                    },
                  },
                ],
              },
            },
          }
        : {
            Character: {
              id: 40,
              name: { full: "Luffy Monkey", native: "モンキー・D・ルフィ" },
              image: {
                large: "https://s4.anilist.co/file/anilistcdn/character/large/b40-MNypXsxSRb1R.png",
              },
              favourites: 35998,
              isFavourite: false,
              siteUrl: "https://anilist.co/character/40",
              description: "__Height:__ 174 cm ...",
              media: { pageInfo: { hasNextPage: true }, edges: [] },
            },
          },
    });
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  for (const [name, id] of [
    ["get_character", 40],
    ["get_staff", 95185],
  ] as const) {
    const res = await client.callTool({ name, arguments: { id } });
    assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
  }
  // Defaults only: page 1, the 25 nested-connection ceiling, no type/onList key.
  assert.deepEqual(sent(mock.calls[0]!.init).variables, { id: 40, page: 1, perPage: 25 });
  assert.deepEqual(sent(mock.calls[1]!.init).variables, { id: 95185, page: 1, perPage: 25 });
  assert.match(sent(mock.calls[1]!.init).query, /staffMedia\(page: \$page/);
});

test("get_studio forwards isMain/page/perPage (default perPage 25) on both id and name lookups", async (t) => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Studio: {
          id: 21,
          name: "Studio Ghibli",
          isAnimationStudio: true,
          isFavourite: false,
          siteUrl: "https://anilist.co/studio/21",
          media: {
            pageInfo: { hasNextPage: true },
            nodes: [
              {
                id: 20617,
                title: {
                  romaji: "Sanzoku no Musume Ronja",
                  english: "Ronja, the Robber's Daughter",
                },
              },
              { id: 2617, title: { romaji: "Ghiblies", english: "the GHIBLIES" } },
            ],
          },
        },
      },
    }),
  );
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);

  const byId = await client.callTool({
    name: "get_studio",
    arguments: { id: 21, perPage: 2, isMain: false },
  });
  assert.notEqual(byId.isError, true, JSON.stringify(byId.content));
  const idBody = sent(mock.calls[0]!.init);
  assert.deepEqual(idBody.variables, { id: 21, page: 1, perPage: 2, isMain: false });
  assert.match(idBody.query, /query\(\$id:Int,\$page:Int,\$perPage:Int,\$isMain:Boolean/);
  assert.match(idBody.query, /isMain: \$isMain/);
  const studio = (
    byId.structuredContent as { studio: { media: { pageInfo: { hasNextPage: boolean } } } }
  ).studio;
  assert.equal(studio.media.pageInfo.hasNextPage, true);

  const byName = await client.callTool({ name: "get_studio", arguments: { name: "Ghibli" } });
  assert.notEqual(byName.isError, true, JSON.stringify(byName.content));
  const nameBody = sent(mock.calls[1]!.init);
  assert.deepEqual(nameBody.variables, { search: "Ghibli", page: 1, perPage: 25 });
  assert.match(nameBody.query, /query\(\$search:String,\$page:Int/);
});

test("filmography perPage above AniList's nested 25 ceiling is rejected locally", async (t) => {
  const mock = mockFetch(() => {
    throw new Error("must not be called — perPage > 25 should fail input validation");
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  for (const [name, args] of [
    ["get_character", { id: 40, perPage: 26 }],
    ["get_staff", { id: 95185, perPage: 26 }],
    ["get_studio", { id: 21, perPage: 26 }],
  ] as const) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} should reject perPage 26`);
  }
  assert.equal(mock.calls.length, 0);
});

test('get_staff credits: "voice" selects characterMedia (voice roles) instead of staffMedia', async (t) => {
  // Live 2026-10-20 response for this exact selection (description omitted
  // from the selection there; perPage 2).
  const mock = mockFetch(() =>
    jsonResponse({
      data: {
        Staff: {
          id: 95185,
          name: { full: "Kana Hanazawa", native: "花澤香菜" },
          image: {
            large: "https://s4.anilist.co/file/anilistcdn/staff/large/n95185-x8ZYvtN7SegC.png",
          },
          primaryOccupations: ["Voice Actor", "Vocalist"],
          favourites: 17287,
          isFavourite: false,
          siteUrl: "https://anilist.co/staff/95185",
          characterMedia: {
            pageInfo: { hasNextPage: true },
            edges: [
              {
                characterRole: "SUPPORTING",
                characters: [{ id: 136072, name: { full: "Mitsuri Kanroji" } }],
                node: {
                  id: 101922,
                  title: { romaji: "Kimetsu no Yaiba", english: "Demon Slayer: Kimetsu no Yaiba" },
                  type: "ANIME",
                  format: "TV",
                },
              },
              {
                characterRole: "SUPPORTING",
                characters: [{ id: 88413, name: { full: "Rize Kamishiro" } }],
                node: {
                  id: 20605,
                  title: { romaji: "Tokyo Ghoul", english: "Tokyo Ghoul" },
                  type: "ANIME",
                  format: "TV",
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
    name: "get_staff",
    arguments: { id: 95185, perPage: 2, credits: "voice" },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const body = sent(mock.calls[0]!.init);
  assert.match(body.query, /characterMedia\(page: \$page, perPage: \$perPage/);
  assert.doesNotMatch(body.query, /staffMedia|\$type/, "characterMedia takes no type arg");
  const staff = (
    res.structuredContent as {
      staff: { characterMedia: { edges: { characters: { name: { full: string } }[] }[] } };
    }
  ).staff;
  assert.equal(staff.characterMedia.edges[0]!.characters[0]!.name.full, "Mitsuri Kanroji");
});

test('get_staff rejects `type` with credits: "voice" before any request', async (t) => {
  const mock = mockFetch(() => {
    throw new Error("must not be called");
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({ ANILIST_MIN_INTERVAL_MS: "0" });
  t.after(close);
  const res = await client.callTool({
    name: "get_staff",
    arguments: { id: 95185, credits: "voice", type: "MANGA" },
  });
  assert.equal(res.isError, true);
  assert.match((res.content as { text: string }[])[0]!.text, /only filters production credits/);
  assert.equal(mock.calls.length, 0);
});

test("onList without a login errors instead of returning unfiltered results as the user's list", async (t) => {
  // Confirmed live: unauthenticated, AniList ignores onList entirely.
  const mock = mockFetch(() => {
    throw new Error("must not be called — requireAuth() should gate before any fetch");
  });
  installFetch(t, mock);
  const { client, close } = await connectServer({});
  t.after(close);
  const calls: [string, Record<string, unknown>][] = [
    ["search_media", { type: "ANIME", onList: true }],
    ["get_character", { id: 40, onList: false }],
    ["get_staff", { id: 95185, onList: true }],
    ["get_studio", { id: 21, onList: true }],
  ];
  for (const [name, args] of calls) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} with onList must require login`);
    const text = (res.content as { type: "text"; text: string }[])[0]!.text;
    assert.match(text, /login_anilist|ANILIST_ACCESS_TOKEN/);
  }
  assert.equal(mock.calls.length, 0);
});
