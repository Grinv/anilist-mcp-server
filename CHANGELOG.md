# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `search_thread`, `post_thread`, `post_thread_comment`, and `delete_thread_comment` — forum threads were previously read/delete-only.

### Fixed

- Stop every `pageInfo` field (`total`, `perPage`, `currentPage`, `lastPage`, `hasNextPage`) from failing output validation when AniList returns `null` for it instead of omitting it — confirmed live on an emptied thread's comment page.

## [0.1.4] - 2026-07-21

### Added

- Return `rankings` from `get_media` — AniList's own ranking badges (e.g. "#134 highest rated all time", "#11 highest rated 2024").

### Fixed

- Stop `search_media` from treating an empty/whitespace `term` differently from an omitted one — it now falls back to the documented term-less browse/ranking mode instead of silently returning zero results.
- Paginate `get_media_tags` (`page`/`perPage`) instead of always returning the full ~425-tag list in one response.
- Paginate `get_user_list` by `chunk`/`perChunk` (AniList's own mechanism for this field) instead of returning a user's entire list in one response.
- Stop blaming "credentials" for every 401/403: the error message now distinguishes a token that was actually sent (invalid/expired, or the account just isn't allowed to do this specific thing) from no token at all (log in for an anonymous 401; a likely WAF block or outage, not a permissions problem, for an anonymous 403).
- Bound every AniList numeric-ID input to GraphQL's 32-bit `Int` range, so an out-of-range ID now fails local validation with a clear message instead of a raw upstream GraphQL type error.

## [0.1.3] - 2026-07-21

### Fixed

- Fix a startup race where a `SIGINT`/`SIGTERM` arriving between `serveStdio()` starting and the signal handlers being registered would kill the process immediately instead of shutting down gracefully — handlers are now armed first. ([40d16ba](https://github.com/Grinv/anilist-mcp-server/commit/40d16ba))

## [0.1.2] - 2026-07-21

### Fixed

- Reject a malformed `access_token` in AniList's OAuth token response with a clear error, instead of silently storing it. ([38c193c](https://github.com/Grinv/anilist-mcp-server/commit/38c193c))
- Stop `get_media_tags`'s description from implying `search_media` can filter results by tag — it can't. ([ed171f7](https://github.com/Grinv/anilist-mcp-server/commit/ed171f7))

### Changed

- Expose `ANILIST_OAUTH_PORT` and `ANILIST_TOKEN_STORE` in the `.mcpb` install form and MCP Registry entry, not just as env vars. ([d75eaf1](https://github.com/Grinv/anilist-mcp-server/commit/d75eaf1))
- Clarify several tool and prompt descriptions (activity/recommendation ID sources, `search_media`'s term-less sort/browse mode, `get_user_recent_activity`'s fixed 5-post count) to reduce cross-tool mix-ups. ([ed171f7](https://github.com/Grinv/anilist-mcp-server/commit/ed171f7))

## [0.1.1] - 2026-07-21

### Added

- Add a `sort` parameter to `search_media` — the underlying client already supported it, but the tool never exposed it. ([94bbd20](https://github.com/Grinv/anilist-mcp-server/commit/94bbd20))
- Add `excludeInList` to `get_recommendations_for_media`, filtering out recommendations already on the caller's own list. ([94bbd20](https://github.com/Grinv/anilist-mcp-server/commit/94bbd20))

## [0.1.0] - 2026-07-21

Everything below is one commit: [f84674f](https://github.com/Grinv/anilist-mcp-server/commit/f84674f).

### Added

- Initial release: an MCP server for AniList's GraphQL API, replacing the broken third-party `anilist-mcp` wrapper (see AGENTS.md's "Why this server exists").
- Add 45 tools covering anime/manga search and details, characters/staff/studios, genres/tags, recommendations, forum threads, activity feeds, notifications, and personal AniList list management.
- Unify anime/manga tool pairs (e.g. `get_anime`/`get_manga`, `search_anime`/`search_manga`) into a single tool taking a `type` parameter, instead of one tool per media type.
- Add `get_notifications` for the authenticated user's AniList notifications (airing episodes, activity/thread activity, new followers).
- Add `login_anilist`/`submit_anilist_redirect`: an OAuth login flow with localhost auto-capture, falling back to manual redirect paste for remote/headless hosts.
- Cache read-only GraphQL queries in-memory (`CACHE_TTL_MS`) instead of re-hitting AniList on every call.
- Add five MCP Prompts (`recommend_similar`, `seasonal_overview`, `hidden_gems`, `catch_up_activity`, `check_notifications`) as one-click multi-step flows.
- Declare an `outputSchema` on every tool so clients can validate/introspect `structuredContent` instead of an opaque blob.
- Publish a one-click `.mcpb` bundle as a release asset for drag-and-drop MCP clients (e.g. Claude Desktop).
- Run on MCP TypeScript SDK v2 beta (`@modelcontextprotocol/server`, pinned to an exact version).

### Fixed

- Fix `seasonal_overview` to only filter by `RELEASING` for the current season, not an explicit past/future one.
- Have `catch_up_activity` check both the anime AND manga list groups, not just anime.
- Never cache `get_notifications`, since its `resetNotificationCount` side effect and result must always be fresh.
- Classify `add_list_entry`/`update_list_entry`'s advancedScores validation failures as a `bad_request` tool error instead of an unclassified one.
- Surface a gated tool's actual login guidance instead of a generic "credentials rejected" message.
- Return the actual saved/deleted data from every mutation tool, instead of the raw GraphQL response envelope.
- Reject `remove_list_entry`/`delete_activity`/`delete_thread` when AniList reports `deleted: false`, instead of a false success.
- Reject `get_user_activity`/`catch_up_activity` with a clear error when the given username doesn't resolve, instead of silently returning the global feed.
- Report `get_studio` as a real tool error, not a disguised success, when neither `id` nor `name` is given.
- Send the logged-in user's token on read tools when configured, so viewer-relative fields (`isFavourite`, `isFollowing`, `isFollower`) resolve correctly.
- Verify the OAuth `state` value in `login_anilist`, rejecting a mismatched callback.
- Disable retries on the OAuth token exchange, since an authorization code is single-use.
- Convert `add_list_entry`/`update_list_entry`'s `score` to AniList's raw 0-100 scale, instead of assuming a 0-10 `scoreFormat`.
- Order `advancedScores` against the account's real configured categories for the entry's actual media type, instead of guessing from key overlap.
