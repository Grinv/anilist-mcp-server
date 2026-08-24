---
name: live-audit
description: Audit anilist-mcp-server — build/test/lint gate, live MCP tool edge-case sweep (input validation, not-found paths, mutations with capture/revert), source-level code review, and docs/metadata consistency. Use when asked to test/audit the published or just-fixed anilist-mcp-server package, hunt for bugs/edge cases, or repeat "the same kind of testing as before."
---

# live-audit — anilist-mcp-server health check + edge-case hunt

Repo-specific playbook, for any agent/model working on this repo (not tied to
a particular harness — see `AGENTS.md`'s own agent-agnostic framing). Use it
when asked to test/audit the published or just-fixed anilist-mcp-server
package, hunt for bugs/edge cases, or repeat "the same kind of testing as
before." Sibling repos (`tmdb-mcp`, `mal-mcp`, `steam-games-mcp`) keep their
own `live-audit/SKILL.md` — when either this file or a sibling's improves,
sync the useful parts both ways rather than letting them drift.

Goal: find real bugs/inaccuracies in the live tool behavior (against the real
AniList API) and in the source, then fix what's found. Read `AGENTS.md` first
if it's not already in context — every fix must follow its conventions
(`guard()`/never-throw, `requireAuth()` placement, `outputSchema` precision,
commit author/no-Co-Authored-By, etc.).

This assumes the server is already reachable as an MCP connection in your
current session (e.g. as `mcp__anilist__*` tools in Claude Code). If it isn't
connected, connect it first rather than skipping straight to step 1.

## Contents

- 0. Confirm "published"/"fixed" actually means what you think it means
- 1. Static pass first (cheap, catches regressions before you burn API calls)
- 2. Safety rules for live testing (read before calling anything)
- 3. Live edge-case sweep
- 4. Source-level code review
- 5. Docs/metadata consistency
- 6. Report, then fix only what's confirmed
- 7. Commit + changelog, if asked

## 0. Confirm "published"/"fixed" actually means what you think it means

```sh
node -p "require('./package.json').version"; npm view anilist-mcp-server version; git log --oneline -5
```

If `package.json`'s version matches the npm-published version, live-testing
the running tools _is_ testing the published package. If you've since made
local fixes, remember the running MCP server is a **separate process** from
your edits — stdio servers don't hot-reload. Ask for a restart before
trusting a live call against fixed code, and state plainly whether findings
apply to the published package or to fixed-but-unreleased/unrestarted code.

## 1. Static pass first (cheap, catches regressions before you burn API calls)

```sh
npm run build && npm test && npm run lint && npm run format:check
```

All green is a **baseline, not proof of correctness** — it only confirms
nothing already-covered regressed. It says nothing about whether the
interesting logic (error/exception branches especially) is covered at all.
Every bug found in past passes of this audit lived in exactly what line
coverage doesn't scrutinize: `assertFound()`-style null checks with no test
ever passing a bad ID, `messageFor()`'s per-error-code branches with no test
checking the specific detail message survives, and edge-case argument
combinations (a prompt arg that's individually optional but breaks when
given alone). `npm run test:coverage` (~80% gate) measures lines executed,
not whether the assertions on those lines are meaningful. When reviewing or
writing tests as part of this audit, ask: does a test exist that
deliberately triggers this error path, and does it assert on the _specific_
resulting message/shape (not just "an error was thrown")? Same question for
protocol era: every test/live probe defaults to the legacy (2025) wire
unless it explicitly opts into `versionNegotiation: { mode: 'auto' }` —
don't stop at one smoke test confirming `getProtocolEra() === 'modern'`
negotiates; the audit's substantive checks (error-path assertions,
edge-case responses, cache-hint fields) need re-running under **both**
legacy and modern clients, since wire encoding differs by era and a
regression can hide in either path alone (confirmed gap: this repo's whole
suite was legacy-only until one e2e test added the opt-in, and even that
test only checked tool count under modern era, not deep behavior).

Anything red here is the actual finding — stop and report it before moving
to live testing.

## 2. Safety rules for live testing (read before calling anything)

- **A real authenticated AniList account may be wired into the session.**
  Check with `get_authorized_user` before doing anything else. If it
  succeeds, every mutation call below acts on a real person's real account —
  favourites, list entries, follows, activity posts, forum threads/comments,
  and profile settings are all publicly visible or persisted.
- **Read-only tools** (`search_*`, `get_*`) are always safe to call freely —
  no special permission needed.
- **Mutation tools** (`add_/update_/remove_/delete_/post_/toggle_follow_/
toggle_favourite`, `update_user`) require the user's explicit go-ahead before this pass
  touches them. If they say "test mutations too, just revert after" (or
  similar), run the `mutation-test-safety` skill's contract for every
  mutation call — its self-message/self-created-post exception is the only
  case where targeting a "real user" is fine (that user is the caller).
