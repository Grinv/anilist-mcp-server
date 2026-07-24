# live-audit — anilist-mcp-server health check + edge-case hunt

Repo-specific playbook, for any agent/model working on this repo (not tied to
a particular harness — see `AGENTS.md`'s own agent-agnostic framing). Use it
when asked to test/audit the published or just-fixed anilist-mcp-server
package, hunt for bugs/edge cases, or repeat "the same kind of testing as
before." Sibling repos (`tmdb-mcp`, `mal-mcp`, `steam-games-mcp`) keep their
own `skills/live-audit/SKILL.md` — when either this file or a sibling's
improves, sync the useful parts both ways rather than letting them drift.

Goal: find real bugs/inaccuracies in the live tool behavior (against the real
AniList API) and in the source, then fix what's found. Read `AGENTS.md` first
if it's not already in context — every fix must follow its conventions
(`guard()`/never-throw, `requireAuth()` placement, `outputSchema` precision,
commit author/no-Co-Authored-By, etc.).

This assumes the server is already reachable as an MCP connection in your
current session (e.g. as `mcp__anilist__*` tools in Claude Code). If it isn't
connected, connect it first rather than skipping straight to step 1.

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
resulting message/shape (not just "an error was thrown")?

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
- **Mutation tools** (`add_/update_/remove_/delete_/post_/follow_/favourite`,
  `update_user`) require the user's explicit go-ahead before this pass
  touches them. If they say "test mutations too, just revert after" (or
  similar), proceed under this contract for every mutation call:
  1. Capture the exact pre-state first (e.g. `get_authorized_user`,
     `get_media`'s `mediaListEntry`/`isFavourite`, `get_user_profile`'s
     `isFollowing`) — not just an assumption of what it probably is.
  2. Make the smallest possible change that still exercises the behavior.
  3. Verify the change landed (a mutation's own echoed response is not
     always trustworthy — e.g. `update_user` has historically omitted
     fields it actually changed — so re-fetch via a read tool).
  4. Revert to the captured pre-state immediately, in the same turn, and
     verify the revert too. Don't batch five mutations and revert at the
     end — revert each one before moving to the next unrelated test.
  5. Never send message-activity/forum posts to an uninvolved third party —
     self-message (`recipientId` = the caller's own id) and self-created,
     immediately-deleted test threads/comments are fine; pinging a random
     other real user is not.
  6. Never leave the account in a different state than you found it, even
     if a step errors partway through — check and clean up regardless.
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
  account's `get_user_list`/`get_user_activity`. Check the actual response
  size/token count for the largest realistic case, not just that it returns
  _something_.
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
- **Live prompt testing** (`src/prompts.ts`) — a static read comparing prompt
  text against tool names/params misses argument-handling bugs. Actually
  render every prompt through the real MCP protocol:
  `npx @modelcontextprotocol/inspector --cli node dist/index.js --method
prompts/list`, then `--method prompts/get --prompt-name <name>
--prompt-args key=value key2=value2` (space-separated `key=value` pairs,
  NOT a JSON blob — the CLI rejects JSON with "Invalid parameter format").
  Run each prompt with no args, with only one of several optional args set
  at a time, and with all of them set — an argument that's individually
  optional can still have a bug that only shows up when given alone (e.g. a
  prompt silently ignoring `year` because its branching logic required
  `season` to also be present, even though the two are independent filters
  on the underlying tool). Read-only, no-account-risk — never route it
  through anything that touches mutations.
- **Systematic input-schema fuzzing** across every tool: wrong JS types,
  invalid enums, missing required fields, malformed nested objects (e.g. a
  date field), extremely long strings. Only flag a genuine problem — an
  unhandled exception/stack trace, a confusing validation message, or
  (worse) malformed input silently accepted and producing a wrong result. A
  clean, expected Zod validation error is correct behavior, not a finding.

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
  of erroring, indistinguishable from "genuinely zero results". Fix by
  aliasing a cheap singular existence check (e.g. `exists:Media(id:$id){id}`)
  into the _same_ request as the real query, not a separate round-trip —
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
  (e.g. "0-10 scale") but whose Zod schema has no `.min()/.max()`.
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
- AGENTS.md convention violations: tool failures must go through `guard()`,
  never throw raw; mutation/personal tools must call `ctx.requireAuth()`
  before any network call; `outputSchema` must model top-level keys
  precisely but stay loose enough not to reject a legitimate real API
  response shape.

## 5. Docs/metadata consistency

Check every one of these, not just a sample:

- `README.md`'s tool table matches `src/server.ts`'s registrations (names,
  and the permission/auth column against each tool's actual `requireAuth()`
  usage).
- `manifest.json`'s and `server.json`'s `tools` arrays list the same tool
  **names** as what's actually registered (`npm test` already asserts this
  via `e2e.test.ts` — treat a failure there as authoritative). Their
  `description` fields are deliberately short, independent marketing-style
  summaries, NOT a copy of the tool's full `.describe()`/`description` text
  in `src/tools/*.ts` — don't "fix" them to match verbatim, that's not a
  bug. Do re-read them for accuracy if a tool's _behavior_ changed in a way
  the short summary now misrepresents.
- Tool `description`/field `.describe()` text in `src/tools/*.ts` itself:
  does it still match the actual `inputSchema`/`outputSchema` and the client
  function's real behavior?
- `CHANGELOG.md`'s `[Unreleased]` section (see `docs/changelog-style.md` for
  entry style) has one line per real behavior change made in this pass — add
  missing entries, don't just flag them as missing.
- `docs/api-references.md`'s "confirmed live" claims still match the current
  client code, especially any claim this pass's own fixes just invalidated.
- `AGENTS.md`'s `src/` tree (and this `skills/` entry) still matches the
  filesystem.
- `docs/clients.md` and any other `docs/*.md` for stale phrasing (e.g.
  describing something as "once published"/"upcoming" that already
  shipped).

## 6. Report, then fix only what's confirmed

Rank findings by severity. For each: what's wrong, concrete repro (exact
tool call + params), the file/line causing it, and the fix shape. Silence on
a category you didn't get to (rather than implying full coverage) beats a
false "all clear."

If asked to fix: implement the smallest correct change, add/extend a test in
the matching `src/__tests__/*.test.ts` (mirror the existing test's style in
that file), then re-run the full `build && test && lint && format:check`
gate before calling it done. Re-verify live only after the running MCP
server process has been restarted (it won't pick up source changes on its
own) — build/test passing is necessary but re-confirming actual live
behavior changed is stronger evidence than trusting the diff alone.

## 7. Commit + changelog, if asked

One `fix:`/`feat:` commit per logically distinct change (don't bundle two
unrelated fixes into one commit), then a separate `docs:` commit adding to
`CHANGELOG.md`'s `[Unreleased]` section (style: `docs/changelog-style.md`)
with one bullet per fix, each linking that fix commit's short sha
(`https://github.com/Grinv/anilist-mcp-server/commit/<7-char-sha>`).
Author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`, **no**
`Co-Authored-By` trailer (AGENTS.md's commit convention). Don't push unless
explicitly asked.
