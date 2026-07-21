# Upstream API reference — AniList

Authoritative documentation for the one upstream API this server uses,
plus facts verified live against the schema itself (GraphQL is
self-describing via introspection — `docs.anilist.co` blocks plain HTTP
fetches with a 403, so introspection was the reliable way to confirm exact
field/argument names below, verified 2026-07-20). Re-verify against these
before changing `src/clients/anilist/*.ts` or `src/lib/graphql.ts`.

## Endpoint

- **Single GraphQL endpoint** — `POST https://graphql.anilist.co`, body
  `{query, variables}`. No REST fallback, no per-resource URLs.
  <https://docs.anilist.co/guide/graphql/> (source markdown fetched via
  `github.com/AniList/docs`, since the rendered site 403s plain fetches).

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

## GraphQL schema facts (verified via live introspection, 2026-07-20)

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
  - `ToggleFavourite(animeId, mangaId, characterId, staffId, studioId)` →
    `Favourites { anime: MediaConnection, manga: MediaConnection, characters:
CharacterConnection, staff: StaffConnection, studios: StudioConnection }`
    (each a `{nodes: [...]}` connection).
  - `DeleteMediaListEntry(id)`, `DeleteActivity(id)`, `DeleteThread(id)`,
    `DeleteThreadComment(id)` each return `Deleted { deleted: Boolean }`.
  - `SaveTextActivity(id, text, locked)`, `SaveMessageActivity(id, message,
recipientId, private, locked, asMod)`, `ToggleFollow(userId)`,
    `UpdateUser(about, titleLanguage, displayAdultContent, scoreFormat, …)`.
  - `SaveThread(id, title, body, categories: [Int], mediaCategories: [Int],
sticky, locked)` and `SaveThreadComment(id, threadId, parentCommentId,
comment)` — same upsert convention as `SaveMediaListEntry`. There is no
    query to list `ThreadCategory` values independently; the only way to
    discover one is to already have a `Thread` (its `categories`/
    `mediaCategories` fields) or a forum URL
    (`anilist.co/forum/recent?category=<id>`) — `post_thread`/`search_thread`
    document this limitation rather than pretending categories are
    discoverable some other way.
- **`Media` query/filter args** (also valid on `Page.media(...)`, same
  arg set): `search, type, sort: [MediaSort], isAdult, genre_in: [String],
format_in: [MediaFormat], status_in: [MediaStatus], season: MediaSeason,
seasonYear`, plus many more (`averageScore_greater`, `tag_in`, …) — see the
  full arg list via introspection if extending `searchMedia()`.
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
- **`UserTitleLanguage`**: `ROMAJI, ENGLISH, NATIVE` (+ `*_STYLISED` variants,
  not currently exposed by `update_user`).
- **`Page`** exposes: `pageInfo, users, media, characters, staff, studios,
mediaList, airingSchedules, mediaTrends, notifications, followers,
following, activities, activityReplies, threads, threadComments, reviews,
recommendations, likes`.
- **`MediaListCollection(userId, userName, type, …)`** is capped at the
  **11,000 most recently updated unique entries** — irrelevant for virtually
  all users, but a hard ceiling if one ever hits it. It must include the
  user's custom lists (not just status lists) to avoid silently missing
  entries hidden from the default status lists.
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
  excludes `tags` (often 20-30 entries per title) — `search.ts`/
  `recommendation.ts` return many media items per call, so that field only
  lives in `MEDIA_DETAIL_FIELDS`, appended solely by `get_media`
  (single/few-item lookups). Keep this split if you add more variable-length
  fields (e.g. `externalLinks`, `streamingEpisodes`).
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

## Why our own GraphQL client instead of a wrapper library

See AGENTS.md's "Why this server exists" — the short version: `lib/graphql.ts`
builds `variables` itself and recursively drops `undefined` entries before
sending, so an unset optional field (a `FuzzyDateInput`, `customLists`, etc.)
is simply omitted from the request rather than forced into a placeholder
shape. GraphQL already treats an omitted optional argument as "not provided" —
there's no need for a variable-building library at all, which is exactly the
layer that broke in the third-party server this one replaces.
