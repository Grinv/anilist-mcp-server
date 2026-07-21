# AGENTS.md

Single source of truth for working on this repository — for **any** model or
agent. `CLAUDE.md` only links here (`@AGENTS.md`); keep all shared guidance in
this file, not in CLAUDE.md. (For end-user/runtime docs, see [README.md](README.md).)

## Project shape

A TypeScript MCP server for the [AniList](https://anilist.co) GraphQL API.
Reads (search/details/genres/tags/recommendations/threads/activity/public user
data) call the public GraphQL endpoint directly and need no credentials.
Personal-list and social tools (add/update/remove list entries, favourites,
follow, posting/deleting activity or threads, `update_user`, `get_notifications`)
act on the authenticated user's own AniList account and require a user access token —
see [docs/auth.md](docs/auth.md) for the OAuth model and [docs/api-references.md](docs/api-references.md)
for AniList's API specifics (rate limits, mutation semantics, considerations)
before changing the client.

```
src/
  index.ts        # bin entry — calls start()
  server.ts       # buildServer() + start(); registers everything
  config.ts       # env → validated Config (zod)
  lib/            # http, rateLimit, cache, tokenStore, oauthLogin, errors, logger,
                  # result, graphql (the GraphQL request/error-mapping layer)
  clients/        # anilist.ts — thin AniListClient facade (auth/config/login,
                  # exposes ctx(): AniListContext); anilist/*.ts — one file per
                  # domain (activity, context, favourites, fields, list, media,
                  # misc, notification, people, recommendation, search, thread,
                  # user), matching src/tools/*. Tool handlers call these
                  # domain functions directly (e.g. `media.getMedia(client.ctx(), ...)`)
                  # rather than through a same-named method on AniListClient.
  tools/          # misc.ts, activity.ts, list.ts, media.ts, notification.ts,
                  # people.ts, recommendation.ts, search.ts, thread.ts, user.ts,
                  # login.ts, guard.ts (never-throw wrapper), outputSchemas.ts
                  # (shared output-schema fragments)
  prompts.ts      # MCP Prompts: multi-step plans that orchestrate the read tools
  __tests__/      # node:test (*.test.ts) + helpers.ts
scripts/          # build-tests.mjs, run-tests.mjs, check-api.mjs, sync-version.mjs
```

## Why this server exists

The pre-existing third-party `anilist-mcp` (npm) cannot write list entries at
all — its `add_list_entry`/`update_list_entry` require nested-object input
fields, but its GraphQL-mutation builder throws on any nested value (a
confirmed upstream bug, [anilist-mcp#13](https://github.com/yuna0x0/anilist-mcp/issues/13)).
This server avoids that whole bug class by talking to AniList's GraphQL API
directly through a small first-party client (`lib/graphql.ts` +
`clients/anilist.ts`) instead of a third-party wrapper library: it builds its
own `variables` object and only includes keys that are actually set — GraphQL
naturally omits absent optional arguments, no dummy placeholder values needed.

## Commands

```sh
npm run build          # tsc --noEmit + tsup → dist/index.js (single ESM bundle)
npm test               # build tests with esbuild, run with node:test
npm run test:coverage  # same, with coverage (gate: ~80%)
npm run lint           # eslint
npm run format         # prettier --write
npm run check:api      # live upstream health-check (network)
```

## Conventions

- **Docs and in-code text are English** (README, docs, comments, tool
  descriptions, error messages).
- Runtime floor is **Node ≥ 20** (global `fetch`); tsup targets `node20`. Tests
  may run on newer Node but must not raise the runtime floor.
- Log to **stderr only** — stdout is the MCP protocol channel. Use the logger;
  it redacts credentials.
- Tool failures return `{ isError: true }` results (via `guard()` / `result.ts`),
  never thrown — the agent should get an actionable message. Mutation/personal
  tools are gated by `ctx.requireAuth()` (defined in `clients/anilist/context.ts`,
  implemented in `clients/anilist.ts`), called at the top of each domain
  function that needs it — it throws an actionable `ApiError` before any
  network call rather than making a doomed authenticated request.
- Write tool `description`s and per-field `.describe()` text for the calling
  model: explain when to use a tool and what each parameter means. Check new
  or edited descriptions against [docs/tool-descriptions.md](docs/tool-descriptions.md)
  (Glama's TDQS rubric) before committing.
- Every tool declares an `outputSchema` alongside `inputSchema`, describing the
  `structuredContent` shape `jsonResult()` returns. Model top-level keys
  precisely; for arrays of AniList media/character/staff/etc. objects and
  other deeply-nested GraphQL substructures, a loose `.passthrough()`/
  `z.unknown()` shape is fine — the SDK validates `structuredContent` against
  `outputSchema` at runtime, so a schema that's too strict fails real tool
  calls (a good signal, not just a style nit).
- Mocked-`fetch` test fixtures must mirror the real upstream response shape
  for that exact query, not just whatever fields make the current code
  pass — see [docs/testing.md](docs/testing.md).
- **Schema-first for hand-built internal shapes** (config, persisted state —
  not GraphQL passthrough objects, which stay loose per the `outputSchema`
  rule above): when a type describes an object the code itself constructs
  from external input (env vars, an on-disk file, an OAuth response), define
  the Zod schema first and derive the type via `z.infer<typeof Schema>`, then
  build the value through `schema.parse()`/`.safeParse()`/`.transform()`
  rather than a hand-written `interface` kept in sync by convention with a
  separately-built object literal — see `Config`/`AniListAuth`
  (`config.ts`) and `TokenState` (`lib/tokenStore.ts`). This is a house style
  going forward, not (yet) retrofitted onto every existing hand-written
  interface over external input (e.g. `GraphQLResponse<T>` in
  `lib/graphql.ts` still isn't converted) — migrate an existing one
  opportunistically when you're already touching it, don't do a
  drive-by rewrite.
- Keep dependencies minimal. New deps need a clear justification (supply-chain).
- **Plain-JS tooling files** (`scripts/*.mjs`, `eslint.config.mjs`) still get
  type-checked — add `// @ts-check` + JSDoc annotations rather than leaving
  them untyped. They run directly via `node`/`eslint` (not through tsup), so
  they're checked via a separate `tsconfig.scripts.json` (`npm run
typecheck:scripts`, folded into `npm run lint`) instead of the main
  `tsconfig.json`, which only covers `src/`.
- **Never commit secrets.** Credentials come from env vars, the `login_anilist`
  OAuth flow, or the on-disk token store (`tokenStore.ts`, `0600`) — never
  hardcoded or committed. Unlike MAL, AniList issues a `client_secret` for
  every app (no "public vs confidential app type" pitfall) and does **not**
  support refresh tokens — access tokens are long-lived JWTs (~1 year);
  re-authentication via `login_anilist` is the only way to renew one.
- **MCP SDK**: this project intentionally runs on **`@modelcontextprotocol/server`
  v2 beta** (`2.0.0-beta.x`, pinned exact — not a `^range`) ahead of the sibling
  servers (`mal-mcp`/`tmdb-mcp`/`steam-games-mcp`, all still on v1). Bump to the
  first stable `2.0.0` once the 2026-07-28 MCP spec/SDK ships GA, re-running the
  full test suite (including `e2e.test.ts`, which drives the real built bundle)
  before merging that bump.
- **No `logging` MCP capability.** `notifications/message`/`logging/setLevel`
  were deprecated in protocol version 2026-07-28 (SEP-2577) in favor of
  stderr/OpenTelemetry — which `lib/logger.ts` already does (stderr-only,
  redacted). Don't re-add the capability; if a future need for structured
  client-visible logs comes up, look at whatever SEP-2577's eventual
  replacement is, not the deprecated push-style API. The same applies to
  sampling/elicitation/roots (also deprecated in that revision) — none of
  them are used here, and the deprecated push-style versions aren't worth
  building on.
- Cross-platform: macOS, Linux and Windows. Avoid POSIX-only shell in npm
  scripts (use the Node helper scripts).
- **Commits:** author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`;
  do **not** add a `Co-Authored-By` trailer.
- **CodeQL** (`.github/workflows/codeql.yml`) scans `javascript-typescript` on
  push/PR to main plus a weekly cron — no local equivalent command; findings
  surface under the repo's **Security → Code scanning** tab.

## Before opening a PR

Run `npm run build && npm test && npm run lint && npm run format:check`.
Update `CHANGELOG.md` (Unreleased section) — see
[docs/changelog-style.md](docs/changelog-style.md) for entry style.

## Releasing

`package.json` is the single source of truth for the version; `npm version`
bumps + syncs every derived file + tags the release. See
[docs/releasing.md](docs/releasing.md) for the full steps and MCP Registry details.

## Reuse / shared architecture

This server follows the same reusable shape as its siblings: a generic
carcass (`src/lib/` + build tooling, tests infra, CI) and a thin domain layer
(`config.ts`, `clients/`, domain `tools/`, `prompts.ts`, `check-api.mjs`),
bootstrapped from the **`mcp-server-template`** repository. Extract `lib/`
into a shared npm package only once cross-server duplication actually hurts
(YAGNI) — not before.
