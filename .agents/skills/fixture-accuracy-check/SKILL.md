---
name: fixture-accuracy-check
description: Make sure a mocked-fetch test fixture mirrors AniList's real GraphQL response shape, not just whatever fields make the current code pass. Use before writing or changing a fixture in src/__tests__/*.test.ts.
---

# Testing conventions

`src/__tests__/*.test.ts` mocks `fetch` and feeds it canned JSON fixtures (see
`helpers.ts`'s `mockFetch`/`jsonResponse`/`installFetch`, and `anilist.test.ts`/
`graphql.test.ts` for the patterns). These fixtures are hand-written, which
makes it easy to accidentally encode what the _code_ expects instead of what
_AniList's GraphQL API_ actually returns — a test built that way stays green
even when it's exercising a bug.

## The rule

A fixture must mirror the real response shape for that exact query: only the
fields AniList actually sends for that selection, in the shape it actually
sends them (including `null` for fields the account/media doesn't have — don't
just omit them). Don't add a field because a client module reads it, and
don't reuse a fixture from a similar-looking query — check the actual GraphQL
selection you're mocking.

## AniList-specific shapes worth getting right

- **The nested validation-error envelope.** A GraphQL validation failure comes
  back as `{errors: [{message: "Validation failed", validation: {field:
["reason"]}}]}` — not a flat `message`. A fixture (or a fix) that only
  checks `errors[0].message` will miss real per-field detail; see
  `describeGraphQLError()` in `src/lib/graphql.ts` and its test coverage for
  the shape to mirror.
- **`score` vs `scoreRaw`.** `SaveMediaListEntry`'s `score` field is
  format-dependent (POINT_10, POINT_100, ...); `scoreRaw` is always a literal
  0-100 integer regardless of the account's scoring format. A fixture that
  returns `score` when the mutation variables sent `scoreRaw` (or vice versa)
  will pass a naive assertion while hiding a real conversion bug — see
  `saveListEntry`'s tests in `anilist.test.ts`.
- **`advancedScores` is positional.** The account's advanced-scoring
  categories (`User.mediaListOptions.animeList.advancedScoring` /
  `.mangaList.advancedScoring`) determine array order for `SaveMediaListEntry`'s
  `advancedScores` argument — a fixture with the categories in a different
  order than the account actually has configured would validate the wrong
  thing; see `orderAdvancedScores`'s tests.
- **`Page` can only carry one list field per query** (see
  `docs/api-references.md`'s Pagination section for why) — a fixture
  combining `Page.media` and `Page.characters` in one response would never
  occur for real. That rule is about `Page`'s own sub-selection only;
  combining `Page` with an unrelated aliased root field in the same request
  (e.g. `getSchedule`/`getUserActivity`'s `exists:Media(id:$id){id}` check
  next to `schedule:Page(...)`) is a different, valid pattern — mirror both
  fields' real response shape in that fixture.
- **A fixture testing a defensive/not-yet-observed code path must say so.**
  Some guards (`assertFound()` on a query AniList hasn't been observed
  returning `null` for) exist as insurance against upstream behavior
  changing, not because the null response has been seen live — see
  `getUserProfile`/`getUserStats`/`getFullUserInfo` in `user.ts`. A fixture
  exercising that branch (e.g. mocking `{data: {User: null}}`) is testing the
  guard, not AniList's current live behavior, and must say so in a comment
  right above the mock — otherwise it silently violates the rule above with
  no signal to a future reader that the shape is hypothetical rather than
  confirmed.

## How to verify a fixture

Before writing or changing a fixture for a query:

- If you have `ANILIST_ACCESS_TOKEN` (or `ANILIST_CLIENT_ID`/`ANILIST_CLIENT_SECRET`)
  available, hit the real endpoint once (curl against
  `https://graphql.anilist.co`, or the MCP tools themselves via an agent) and
  check which fields are actually present — don't assume from memory or from
  AniList's docs site, which can lag the real schema.
- If two tools share a query-builder or field fragment (`fields.ts`), write a
  fixture per tool rather than one shared constant, even if they look
  identical today — that's what keeps a future divergence from going
  unnoticed.
- `scripts/check-api.mjs` (`npm run check:api`) hits the live API and is a
  reasonable place to add a minimal shape assertion for a field a unit test
  fixture depends on, if you want drift caught in CI too.
