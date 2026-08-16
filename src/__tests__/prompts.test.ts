import { test } from "node:test";
import assert from "node:assert/strict";
import { connectServer } from "./helpers.js";

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

test("seasonal_overview: no season/year given filters to RELEASING (defines 'current season')", async (t) => {
  const { client, close } = await connectServer({});
  t.after(close);
  const result = await client.getPrompt({ name: "seasonal_overview", arguments: {} });
  const text = textOf(result);
  assert.match(text, /status_in: \["RELEASING"\]/);
  assert.ok(!text.includes("seasonYear"), "no season/year given must not add season args");
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
