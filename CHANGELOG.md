# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-21

### Added

- Initial release: an MCP server for AniList's GraphQL API, talking to
  `https://graphql.anilist.co` directly through a first-party client instead
  of a third-party wrapper (see AGENTS.md's "Why this server exists").
- Add `get_notifications`: the authenticated user's AniList notifications
  (airing episodes, activity/thread likes/replies/mentions, new followers,
  media/staff/character data-submission updates) — AniList's `Notification`
  union has 20 possible types, each surfaced with its own distinguishing
  reference (`media`/`user`/`thread`/`staff`/`character`) alongside the
  common `id`/`type`/`context`/`createdAt` fields.
- Add 45 tools covering anime/manga search and details (incl. per-title
  characters/voice-actors, staff, reviews, related media, score/status
  statistics, and airing schedule), standalone characters/staff/studios,
  genres/tags, recommendations, forum threads, activity feeds, and personal
  AniList list management (add/update/remove entries, favourites, follow,
  posting/deleting activity, deleting threads, account settings). Anime/manga
  variants of the same operation (e.g. `get_anime`/`get_manga`,
  `search_anime`/`search_manga`, `favourite_anime`/`favourite_manga`) are
  unified into a single tool taking a `type`/`kind` parameter instead of
  duplicating the tool per media type.
- Add `login_anilist`/`submit_anilist_redirect`: an Authorization Code Grant
  OAuth flow with localhost auto-capture (falls back to manual redirect paste
  for remote/headless hosts), matching the sibling servers' login UX.
- Cache read-only GraphQL queries in-memory (`CACHE_TTL_MS`, keyed per-account
  — not just whether the caller was authenticated) instead of re-hitting
  AniList on every call.
- Add five MCP Prompts (`recommend_similar`, `seasonal_overview`,
  `hidden_gems`, `catch_up_activity`, `check_notifications`) — reusable
  multi-step plans a client can offer as one-click flows instead of the user
  chaining tool calls manually.
- Declare an `outputSchema` on every tool, describing its `structuredContent`
  shape so clients can validate/introspect tool results instead of only
  getting an opaque JSON blob.
- Publish a one-click `.mcpb` bundle as a release asset for MCP clients that
  support drag-and-drop install (e.g. Claude Desktop), alongside the source
  install path.
- Run on MCP TypeScript SDK v2 beta (`@modelcontextprotocol/server`, pinned
  to an exact `2.0.0-beta.x`) — see AGENTS.md for the plan to bump to the
  first stable v2 release.

### Fixed

- Fix `seasonal_overview`'s prompt instructions to drop the `status_in:
["RELEASING"]` filter when a specific past/future `season`+`year` is given,
  instead of always applying it — a past season's titles are long since
  `FINISHED`, so the old instructions would have told the model to search for
  results that can never match.
- Have `catch_up_activity`'s prompt instructions check both the anime AND
  manga CURRENT list groups, instead of only anime.
- Never cache `get_notifications` — its `resetNotificationCount` argument is
  a real one-time side effect and its result must reflect the current
  notification list, so a repeated call within the read-cache window no
  longer silently skips the badge reset or returns a stale list.
- Classify `add_list_entry`/`update_list_entry`'s advancedScores validation
  failures (unmatched category names, unresolvable media type) as a proper
  `bad_request` tool error instead of an unclassified internal error, so the
  specific, actionable message reaches the caller instead of a generic
  "Unexpected error" wrapper.
- Surface a gated tool's actual "run login_anilist" guidance instead of a
  generic "credentials rejected" message when no token is configured —
  previously any `unauthorized` error was mapped to the same templated text
  regardless of whether it came from AniList itself or from our own
  pre-flight check, discarding the specific fix instructions.
- Return the actual saved/deleted data from `add_list_entry`/
  `update_list_entry`/`remove_list_entry`, the favourite/follow/activity/
  thread mutation tools, and `update_user`, instead of the raw GraphQL
  response envelope.
- Reject `remove_list_entry`/`delete_activity`/`delete_thread` when AniList
  reports `deleted: false` (already gone, or not owned by the caller), instead
  of reporting a successful deletion that didn't actually happen.
- Reject `get_user_activity`/`catch_up_activity` with a clear "no such user"
  error when the given username doesn't resolve to any AniList account,
  instead of silently falling back to the site-wide global activity feed.
- Report `get_studio` as a real tool error (not a disguised success result)
  when neither `id` nor `name` is given.
- Send the logged-in user's token on read tools (get_media, search_media,
  get_user_profile, get_user_list, etc.) when one is configured, so
  viewer-relative fields (`isFavourite`, `isFollowing`, `isFollower`) and the
  caller's own private list entries resolve correctly instead of always
  looking logged-out.
- Generate and verify an OAuth `state` value in `login_anilist`, rejecting a
  callback/redirect that doesn't match the login attempt that started it —
  and don't clear that check prematurely if the token exchange itself fails.
- Disable retries on the OAuth token exchange, since an authorization code is
  single-use and a retry would just replay an already-consumed code; report a
  clear "run login_anilist again" message on a rejected code instead of a
  generic "bad request" one.
- Convert `add_list_entry`/`update_list_entry`'s `score` to AniList's raw
  0-100 scale before sending, instead of assuming every account's configured
  `scoreFormat` is 0-10 — previously a non-decimal-10 account would have its
  score silently written on the wrong scale.
- Order `advancedScores` against the account's actual configured
  advanced-scoring categories for the entry's real anime/manga type (fetched
  live, uncached) and convert it to AniList's raw 0-100 scale, instead of
  sending it in the input object's own key order on a 0-10 scale — previously
  every write was silently off by 10x, and an account with overlapping
  anime/manga category names could have a score filed under the wrong
  category entirely.
