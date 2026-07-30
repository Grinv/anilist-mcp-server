# Upstream API reference — AniList

Authoritative documentation for the one upstream API this server uses,
plus facts verified live against the schema itself (GraphQL is
self-describing via introspection — `docs.anilist.co` blocks plain HTTP
fetches with a 403, so introspection was the reliable way to confirm exact
field/argument names below, verified 2026-07-20, most recently re-verified
2026-07-22). Re-verify against these
before changing `src/clients/anilist/*.ts` or `src/lib/graphql.ts`.

## Endpoint

- **Single GraphQL endpoint** — `POST https://graphql.anilist.co`, body
  `{query, variables}`. No REST fallback, no per-resource URLs.
  <https://docs.anilist.co/guide/graphql/> (source markdown fetched via
  `github.com/AniList/docs`, since the rendered site 403s plain fetches).

## No official API changelog

- AniList's backend is closed source and publishes no changelog/release notes
  for the GraphQL schema itself. The closest substitutes: commit history on
  <https://github.com/AniList/docs> (the docs _site's_ source — occasionally
  reflects a real API change, e.g. a rate-limit-header fix or a new
  `Page`-limit note, but it's docs-history, not a formal changelog) and this
  file's own "confirmed live" sections, built by testing the schema directly
  rather than trusting any external doc to stay current.
- `docs.anilist.co`'s "What's Next?" page is **not** a changelog despite the
  name — it's a getting-started page pointing new API users at query
  examples and community projects.

## Auth — OAuth2 Authorization Code grant

<https://docs.anilist.co/guide/auth/> / `.../auth/authorization-code`

- **Every registered app gets both a Client ID and a Client Secret** — unlike
  MAL, there is no "public vs confidential app type" selection to get wrong.
  We use the confidential **Authorization Code grant** (`client_secret` sent
  server-side in the token exchange) rather than the Implicit grant, because
  it lets `login_anilist` auto-capture the redirect on a localhost listener —
  the Implicit grant returns the token in a URL **fragment**, which a plain
  HTTP server can never see (browsers don't send fragments in requests), so
  it necessarily requires manual copy-paste via AniList's "Auth Pin" page.
- **No PKCE.** `code_challenge`/`code_challenge_method` aren't part of
  AniList's Authorization Code grant at all.
- **No refresh tokens.** "Refresh tokens are not currently supported. Once a
  token expires, you will need to re-authenticate your users." Access tokens
  are JWTs, long-lived (~1 year from issuance per the docs) — we decode the
  JWT's own `exp` claim (`lib/oauthLogin.ts`'s `decodeJwtExpiry`) rather than
  trusting a flat "+1 year" assumption.
- **No scopes.** "Access tokens provide (almost) full access to a user's data."
- Endpoints: authorize at `https://anilist.co/api/v2/oauth/authorize`
  (`response_type=code&client_id=...&redirect_uri=...`); exchange at
  `https://anilist.co/api/v2/oauth/token` (POST
  `grant_type=authorization_code&client_id=...&client_secret=...&redirect_uri=...&code=...`).
  Authenticated requests carry `Authorization: Bearer <token>`.
- Reads need **no auth at all**: "If you are just using the AniList API to get
  publicly available data, you do not need to deal with authentication" —
  covers anime/manga data, character search, and public/unlisted user data.
  Auth is required only for mutations, private-user data, and the
  `mediaListEntry` field on `Media`.

## Rate limiting

<https://docs.anilist.co/guide/rate-limiting>

- **Normal limit: 90 requests/minute.** As of 2026-07-20 the docs carry a live
  banner: _"The API is currently in a degraded state and is limited to 30
  requests per minute. This is a temporary measure until the API is fully
  restored."_ `config.ts`'s `ANILIST_MIN_INTERVAL_MS` defaults to `2100` (~30/min)
  for this reason — **widen it once AniList lifts the degradation**, don't
  hardcode 90/min while it's still in effect.
- Every response carries `X-RateLimit-Limit`/`X-RateLimit-Remaining`. A `429`
  additionally carries `Retry-After` (seconds) and `X-RateLimit-Reset` (unix
  ts), plus a GraphQL body `{data: null, errors: [{message, status: 429}]}`.
  `lib/http.ts`'s `classifyStatus()` + backoff already handles this generically
  (429 → retryable, honors `Retry-After`) — no AniList-specific code needed.