- Do not call `login_anilist`/`submit_anilist_redirect` live — re-running the
  OAuth flow can disrupt the session's already-configured credentials and
  isn't meaningfully revertible.
- `get_notifications` may mark things as read upstream — call it once, not
  repeatedly.

## 3. Live edge-case sweep

Batch independent tool calls together where your harness supports it — this
is slow one-at-a-time. But don't trust positional matching of results back to
calls in a large batch (especially many calls to the same tool name) as proof
of a bug — a surprising-looking result there is unconfirmed until you re-run
that one call in isolation; treat it the same as any other unverified
hypothesis. Adapt ids/tools to whatever's currently registered
(`grep -n 'registerTool(' src/tools/*.ts`), don't just replay last run's exact
calls verbatim. Split into independent workstreams if your environment
supports concurrent subagents/background tasks.

- **Input validation boundaries**: empty string where `.min(1)` is expected,
  negative/zero/decimal/way-past-int32 ids, `page`/`perPage` at their
  boundary and one past it, batch `ids` at their `.min()` boundary, an
  unknown/misspelled param name.
- **Cross-field pairing rules**: fields AniList silently no-ops or rejects
  depending on a sibling field — `notificationOptions`/`disabledListActivity`
  requiring ALL types/statuses every call (not a partial update), an
  `advancedScores` category name that doesn't match the account's configured
  list, `season`/`seasonYear` used alone vs. together (independent filters,
  not a mandatory pair). These must behave as the tool's own description
  promises, not silently mis-apply.
- **Not-found / empty-result paths**: nonexistent-but-well-formed ids across
  every domain (media, character, staff, studio, thread, activity,
  recommendation, user), a batch call mixing valid + invalid + duplicate
  ids, a search returning zero results, mismatched enum/type args (e.g. a
  manga id queried as type ANIME).
