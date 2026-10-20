import { test } from "node:test";
import assert from "node:assert/strict";
import { connectServer } from "./helpers.js";
import { currentSeason } from "../prompts.js";

function textOf(result: { messages: { content: { type: string; text?: string } }[] }): string {
  return result.messages[0]!.content.text!;
}

test("all 5 prompts are registered", async (t) => {
  const { client, close } = await connectServer({});
  t.after(close);
  const { prompts } = await client.listPrompts();
  const names = prompts.map((p) => p.name).sort();
  assert.deepEqual(names, [
    "catch_up_activity",
    "check_notifications",
    "hidden_gems",
    "recommend_similar",
    "seasonal_overview",
  ]);
});

test("seasonal_overview: no season/year given pins the actual current season+year, not RELEASING", async (t) => {
  // Regression: `status_in: ["RELEASING"]` also matched long-running shows
  // from earlier seasons and missed this season's not-yet-premiered titles.
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 20) });
  const { client, close } = await connectServer({});
  t.after(close);
  const text = textOf(await client.getPrompt({ name: "seasonal_overview", arguments: {} }));
  assert.match(text, /season: "FALL", seasonYear: 2026/);
  assert.ok(!text.includes("RELEASING"), "must not fall back to a status filter");
});

test("seasonal_overview: every argument combination asks for a popularity-sorted, 25-title page", async (t) => {
  // Regression: without an explicit sort, a term-less search_media browses in
  // AniList's default id order (10 per page), so the model was told to pick
  // "highlights" out of the season's 10 lowest-id titles.
  const { client, close } = await connectServer({});
  t.after(close);
  const cases: Record<string, string>[] = [
    {},
    { season: "SPRING" },
    { year: "2020" },
    { season: "WINTER", year: "2020" },
  ];
  for (const args of cases) {
    const text = textOf(await client.getPrompt({ name: "seasonal_overview", arguments: args }));
    assert.match(text, /sort: \["POPULARITY_DESC"\]/, JSON.stringify(args));
    assert.match(text, /perPage: 25/, JSON.stringify(args));
  }
  // One of season/year alone stays an independent filter (not "current season").
  const yearOnly = textOf(
    await client.getPrompt({ name: "seasonal_overview", arguments: { year: "2020" } }),
  );
  assert.match(yearOnly, /type: "ANIME", seasonYear: 2020, sort/);
  const seasonOnly = textOf(
    await client.getPrompt({ name: "seasonal_overview", arguments: { season: "SPRING" } }),
  );
  assert.match(seasonOnly, /type: "ANIME", season: "SPRING", sort/);
});

test("currentSeason maps calendar quarters (UTC) onto AniList's MediaSeason", () => {
  const at = (iso: string) => currentSeason(new Date(iso));
  assert.deepEqual(at("2026-01-01T00:00:00Z"), { season: "WINTER", year: 2026 });
  assert.deepEqual(at("2026-03-31T23:59:59Z"), { season: "WINTER", year: 2026 });
  assert.deepEqual(at("2026-04-01T00:00:00Z"), { season: "SPRING", year: 2026 });
  assert.deepEqual(at("2026-07-15T00:00:00Z"), { season: "SUMMER", year: 2026 });
  assert.deepEqual(at("2026-12-31T23:59:59Z"), { season: "FALL", year: 2026 });
  // UTC, not local time: this instant is already 2027 in Tokyo.
  assert.deepEqual(at("2026-12-31T20:00:00Z"), { season: "FALL", year: 2026 });
});

test("seasonal_overview: an explicit past/future season+year must NOT filter to RELEASING", async (t) => {
  const { client, close } = await connectServer({});
  t.after(close);
  const result = await client.getPrompt({
    name: "seasonal_overview",
    arguments: { season: "WINTER", year: "2020" },
  });
  const text = textOf(result);
  // Regression: a past season's titles are long since FINISHED, so filtering
  // to RELEASING here would tell the model to search for something that can
  // never match.
  assert.ok(
    !text.includes('status_in: ["RELEASING"]'),
    "an explicit past/future season must not be filtered to RELEASING",
  );
  assert.match(text, /season: "WINTER", seasonYear: 2020/);
});

test("catch_up_activity checks both the anime AND manga CURRENT list groups", async (t) => {
  const { client, close } = await connectServer({});
  t.after(close);
  const result = await client.getPrompt({
    name: "catch_up_activity",
    arguments: { user: "Grinv" },
  });
  const text = textOf(result);
  assert.match(text, /type: "ANIME"/);
  assert.match(text, /type: "MANGA"/);
});

test("catch_up_activity passes a numeric user ID as a number and a username as a string", async (t) => {
  // Regression: a quoted "12345" went down the tools' username branch and
  // looked up a user *named* 12345 (not_found).
  const { client, close } = await connectServer({});
  t.after(close);
  const byId = textOf(
    await client.getPrompt({ name: "catch_up_activity", arguments: { user: "12345" } }),
  );
  assert.match(byId, /`user: 12345`/);
  const byName = textOf(
    await client.getPrompt({ name: "catch_up_activity", arguments: { user: "Grinv" } }),
  );
  assert.match(byName, /`user: "Grinv"`/);
});

test("check_notifications passes markAsRead through only when explicitly requested", async (t) => {
  const { client, close } = await connectServer({});
  t.after(close);

  const withoutMarkAsRead = textOf(
    await client.getPrompt({ name: "check_notifications", arguments: {} }),
  );
  assert.ok(!withoutMarkAsRead.includes("markAsRead"), "must not opt into markAsRead by default");

  const withMarkAsRead = textOf(
    await client.getPrompt({
      name: "check_notifications",
      arguments: { markAsRead: "true" },
    }),
  );
  assert.match(withMarkAsRead, /markAsRead: true/);
});

test("hidden_gems pins an explicit sort and score/popularity filters", async (t) => {
  const { client, close } = await connectServer({});
  t.after(close);

  // Regression: a term-less search_media with no explicit sort browses in
  // AniList's own default (id) order, so a plan that only asked for
  // perPage: 25 had the model picking "underrated" titles out of the 25
  // oldest entries in the catalog, whatever their score.
  const cases: Record<string, string>[] = [{}, { type: "MANGA" }, { genre: "Mecha" }];
  for (const args of cases) {
    const text = textOf(await client.getPrompt({ name: "hidden_gems", arguments: args }));
    assert.match(text, /sort: \["SCORE_DESC"\]/, `missing sort for ${JSON.stringify(args)}`);
    assert.match(
      text,
      /averageScore_greater: \d+/,
      `missing score floor for ${JSON.stringify(args)}`,
    );
    assert.match(
      text,
      /popularity_lesser: \d+/,
      `missing popularity cap for ${JSON.stringify(args)}`,
    );
  }

  const withGenre = textOf(
    await client.getPrompt({ name: "hidden_gems", arguments: { genre: "Mecha" } }),
  );
  assert.match(withGenre, /genres: \["Mecha"\]/);
});