- A separate, undocumented **burst limiter** also exists ("designed to stop
  you from hammering the API with too many requests in a very short period").
- AniList is not currently accepting rate-limit-raise requests for most apps
  (email `contact@anilist.co` if this ever becomes a blocker).

## API stability / outage behavior

<https://docs.anilist.co/guide/considerations>

- A severe outage returns **`403`** with a GraphQL error body like
  `{"errors":[{"message":"The AniList API has been temporarily disabled due to
severe stability issues. Please check the official AniList Discord..." ,
"status":403}],"data":null}` — distinct from the 429 rate-limit case, and
  not something a client-side retry can fix. `lib/http.ts`'s `classifyStatus()`
  maps 403 → `forbidden`, non-retryable, which is the right behavior here too.
- AniList may also manually IP-block excessive traffic (rare); blocked
  requests never reach their origin servers.
- Adult content ("Ecchi" is explicitly **not** considered adult by AniList,
  which has caused app-store issues for other clients) is not filtered by
  default; see the README's NSFW section for the `sfw` tool parameter.

## Errors and validation

<https://docs.anilist.co/guide/graphql/errors>

- **A `200` status does not guarantee no error** — "the GraphQL server may
  return an error even if the request was successful." Always check the
  `errors` field of the response body, not just the HTTP status.
- **Validation errors on mutations have a nested shape**: `message` is just
  the generic label `"validation"`, and the actual per-field reasons live
  under a sibling `validation` object, e.g.
  `{"message":"validation","status":400,"validation":{"score":["The score may
not be greater than 100."]}}`. Both `lib/http.ts`'s `parseErrorMessage()`
  (for the common case where AniList also sets a matching non-2xx HTTP status)
  and `lib/graphql.ts`'s `describeGraphQLError()` (for a 200-status response
  that still carries `errors[]`) unpack `validation` into the surfaced
  message — don't just join `errors[].message` values, or a validation
  failure reads as the useless literal word "validation" with no indication
  of which field or why.

## Pagination and `Page` limitations

<https://docs.anilist.co/guide/graphql/pagination>

- **A single `Page` query may only request one data field** (`media` _or_
  `characters` _or_ `staff`, etc. — never two in the same query); `pageInfo`
  is exempt from this rule and can always be included alongside the one data
  field. Every `Page{...}` query built in `src/clients/anilist/*.ts` already
  follows this (one data field + optional `pageInfo`) — preserve it if you
  add new paginated queries.