- **Payload-size risk**: anything that aggregates a variable-size collection
  — `get_media_tags` (fetches AniList's full ~425-tag list per call even
  though only a page is returned), `streamingEpisodes`, a very active
  account's `get_user_list`/`get_user_activity`, or a batch-`ids`-style array
  param with `.min()` but no `.max()` (grep for `${...length}`/`${...size}`
  interpolated into a query — a live check with a 100+-item array once found
  `get_media`'s `ids` had no server-side or client-side cap either). Check the
  actual response size/token count for the largest realistic case, not just
  that it returns _something_. Also diff each shared `fields.ts` fragment
  against every query using it: a long free-text field (`description`,
  `about`, `body`) belongs in the DETAIL fragment, and a fragment reused as
  both the single-item and the many-rows-per-page selection silently puts it
  on every row (confirmed: `CHARACTER_FIELDS`/`STAFF_FIELDS` carried a bio
  worth 57-85% of `search_character`/`search_staff`/`get_todays_birthdays`'s
  whole payload, while `MEDIA_FIELDS` correctly excluded a synopsis).
- **Documented vs. actual shape**: for anything that looks surprising live,
  grep the field back to its `.describe()` text — does the tool's own
  description promise what you just saw (or promise something you didn't)?
  Mismatches here are bugs even when the data itself is "correct."
- **Unicode / adult / locale / injection-shaped input**: emoji-only queries,
  non-Latin scripts, `sfw`/adult-content toggling, whitespace-only terms,
  SQL/GraphQL-injection-shaped strings (e.g. `"OR 1=1 --"` — this has
  triggered an upstream WAF 403 on search tools before; check the error
  message doesn't misattribute it to account permissions just because a
  token happened to be attached).
- **Live prompt testing**: run the `prompt-check` skill against every prompt
  in `src/prompts.ts` — a static read comparing prompt text against tool
  names/params misses argument-handling bugs that only show up when actually
  rendered through the real MCP protocol.
- **Systematic input-schema fuzzing** across every tool: wrong JS types,
  invalid enums, missing required fields, malformed nested objects (e.g. a
  date field), extremely long strings. Only flag a genuine problem — an
  unhandled exception/stack trace, a confusing validation message, or
  (worse) malformed input silently accepted and producing a wrong result. A
  clean, expected Zod validation error is correct behavior, not a finding.
- **Protocol-era parity**: the session's own connected `mcp__anilist__*`
  tools negotiate whatever era the host picked — you don't control it from
  there. To actually compare legacy vs. modern wire behavior, spin up a
  throwaway script against the built `dist/index.js` using
  `@modelcontextprotocol/client`'s `Client`/`StdioClientTransport` directly:
  one client with default options (legacy), one with
  `versionNegotiation: { mode: 'auto' }` (modern); re-run the same
  representative calls (a normal success, a not-found id, a validation
  error) through both and diff the results, ignoring the expected wire-only
  additions (`_meta`, `ttlMs`, `cacheScope` on cacheable list operations) —
  any other divergence is a real finding.

For anything that looks like a bug, **don't stop at the symptom** — grep the
source for the actual mechanism (the query shape/const/regex that produced
it) before calling it a finding. A live response that merely _looks_ odd but
ties back to correct, intentional code isn't a finding.

The same caution runs the other way: a finding produced by reading source
_without_ calling any live tool (e.g. a background/sub-agent doing a
static-only pass) is a hypothesis, not a confirmed bug — AniList's actual
behavior sometimes contradicts what the code's shape implies. Concrete
case: a static pass once flagged `getUserProfile`/`getUserStats`/
`getFullUserInfo` as crashing (missing `assertFound()` on a nullable
singular lookup, by analogy with every sibling function that needs it) —
live-calling `get_user_profile`/`get_user_stats`/`get_full_user_info` with a
nonexistent numeric id **and** a nonexistent username both showed AniList
actually 404s the whole HTTP response for `User(...)` instead of returning
`200` + `null`, so the "bug" didn't reproduce. Before reporting any
source-only finding, spend one live call confirming the actual response
shape it depends on.

## 4. Source-level code review

Sweep every file under `src/tools/`, `src/clients/anilist/`, and `src/lib/`
(lighter pass on the last group unless something specific points there) for:

- A shared Zod constant's `.describe()`/error text that references a
  specific field name (e.g. `id` vs `ids`) that doesn't match at every call
  site.
- A tool whose field name for a concept diverges from every sibling tool
  handling the same concept (e.g. `search_activity`'s `userId` vs every
  other user-scoped tool's `user`, from `userIdOrName`) — grep the shared
  schema constant's usage sites and diff the field names at each call site,
  don't just check that each one individually looks reasonable. This bug
  class can't be caught by testing well-formed values (every call site
  works fine on its own) or by a clean-error check (no schema in this
  codebase is `.strict()`, so a plausible-but-wrong name is silently
  dropped as an unrecognized key instead of erroring) — the tool then quietly
  falls back to whatever its field being _absent_ means (e.g. an unfiltered
  global feed), which looks like a legitimate result, not a bug, unless you
  already know what the correctly-filtered result should look like. Confirmed
  live: `search_activity({user: <id>})` silently returned the global feed
  instead of erroring or filtering, because the real field is `userId`.
  Same diff-don't-review-in-isolation method applies to describe-TEXT depth,
  not just field names: two tools independently duplicating a same-named
  field (e.g. `add_list_entry`/`update_list_entry`'s `customLists`) can drift
  when a behavioral disclosure is added to one and not the other — see the
  `tool-description-check` skill's full-replace-vs-partial-merge bullet for
  the confirmed case.
- A GraphQL query whose single-resource lookup returns AniList's `null`
  instead of erroring — check whether the client function dereferences it
  unguarded (`data.Media.stats` with no null check) instead of using
  `assertFound()` (`lib/errors.ts`). This bites nested connection fields
  (`Media(id){ characters {...} }`) even when a bare `Media(id){ id }` query
  for the same ID reliably 404s — don't assume one implies the other; check
  every function that shares the query shape (a crash found in one function
  often has 3-5 siblings with the identical bug, including ones fixed in a
  previous pass of this same audit).
- A `Page`-based connection (`Page(...) { someConnection(parentId) }`) that
  returns an empty-but-successful page for a nonexistent parent ID instead
  of erroring, indistinguishable from "genuinely zero results". Separately,
  a connection's own node id isn't guaranteed to resolve via that node
  type's equivalent root lookup — confirmed live (raw `curl`, no auth) that
  most `Media(id){recommendations{nodes{id}}}` ids 404 on root
  `Recommendation(id)`; verify any "use tool A's output as tool B's input"
  workflow actually round-trips before documenting it as reliable. Also flag a
  function that's already correctness-safe via a _separate_ existence-check
  request instead of an aliased one — `getThreadComments`/`getSchedule`/
  `getUserActivity` all share this pattern via `fields.ts`'s
  `existsFragment()` helper as of a later refactor, so check any _new_
  function with this shape against that helper instead of hand-rolling the
  fragment again — same inefficiency this bullet targets, just not a
  correctness bug. Fix by aliasing a cheap singular existence check (e.g.
  `exists:Media(id:$id){id}`) into the _same_ request as the real query, not
  a separate round-trip —
  confirmed live (`docs/api-references.md`) that AniList 404s the _entire_
  response when one aliased root field fails to resolve, even combined with
  unrelated fields in the same query, so this costs no extra request and
  still surfaces a clean `not_found`. Only fall back to a genuinely separate
  existence-check request when the real query has an actual data dependency
  the existence check doesn't already satisfy (e.g. resolving a _username_
  to a numeric id before it can be used as a filter argument elsewhere in
  the same query — GraphQL can't thread one field's result into another
  field's argument within a single request). Verify the aliasing approach
  live with a raw `curl -X POST https://graphql.anilist.co` call before
  relying on it (no auth needed for public data) — this behavior isn't
  something the MCP tools' pre-built queries let you probe directly.
- Missing bounds on a numeric field whose `.describe()` promises a range
  (e.g. "0-10 scale") but whose Zod schema has no `.min()/.max()`. Same
  scrutiny in the other direction for a bound just _added_: a
  plausible-sounding one (`.positive()` on "an episode number") can be
  live-verified wrong — confirmed case: AniList's `AiringSchedule.episode`
  returns `0` — and a URL/config field tightened for one AniList-owned
  case (`z.httpUrl()`'s hostname check) can break a _user-configurable_
  override meant to accept `localhost`/an IP (`ANILIST_GRAPHQL_URL`).
  Check every new bound against real data/the documented use case, not
  just that it "sounds right."
- A `.refine()` that promises "every one of N values exactly once" but only
  checks `new Set(arr.map(...)).size === N` — that passes for an array
  _longer_ than N with one value duplicated and none omitted, since it never
  checks `arr.length === N` too. Confirmed live in exactly this shape on
  `update_user`'s `notificationOptions`/`disabledListActivity`.
- A union/required field with no custom Zod error message, falling back to
  a generic "Invalid input" instead of something actionable. Also check the
  inverse: a custom error given as a plain _string_ (`z.union([...], {error:
"X is required — ..."})`) fires for every union-mismatch reason alike, so a
  wrongly-typed-but-present value (e.g. a decimal where an int is expected)
  gets told "is required" too — misleading since something WAS passed. Fix
  by branching a function-based `error` on `issue.input === undefined`
  (confirmed live: `get_media({type:"ANIME", ids: 1.5})` and omitting `ids`
  entirely produced the identical "ids is required" message).
- `lib/result.ts`'s `messageFor()` — does every error code's branch actually
  surface the specific `err.message` a caller threw, or does a generic
  per-code string silently discard it?
- 401/403 messages that confidently blame "the account" or "the token" even
  when the same code path can also fire for an unrelated reason (e.g. an
  upstream WAF/security block) — especially on tools/queries that don't
  require auth at all, where a token might still be attached incidentally.
- An error message interpolating a field that can legitimately be empty,
  leaving a stray separator — read the actual rendered string, not the
  template (confirmed: `HTTP ${status} ${statusText}: ${detail}` printed
  "HTTP 404 : Not Found." wherever `statusText` came back empty, which is
  runtime-dependent, so a direct `dist/index.js` run can hide it).
- AGENTS.md convention violations: tool failures must go through `guard()`,
  never throw raw; mutation/personal tools must call `ctx.requireAuth()`
  before any network call; `outputSchema` must model top-level keys
  precisely but stay loose enough not to reject a legitimate real API
  response shape.

## 5. Docs/metadata consistency

Run the `docs-consistency-check` skill.

## 6. Report, then fix only what's confirmed

Rank findings by severity. For each: what's wrong, concrete repro (exact
tool call + params), the file/line causing it, and the fix shape. Silence on
a category you didn't get to (rather than implying full coverage) beats a
false "all clear." Then run the `self-learning` skill against each confirmed
finding.

If asked to fix: implement the smallest correct change, add/extend a test in
the matching `src/__tests__/*.test.ts` (mirror the existing test's style in
that file, per the `fixture-accuracy-check` skill for any mocked-fetch
fixture), then re-run the full `build && test && lint && format:check`
gate before calling it done. Re-verify live only after the running MCP
server process has been restarted (it won't pick up source changes on its
own) — build/test passing is necessary but re-confirming actual live
behavior changed is stronger evidence than trusting the diff alone.

## 7. Commit + changelog, if asked

One `fix:`/`feat:` commit per logically distinct change (don't bundle two
unrelated fixes into one commit), then a separate `docs:` commit adding to
`CHANGELOG.md`'s `[Unreleased]` section (style: the `changelog-style` skill)
with one bullet per fix, each linking that fix commit's short sha
(`https://github.com/Grinv/anilist-mcp-server/commit/<7-char-sha>`).
Author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`, **no**
`Co-Authored-By` trailer (AGENTS.md's commit convention). Don't push unless
explicitly asked.