- **`PageInfo.total` and `PageInfo.lastPage` are currently degraded** ("not
  currently accurate," per a live doc warning) due to a performance-driven
  limitation — only `hasNextPage` is reliable for pagination logic. Our
  search/list queries still request `total`/`lastPage` for callers who find
  them useful, but tool descriptions and callers should not treat them as
  exact.
- **Every `PageInfo` field is nullable at the schema level** (`total`,
  `perPage`, `currentPage`, `lastPage`, `hasNextPage` — confirmed via
  introspection: none carry a `NON_NULL` wrapper), and there is only one
  `PageInfo` type reused by every connection (`CharacterConnection`,
  `StaffConnection`, `ReviewConnection`, `MediaConnection`, `Page` itself,
  …) — no per-connection override tightens this. Confirmed live: a
  `threadComments` page on a thread that had just had its only comment
  deleted came back with `total`/`currentPage`/`lastPage` all `null` (not
  `0`/`1`/`1`) — while genuinely-empty pages elsewhere (e.g. `search_character`
  run past the real end of its matches) still returned real numbers. Since
  nothing in the schema guarantees the latter behavior, `pageInfoSchema`
  (`src/tools/outputSchemas.ts`) models every field `.nullish()`, not just
  `.optional()` — don't narrow it back without re-verifying every consumer.
- An unprovided GraphQL variable is simply ignored by the server (treated as
  not passed) rather than erroring — confirms `lib/graphql.ts`'s
  `stripUndefined()` approach (omit unset optional variables entirely) is
  exactly the behavior AniList's own docs recommend, not a workaround.

## No localization

`MediaTitle` (verified against the full schema, not just the `Media` field
list) exposes exactly three fixed variants — `romaji`, `english`, `native` —
plus `userPreferred` (not a locale parameter; it just echoes whichever of the
three the _authenticated_ user picked in their own account settings). There is
no Russian, no arbitrary-language, and no translation system anywhere in the
schema (`__schema.types` has no `Translation`/`Locale` type; the only
language-flavored types are `StaffLanguage` — a voice actor's spoken language,
already used for `voiceActors` — and the title-language enums above).
`description` is likewise a single field, generally English-sourced, with no
per-locale variant. This is a hard platform limitation, not something our
client can work around.

## GraphQL schema facts (verified via live introspection, 2026-07-20 & 2026-07-22)

These are the exact names `src/clients/anilist/*.ts`'s query/mutation strings
rely on — re-verify with an introspection query
(`{ __type(name: "TypeName") { fields { name args { name type { name } } } } }`
against `https://graphql.anilist.co`) before changing them, since AniList's
schema isn't versioned the way a REST API would be.

- **Mutations** (<https://docs.anilist.co/guide/graphql/mutations>): `Save*`
  prefix = upsert (create if no `id` arg given, update if given); `Delete*`
  returns a `Deleted` object; `Toggle*` flips a boolean.
  - `SaveMediaListEntry(id, mediaId, status, score, scoreRaw, progress,
progressVolumes, repeat, priority, private, notes, hiddenFromStatusLists,
customLists: [String], advancedScores: [Float], startedAt: FuzzyDateInput,
completedAt: FuzzyDateInput)` — note **`advancedScores`** is plural (a
    third-party wrapper library shipped a mismatched singular `advancedScore`
    in its own hand-written mutation string, which is part of why its writes
    never worked — see AGENTS.md's "Why this server exists").
  - **Omitting `status` on create does NOT default to `PLANNING`** — confirmed
    live twice (a completely bare `SaveMediaListEntry(mediaId)` call) — the
    API defaults to **`CURRENT`**, with `startedAt` auto-set to today. AniList's
    own website UI defaults a new entry to Planning, but that's a client-side
    choice, not the API's actual behavior when the arg is truly absent.
  - **Read-side `customLists`/`advancedScores` are untyped `Json`, not the
    input side's `[String]`/`[Float]`** — `customLists`'s default shape is an
    object keyed by every one of the account's configured custom list names
    (`{listName: boolean}`); pass `customLists(asArray: true)` instead for a
    predictable `[{name, enabled}]` array (confirmed live). `advancedScores`
    reads back as `{categoryName: score}` on the same raw 0-100 scale as
    `scoreRaw` (confirmed live: writing `{Story: 8}` read back as `{Story:
80, ...other configured categories: 0}`). Also confirmed live: naming a
    custom list on an entry that doesn't already exist in the account's own
    `animeListOptions`/`mangaListOptions` `customLists` (see `UpdateUser`
    below) is silently a no-op — the list must be created account-side first.
  - `ToggleFavourite(animeId, mangaId, characterId, staffId, studioId)` →
    `Favourites { anime: MediaConnection, manga: MediaConnection, characters:
CharacterConnection, staff: StaffConnection, studios: StudioConnection }`
    (each a `{nodes: [...]}` connection).
  - `DeleteMediaListEntry(id)`, `DeleteActivity(id)`, `DeleteThread(id)`,
    `DeleteThreadComment(id)` each return `Deleted { deleted: Boolean }`.
  - `SaveTextActivity(id, text, locked)`, `SaveMessageActivity(id, message,
recipientId, private, locked, asMod)`, `ToggleFollow(userId)`.
  - **`UpdateUser`'s full arg list** (confirmed via introspection): `about,
titleLanguage, displayAdultContent, airingNotifications, scoreFormat,
rowOrder, profileColor, donatorBadge, notificationOptions, timezone,
activityMergeTime, animeListOptions, mangaListOptions, staffNameLanguage,
restrictMessagesToFollowing, disabledListActivity` — all of these are wired
    up in `update_user`. Every one is readable back via `User.options`/
    `User.donatorBadge`, including `rowOrder` (`User.mediaListOptions.rowOrder`
    — a sibling of `scoreFormat`, NOT nested under `animeList`/`mangaList`;
    an earlier pass at this file wrongly concluded it wasn't exposed anywhere,
    confirmed live to be wrong).
  - **`donatorBadge`'s 24-char cap and `activityMergeTime`'s 0/20160 bounds
    are AniList's own documented schema constraints, not this project's
    guess** — confirmed via introspection of `UpdateUser`'s arg descriptions:
    `donatorBadge`: "Profile highlight color (Max: 24)"; `activityMergeTime`:
    "Minutes between activity for them to be merged together. 0 is Never,
    Above 2 weeks (20160 mins) is Always. (Min: 0)".
  - **`profileColor`/`rowOrder`/`timezone` are all plain `String` args on
    AniList's own schema (confirmed via introspection — none is a real GraphQL
    enum), but AniList validates them very differently server-side, confirmed
    live**: an unrecognized `profileColor` is silently ignored (the account's
    existing value is left unchanged, no error, no way to detect the rejection
    other than re-reading the account), while an invalid `rowOrder` or
    `timezone` is rejected with a clear 400 (`"The selected row order is
invalid."` / `"The timezone format is invalid."`). `timezone`'s accepted
    format is documented by AniList's own schema as `-?HH:MM` (optional
    leading minus only) — whether a leading `+` is also accepted wasn't tested
    live, since `update_user` has no way to explicitly clear `timezone` back to
    unset, so a wrong guess risked leaving the field permanently changed.
  - **`UpdateUser`'s atomicity is inconsistent across validation layers, and
    the one confirmed non-atomic path is now blocked client-side anyway** —
    the tool's own description used to claim "not atomic, e.g. an incomplete
    `disabledListActivity`", but that specific trigger is unreachable through
    this client since the `.refine()` below rejects it before any request is
    sent. A fresh live re-test through a currently-reachable path — an
    invalid `rowOrder` ("bogus_order") plus a valid `activityMergeTime`
    change in the same call — showed the OPPOSITE: the whole mutation was
    rejected atomically (`activityMergeTime` stayed at its prior value,
    confirmed via a follow-up `get_authorized_user`), unlike the historical
    `disabledListActivity` case below. `rowOrder`/`timezone`-style plain-
    string args appear to validate in an earlier pass that blocks the whole
    mutation; the list-valued args below validate later, after some fields
    already commit. The description no longer makes a general atomicity
    claim as a result — both of the following remain historically true and
    are why the client-side `.refine()`s exist, even though neither is
    reachable live anymore:
    - **`disabledListActivity` requires all 6 `MediaListStatus` values every
      call**; a shorter array is rejected with `400 Incorrect number of
disabled list activity options (6 required)`. Worse: that rejection
      does **not** roll back other fields sent in the same `UpdateUser`
      call — a live test setting `staffNameLanguage`/`activityMergeTime`/
      `restrictMessagesToFollowing` alongside an invalid (5-entry)
      `disabledListActivity` saw the first three fields commit to the
      account despite the overall mutation returning an error. `update_user`
      now client-side validates this array's length/coverage before ever
      sending, specifically to avoid triggering this failure mode.
    - **`notificationOptions` is a full-array replace, not a partial
      merge, and AniList does not error on a short list** — confirmed live:
      sending a single `{type: THREAD_LIKE, enabled: false}` entry silently
      dropped all 19 other notification types from the account's real,
      persisted `options.notificationOptions` (verified via a follow-up
      `get_authorized_user` call, not just the mutation's own echo) — they
      don't reset to a default, they disappear outright. `update_user` now
      client-side requires all 20 `NotificationType` values whenever this
      arg is set at all, specifically to prevent this silent data loss.
    - **Omitting the per-entry `enabled`/`disabled` boolean behaves
      differently on these two otherwise-parallel array args** — confirmed
      live: a `notificationOptions` entry missing `enabled` (e.g.
      `{type: THREAD_LIKE}`) is accepted and persists as `enabled: null`
      (verified via `get_authorized_user`), no error. The same shape of
      omission on `disabledListActivity` (e.g. `{type: PAUSED}`, with the
      other 5 statuses complete) instead fails the **entire** mutation with
      a bare `500 Internal Server Error` — not the structured 400
      validation shape described above, and confirmed to leave the account
      completely unchanged (not a partial-apply case). Always send an
      explicit `true`/`false` for every entry of both arrays.
  - **`animeListOptions`/`mangaListOptions` (`MediaListOptionsInput`: `{
sectionOrder, splitCompletedSectionByFormat, customLists, advancedScoring,
advancedScoringEnabled, theme }`) is a true partial merge, not full-replace**
    — confirmed live: sending only `{customLists: [...]}` left
    `advancedScoring`/`advancedScoringEnabled`/`sectionOrder` and the other
    list type (`mangaList`) completely untouched. This is the opposite
    convention from `SaveMediaListEntry`'s `advancedScores`, which zeros any
    omitted category — don't assume one behavior implies the other.
  - **But `customLists` itself is full-replace, not merged by name** —
    confirmed live: an account with `customLists: [A, B]`, sent
    `{customLists: [A]}`, ended up with `customLists: [A]` — `B` was
    silently deleted, not preserved. So while sibling _fields_ merge
    (previous bullet), the _array value_ of a field you do set is taken
    verbatim as the new complete value. Fetch the current array via
    `get_authorized_user` first and include every name you want to keep,
    not just the one being added or removed.
  - **`advancedScoring` was NOT put through this same before/after
    full-replace test** — its own confirmed-live risk is different (see the
    next bullet: reordering/renaming silently reinterprets already-scored
    entries, a positional hazard). Deliberately not tested with a real
    account that has stored `advancedScores` values, since a wrong write
    there is the one genuinely hard-to-detect corruption case this file
    warns against elsewhere. Treat "fetch first, resend in full" as a safe
    default for it too (same field mechanism as `customLists`), not as an
    equally-confirmed fact.
  - **A non-empty `advancedScoring` category list does NOT mean advanced
    scoring is enabled** — confirmed live: an account with
    `advancedScoringEnabled: false` still had `advancedScoring: [Story,
Characters, Visuals, Audio, Enjoyment]` populated (disabling the feature on
    the site doesn't clear the category list). `saveListEntry`'s
    `orderAdvancedScores` must check `advancedScoringEnabled` explicitly, not
    infer it from `categories.length`.
  - **`SaveMediaListEntry` does not itself validate `advancedScores` against
    the account's settings at all** — it accepted a write while
    `advancedScoringEnabled` was `false`, storing the raw positional array
    unconditionally. The name↔position mapping (and any enforcement of it)
    exists only client-side, in whichever client sent the write — AniList's
    read path re-zips the stored array against whatever `advancedScoring`
    category order happens to be configured _at read time_, so reordering or
    renaming categories later would silently reinterpret old scores under
    the new names/positions.
  - `SaveThread(id, title, body, categories: [Int], mediaCategories: [Int],
sticky, locked)` and `SaveThreadComment(id, threadId, parentCommentId,
comment)` — same upsert convention as `SaveMediaListEntry`. There is no
    query to list `ThreadCategory` values independently; the only way to
    discover one is to already have a `Thread` (its `categories`/
    `mediaCategories` fields) or a forum URL
    (`anilist.co/forum/recent?category=<id>`) — `post_thread`/`search_thread`
    document this limitation rather than pretending categories are
    discoverable some other way. `categories` is required when creating (no
    `id`) — confirmed live: AniList rejects it with `validation (categories:
The categories field is required when id is not present.)`.
    `SaveThread`'s **`sticky` and `locked` args are silently no-ops without
    moderator permission** — confirmed live on a non-mod account's own
    thread: both args were accepted with no error, but `isSticky`/`isLocked`
    stayed `false` afterward. `get_thread`'s query includes `isSticky`,
    `isLocked`, and `mediaCategories` specifically so a caller can check
    whether a `post_thread` call actually took effect, not just that it
    didn't error.
  - **`categories`, when set on an update, is a full replace, not a
    merge** — confirmed live with a real self-created/self-deleted test
    thread: created with `categories:[7]` (General), then updated with
    `categories:[1]` (Anime) alone — the thread ended up with `categories:
[{id:1,name:"Anime"}]` only, category 7 silently dropped rather than
    both being present. Whether omitting `categories` entirely on an update
    leaves the existing set untouched was NOT tested (hit AniList's
    "too many threads created recently" 1-minute rate limit mid-sequence);
    don't assume either way until confirmed.
- **`Media` query/filter args** (also valid on `Page.media(...)`, same
  arg set): `search, type, sort: [MediaSort], isAdult, genre_in: [String],
format_in: [MediaFormat], status_in: [MediaStatus], season: MediaSeason,
seasonYear`, plus many more (`averageScore_greater`, `tag_in`, …) — see the
  full arg list via introspection if extending `searchMedia()`.
- **`season` and `seasonYear` are independent filters, not a mandatory
  pair** — confirmed live: `season: SUMMER` alone matches every Summer across
  all years, and `seasonYear: 2025` alone matches every season within 2025.
  Combine them for one specific season+year; neither requires the other.
- **`MediaList.score(format: ScoreFormat)`** takes an optional `format` arg to
  normalize the score regardless of the user's own list settings —
  `getUserList()` requests `POINT_10_DECIMAL` for a consistent 0-10 scale.
  `ScoreFormat` enum: `POINT_100, POINT_10_DECIMAL, POINT_10, POINT_5, POINT_3`.
- **On write, `score` and `scoreRaw` are NOT equivalent.** `SaveMediaListEntry`'s
  `score` arg description is literally _"The score of the media in the user's
  chosen scoring method"_ — it's interpreted according to the account's own
  `scoreFormat` (confirmed live: an account configured as `POINT_100` would
  read a `score: 8` write as 8/100, not 8/10). `scoreRaw`'s description has no
  such caveat ("in 100 point") — it is **always** a fixed 0-100 scale
  regardless of the account's format. `saveListEntry()` therefore always
  writes via `scoreRaw` (converting the tool's 0-10 input ×10), never `score`,
  so a fixed 0-10 tool parameter behaves the same on every account. Similarly
  `advancedScores` (`Array of advanced scores (Min: 0, Max: 100)`) is always
  raw 0-100 per category, with no format caveat.
- **`advancedScores` is positional, not keyed** — `SaveMediaListEntry(advancedScores:
[Float])` applies values in the order of the account's own configured
  categories (`Viewer.mediaListOptions.{animeList,mangaList}.advancedScoring`,
  a `[String]`). There is no way to address a category by name in the
  mutation itself — the caller must fetch the account's category order first
  and build the array to match (`saveListEntry()`'s `orderAdvancedScores`
  does this, and rejects category names it doesn't recognize rather than
  guessing an order).
- **`MediaListStatus`**: `CURRENT, PLANNING, COMPLETED, DROPPED, PAUSED, REPEATING`.
- **`ActivityType`**: `TEXT, ANIME_LIST, MANGA_LIST, MESSAGE, MEDIA_LIST`.
- **`MediaSeason`**: `WINTER, SPRING, SUMMER, FALL`.
- **`UserTitleLanguage`**: `ROMAJI, ENGLISH, NATIVE, ROMAJI_STYLISED,
ENGLISH_STYLISED, NATIVE_STYLISED` — all 6 exposed by `update_user`.
- **`Page`** exposes: `pageInfo, users, media, characters, staff, studios,
mediaList, airingSchedules, mediaTrends, notifications, followers,
following, activities, activityReplies, threads, threadComments, reviews,
recommendations, likes`.
- **`SiteStatistics` silently caps `perPage` at 25 itself** — confirmed live
  by requesting a higher value directly (bypassing `get_site_statistics`'s
  own matching `.max(25)`): AniList capped the response at 25 anyway, so
  this tool's own limit costs nothing.
- **`MediaListCollection(userId, userName, type, …)`** is capped at the
  **11,000 most recently updated unique entries** — irrelevant for virtually
  all users, but a hard ceiling if one ever hits it. It must include the
  user's custom lists (not just status lists) to avoid silently missing
  entries hidden from the default status lists.
- **`Media(id_in: [Int])` does not preserve the input array's order** —
  confirmed live: requesting `[154587, 21]` came back `[21, 154587]`
  (looked like default id-ascending sort). `getMedia()`'s array branch now
  reorders the response client-side, filling `null` in place of any id that
  didn't resolve (rather than dropping it), so the result is always the same
  length as `ids` and matches `get_media`'s documented "same order as `ids`,
  with `null` in place of any ID that didn't resolve" guarantee.
- **Several other singular lookups return `null` instead of erroring for an
  unresolved ID, but NOT all of them** — confirmed live: a top-level
  `Media(id)`/`Thread(id)`/`User(id)`/`User(name)` query (no nested fields
  beyond scalars) reliably 404s via a real HTTP status for a bad id/name, but
  `Media(id){ recommendations {...} }`/`Media(id){ stats {...} }`/
  `{ characters {...} }`/`{ staff {...} }`/`{ reviews {...} }`/
  `{ relations {...} }` (nested connection fields) — plus bare `Activity(id)`,
  `Character(id)`, `Staff(id)`, `Studio(id)`, `Recommendation(id)` — resolve
  to `null` with a 200 OK instead. Every client function hitting one of these
  null-instead-of-error shapes calls `assertFound()` (`lib/errors.ts`) to turn
  that into a clean `not_found` `ApiError` rather than letting a raw
  `TypeError`/`null` reach the caller — including `getUserProfile()`/
  `getUserStats()`/`getFullUserInfo()`, which guard the same way as a
  defensive-consistency measure even though `User` itself hasn't been
  observed returning the null-instead-of-404 shape live.
- **`Recommendation(id)` is unreliable even for ids taken straight from
  `Media(id){ recommendations { nodes{id} } }`** — confirmed live via raw
  `curl` against `https://graphql.anilist.co` (independent of this server,
  ruling out a client bug): of the 10 recommendation-node ids returned for
  one title, 7 came back `Not Found` (404) on the root `Recommendation(id)`
  lookup and 3 resolved. Retried the same ids moments later with identical
  results (not request-timing flakiness), and the failures didn't correlate
  with that pairing's `rating` (the highest- and lowest-rated ids in the
  sample both failed; a middling one succeeded). No root cause identified —
  this is an AniList-side inconsistency between the connection view and the
  root lookup, not something `getRecommendation()`'s query is doing wrong.
  `get_recommendation`'s tool description discloses this so a 404 there
  isn't misread as "this pairing doesn't exist."
- **`Studio(search:$search)` (the by-name path `get_studio`'s `name` param
  takes) does AniList's own fuzzy search, not an exact-name lookup** —
  confirmed live: `Studio(search:"Kyoto Anim")` resolved directly to Kyoto
  Animation, the same fuzzy-match mechanism `search_studio`'s `studios(
search:...)` connection uses. `get_studio`'s own description used to imply
  `search_studio` was needed first for any partial name; only true when you
  actually want to browse multiple candidates rather than take the closest
  match.
- **A `Page(...)` connection filtered by a parent id doesn't error for a
  nonexistent id** — it just returns an empty-but-successful page,
  indistinguishable from "this parent genuinely has none of these". Confirmed
  live for three fields so far, same shape each time — all three now alias a
  same-request existence check via `fields.ts`'s `existsFragment()` helper,
  not a hand-built fragment or separate request per call site:
  - `threadComments(threadId)` — an empty page (`nodes: []`, all `pageInfo`
    fields `null`) for a bad `threadId`. `getThreadComments()` aliases a
    `Thread(id){id}` existence check into the _same_ request as the real
    query — no extra request.
  - `activities(userId)` — an empty page for a bad numeric `userId` (the same
    call with a bad _username_ instead silently returns the _global_ feed,
    not even an empty page). For a numeric id, `getUserActivity()` aliases a
    `User(id){id}` existence check into the _same_ request as the real
    `activities(userId:...)` query — confirmed live that AniList 404s the
    entire response (not just the aliased field) when `User(id)` doesn't
    resolve, so this costs no extra request. A username has a genuine data
    dependency (the id it resolves to must be known before `activities()` can
    even be built), so that path still needs a separate resolution request first.
  - `airingSchedules(mediaId)` — an empty schedule for a bad `mediaId`,
    though a real completed anime legitimately has an empty schedule too, so
    this one's ambiguity bites far less often in practice. `getSchedule()`
    aliases a `Media(id){id}` existence check into the same request as
    `airingSchedules(...)` (same no-extra-request combined-query approach as
    `getUserActivity`'s numeric path above), only when `mediaId` is given.
    `airingSchedules` also has no `type` filter of its own, so a real MANGA id
    used to pass this existence check and just return an empty schedule
    (indistinguishable from a real anime past its air date) — confirmed live
    with One Piece's manga id (30013). The exists check now adds
    `type:ANIME` (`existsFragment("Media", "mediaId", "type:ANIME")`), so a
    manga id is rejected with a clean `not_found` instead. Confirmed live
    after the fix: the manga id now 404s, and a real anime id (21) returns
    the schedule with `hasNextPage` correctly included — `getSchedule()`
    previously discarded `pageInfo.hasNextPage` even though it fetched it.

  **`mediaList` does NOT share this shape — confirmed live it needs no alias
  trick at all.** `MediaListCollection(userId/userName)` 404s the entire
  response itself for a nonexistent user (both a bad numeric id and a bad
  username), the same as a singular lookup, not a filtered-Page's
  empty-but-successful result — `getUserList()` correctly has no existence
  check of its own.

  Other `Page` connections filtered by a parent id (`notifications`,
  `followers`/`following`, `activityReplies`, `reviews`) are still NOT
  confirmed either way — check for this exact shape (or `mediaList`'s
  "actually just 404s" shape) before assuming either applies.

- **`ToggleFavourite` does not validate that `id` actually belongs to the
  given `kind`** — confirmed live: `ToggleFavourite(characterId: <a real
anime's id>)` succeeded and added that id to the account's favourited
  characters, with no error and no existence check. `toggle_favourite`'s tool
  description warns callers to resolve `id` from the matching
  search/get tool for `kind` rather than reusing an id on hand, since AniList
  itself won't catch the mismatch.
- **`User.options`/`User.mediaListOptions` are NOT viewer-gated** — confirmed
  live: looking up a third-party account (not the caller's own) via
  `get_user_profile`/`get_full_user_info` returns that account's full
  notification toggles, `disabledListActivity`, `scoreFormat`, `rowOrder`,
  and list-display/advanced-scoring settings, not just public profile fields
  (name/about/avatar/donator status). This is AniList's own API behavior
  (these fields simply aren't restricted to `Viewer`), not a bug in this
  server, but it's worth knowing before treating them as private.
- **`User.statistics` (anime/manga count, meanScore, etc.) lags behind the
  account's real list state** — confirmed live: an account with several
  real `MediaListCollection` entries (non-zero scores/progress) still had
  `statistics.anime.count: 0` and all other statistics fields zeroed,
  reproduced with a bare `curl` query bypassing this server entirely. This
  is AniList's own stats aggregation being stale, not a bug in `get_user_stats`
  — its query already exactly matches the schema.
- **`Media.isFavourite`/`isFollowing`-shaped viewer fields have a brief
  read-after-write lag on AniList's own backend** — confirmed live: right
  after `ToggleFavourite` succeeded, a `get_media` call for that same id
  (cache already cleared, so genuinely uncached) still returned the
  pre-toggle `isFavourite`, reproducible again on the next call before
  finally resolving. A bare `curl` at the same moment, bypassing this server
  entirely, showed AniList's own API returning that same stale value — not
  this server's cache. `GraphQLClient.request()` clearing its cache after
  every mutation (`lib/graphql.ts`) guarantees the next read is _uncached_,
  not that it's _correct_ — a stale-but-fresh response like this one gets
  cached normally afterward, so the inaccuracy can then persist for the
  cache's full TTL (default 5 min) rather than resolving on AniList's own
  (much shorter) timescale. Not fixable server-side short of never caching
  viewer-relative fields at all — expect it when a test or a real caller
  mutates then immediately re-reads to verify.
- **`Media.characters(page, perPage)`**/**`Media.staff(page, perPage)`**
  return `CharacterConnection`/`StaffConnection`; the per-title role
  (MAIN/SUPPORTING/BACKGROUND for characters, e.g. "ADR Director" for staff)
  lives on the **edge**, not the node — use `edges { role node {...} }`, not
  `nodes {...}`, or the role is silently lost. `CharacterEdge.voiceActors`
  returns one `Staff` per dub language (no `language` filter applied in our
  queries — cheap enough to return all of them).
- **`Media.relations`** → `MediaConnection`; the relation kind
  (`MediaRelation` enum: `ADAPTATION, PREQUEL, SEQUEL, PARENT, SIDE_STORY,
CHARACTER, SUMMARY, ALTERNATIVE, SPIN_OFF, OTHER, SOURCE, COMPILATION,
CONTAINS`) lives on `MediaEdge.relationType`, again not on the node.
- **`Media.stats.scoreDistribution`/`.statusDistribution`** (`MediaStats`,
  each item `{score/status, amount}`) is the AniList equivalent of MAL's
  watch-status/score-distribution endpoint — powers `get_media_statistics`.
- **Token-efficiency split**: `fields.ts`'s `MEDIA_FIELDS` deliberately
  excludes `tags` (often 20-30 entries per title) and `description` (can run
  to several hundred/thousand characters) — `search.ts`/`recommendation.ts`
  return many media items per call, so `tags` only lives in
  `MEDIA_DETAIL_FIELDS` (appended solely by `get_media`) and `description`
  is its own `MEDIA_DESCRIPTION_FIELD`, always appended by `get_media` but
  only appended by `searchMedia()` when `search_media`'s `includeDescription`
  is set. Keep this split if you add more variable-length fields.
- **`Media.streamingEpisodes` takes no pagination args at all** (confirmed
  via introspection — unlike `characters`/`staff`/`reviews`, there's no
  `page`/`perPage`), so a long-running title can return hundreds of entries
  in one response with no way to ask AniList itself for fewer. `getMedia()`
  therefore excludes it from `MEDIA_DETAIL_FIELDS` entirely and only appends
  it (`MEDIA_STREAMING_EPISODES_FIELD`) when `get_media`'s
  `includeStreamingEpisodes` is explicitly set — same opt-in pattern as
  `get_media_reviews`'s `includeBody`.
- **`Media.rankings`** → `[MediaRank]`, also `MEDIA_DETAIL_FIELDS`-only (same
  token-efficiency reasoning as `tags` above). Each entry is one ranking
  window the title currently appears in — the site UI's "#N highest rated
  all time" / "#N highest rated `<year>`" badges. `rank`/`type`
  (`MediaRankType`: `RATED, POPULAR`)/`format`/`context` are non-null;
  `year`/`season`/`allTime` are nullable and say which window `context`
  describes (all-time vs a specific year, optionally narrowed to one
  season) — verified via introspection against `graphql.anilist.co` directly
  (AniList's hosted docs don't spell out per-field nullability here).
- **`Character(isBirthday: Boolean)`/`Staff(isBirthday: Boolean)`** power
  `get_todays_birthdays`.
- **`ThreadComment.comment(asHtml: Boolean)` / `Thread.body(asHtml: Boolean)`**
  — both take the `asHtml` arg used throughout the client to request plain text.
- **`Notification` (top-level `Query` field, exposed via `Page.notifications`)**
  is a union of **20 concrete types** — not documented on AniList's hosted
  docs site as of this writing; verified by introspecting
  `graphql.anilist.co` directly (`{__type(name:"NotificationUnion"){possibleTypes{name}}}`).
  Every branch shares `id`/`type`/`createdAt`/`context` (or `contexts` on a
  few); `fields.ts`'s `NOTIFICATION_FIELDS` adds each type's one distinguishing
  reference (`media`/`user`/`thread`/`staff`/`character`) so `get_notifications`
  doesn't force a follow-up call just to know what a notification is about.
  Always viewer-scoped — the `Notification` query has no `userId` arg, so
  `notification.ts`'s `getNotifications()` always calls `ctx.requireAuth()`.
- **`ActivityMessageNotification.message` is not the message text** — despite
  the name, its type is `MessageActivity` (a full nested object), not
  `String`. The actual DM text is one level deeper, at
  `message.message` (`MessageActivity.message`, itself an `asHtml`-taking
  field) — `NOTIFICATION_FIELDS`' `ActivityMessageNotification` fragment
  selects `message { id message(asHtml: false) siteUrl }` to surface it;
  selecting bare `message` (as every other notification-type fragment does
  for its own distinguishing field) silently returns nothing useful.
- **`Character.media`/`Staff.staffMedia`** (`MediaConnection`) are each
  person's filmography; the per-credit role lives on the edge, same
  edge-not-node pattern as `Media.characters`/`Media.staff` above —
  `MediaEdge.characterRole`/`MediaEdge.staffRole` respectively. `Staff.characters`
  (a `CharacterConnection`) is voice-actor-specific (the characters they
  voiced); `staffMedia` covers every staff role (writer, director, VA, etc.)
  and is the one `get_staff` uses for a role-agnostic filmography.

## MCP client quirk observed during testing (not an AniList API fact)

Unlike every other entry in this file, this one is about the calling _MCP
client_, not AniList — recorded here anyway since it was discovered while
live-testing against AniList and would otherwise look like a server bug.

Calling a tool whose Zod input schema is a scalar/collection union — e.g.
`get_media`'s `ids: z.union([anilistId, z.array(anilistId).min(1)])`
(JSON Schema `anyOf: [integer, array]`), or `userIdOrName`'s
`z.union([anilistId, z.string().min(1)])` (`anyOf: [integer, string]`) —
**with a bare scalar number** (`ids: 16498`, `user: 6933956`) reproducibly
fails or silently takes the wrong union branch when the call is made through
a live Claude Code session, even though:

- the server's declared JSON Schema is correct (verified via
  `npx @modelcontextprotocol/inspector --cli node dist/index.js --method
tools/list`),
- and the exact same call, made directly against the same running package
  (`npx @modelcontextprotocol/inspector --cli node dist/index.js --method
tools/call --tool-name get_media --tool-arg ids=16498`, bypassing Claude
  Code entirely) succeeds.

Confirmed on two different fields: `get_media`'s `ids=<number>` raised a
validation error claiming `ids` was missing entirely, while `ids=[<number>]`
(same id, wrapped in an array) worked; `get_user_profile`'s/
`get_full_user_info`'s `user=<a real numeric id>` 404'd — consistent with the
number being sent as a string and matching the schema's `string` branch
instead of `integer`, so the client function's `typeof user === "number"`
branch (`clients/anilist/user.ts`) took the _username_ path and looked up a
user literally named after the digits, which doesn't exist — while the exact
same numeric id resolved correctly via `User(name:"...")`'s sibling
`User(id:...)` path when called directly, bypassing Claude Code.

Nothing to fix in this repo — the server, its schema, and its client
functions all behave correctly when called directly. Workaround when hitting
this through Claude Code: wrap a scalar/array union argument in an array
even for a single value (`ids: [16498]`); no equivalent workaround is known
for a scalar/string union (`user`) beyond passing the value some other way
(e.g. a resolved username instead of a numeric id, where one is available).

## Why our own GraphQL client instead of a wrapper library

See AGENTS.md's "Why this server exists" — the short version: `lib/graphql.ts`
builds `variables` itself and recursively drops `undefined` entries before
sending, so an unset optional field (a `FuzzyDateInput`, `customLists`, etc.)
is simply omitted from the request rather than forced into a placeholder
shape. GraphQL already treats an omitted optional argument as "not provided" —
there's no need for a variable-building library at all, which is exactly the
layer that broke in the third-party server this one replaces.
