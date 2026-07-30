# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Raise the minimum supported Node.js version to ≥ 20.11.0 (was ≥ 20). [6adffb4](https://github.com/Grinv/anilist-mcp-server/commit/6adffb4) [90c540d](https://github.com/Grinv/anilist-mcp-server/commit/90c540d)

### Fixed

- Correct `idempotentHint` to `false` on `delete_activity`/`delete_thread`/`delete_thread_comment`/`remove_list_entry` — each one errors, not silently succeeds, when retried on an already-deleted id. [fc4fc5e](https://github.com/Grinv/anilist-mcp-server/commit/fc4fc5e)
- Document that `update_list_entry`'s `customLists` replaces the entry's full set of enabled lists, not merges — the same warning `add_list_entry`'s identical field already had. [53f8351](https://github.com/Grinv/anilist-mcp-server/commit/53f8351)
- Document that `update_list_entry`'s `hiddenFromStatusLists` still counts the entry in statistics — the same clause `add_list_entry`'s identical field already had. [eceace6](https://github.com/Grinv/anilist-mcp-server/commit/eceace6)
- Document that `post_thread`'s `sticky` is confirmed live to silently no-op for a non-mod account, matching `locked`'s existing wording (both were verified together). [eceace6](https://github.com/Grinv/anilist-mcp-server/commit/eceace6)
- Document that `search_media`'s `onList` silently no-ops when not logged in, matching `get_recommendations_for_media`'s `excludeInList`. [ad6d8a7](https://github.com/Grinv/anilist-mcp-server/commit/ad6d8a7)
- Fix `update_user`'s `notificationOptions`/`disabledListActivity` to actually reject a duplicated type — the old check only verified full coverage, not array length, so a duplicate-plus-full-coverage array silently passed despite both fields' "exactly once" description. [2cfa0fe](https://github.com/Grinv/anilist-mcp-server/commit/2cfa0fe)
- Document that `get_studio`'s `name` already does AniList's own fuzzy search, so a partial name resolves directly without needing `search_studio` first. [995e071](https://github.com/Grinv/anilist-mcp-server/commit/995e071)
- Reject a manga id in `get_anime_schedule` instead of silently returning an empty schedule; also stop discarding `hasNextPage` from its output. [a3c7664](https://github.com/Grinv/anilist-mcp-server/commit/a3c7664)
- Type `get_recommendation`/`get_recommendations_for_media`'s `rating`/`userRating` fields per AniList's actual schema (a plain int and a real 3-value enum), not generic number/string. [9bf34b5](https://github.com/Grinv/anilist-mcp-server/commit/9bf34b5)
- Reject `post_thread` calls that omit `categories` when creating a new thread, matching AniList's own mutation requirement, instead of surfacing an upstream error. [67ec0fc](https://github.com/Grinv/anilist-mcp-server/commit/67ec0fc)
- Correct `update_user`'s stale "not atomic" claim (its one confirmed trigger is now blocked client-side) and narrow `get_authorized_user`'s unconfirmed claim that `advancedScoring` is full-replace the same way `customLists` is. [3784af2](https://github.com/Grinv/anilist-mcp-server/commit/3784af2)
- Clarify `login_anilist`'s `auto_capture` only reflects whether this server could bind a local port, not whether the browser is actually local. [6c48045](https://github.com/Grinv/anilist-mcp-server/commit/6c48045)
- Document that `get_user_activity` returns every activity type (including received messages), not just list updates/text posts as previously stated. [39981cc](https://github.com/Grinv/anilist-mcp-server/commit/39981cc)
- Fix `get_notifications`' `pageInfo` output to match its actual query (only `hasNextPage` is ever returned). [3594f1d](https://github.com/Grinv/anilist-mcp-server/commit/3594f1d)
- Document `get_user_list`'s ~11,000-entry AniList-side cap. [902ccb1](https://github.com/Grinv/anilist-mcp-server/commit/902ccb1)
- Confirm `post_thread`'s `categories` is a full replace (not a merge) when set on an update. [0554ff6](https://github.com/Grinv/anilist-mcp-server/commit/0554ff6)
- Disclose `isFavourite`'s confirmed read-after-write staleness consistently across `get_media`/`get_character`/`get_staff`/`get_studio` (previously only documented for `get_media`), and add `get_media`'s missing `mediaListEntry` disclosure. [76196f0](https://github.com/Grinv/anilist-mcp-server/commit/76196f0)

### Security

- Harden log redaction to also strip JSON-style credentials (`"client_secret":"..."`), matching the OAuth token exchange's actual request body shape. [0a70a08](https://github.com/Grinv/anilist-mcp-server/commit/0a70a08)

## [0.5.0] - 2026-07-29

### Added

- Add an hour-long public cache hint to `tools/list`/`prompts/list`/`server/discover` for 2026-07-28-era clients.
  Safe because every tool/prompt here registers unconditionally, with no runtime/auth-dependent branching. [482bb10](https://github.com/Grinv/anilist-mcp-server/commit/482bb10)
- Add AniList-schema-sourced length/format limits to mutation tool inputs, rejecting invalid values locally instead of an upstream round trip. [307321d](https://github.com/Grinv/anilist-mcp-server/commit/307321d)

### Changed

- Bump `@modelcontextprotocol/server`/`client` to the first stable `2.0.0` (from `2.0.0-beta.5`).
  No breaking changes — the only two behavior changes since beta.5 don't affect this stdio-only server. [036788f](https://github.com/Grinv/anilist-mcp-server/commit/036788f)
- Move `get_studio`'s id/name check into its Zod schema — same core message, now wrapped in the SDK's validation-error prefix. [307321d](https://github.com/Grinv/anilist-mcp-server/commit/307321d)
- Document that `update_user`'s `profileColor` silently ignores bad values, while `rowOrder`/`timezone` reject them with a clear error (confirmed live). [307321d](https://github.com/Grinv/anilist-mcp-server/commit/307321d)

## [0.4.0] - 2026-07-28

Everything below is one commit: [48049f6](https://github.com/Grinv/anilist-mcp-server/commit/48049f6).

### Added

- Add `pageInfo.lastPage` to `get_media_tags`'s response — computed client-side, so unlike AniList-paginated tools it's accurate, not degraded.

### Changed

- **BREAKING:** Rename tools `favourite` → `toggle_favourite` and `follow_user` → `toggle_follow_user`, matching this server's verb+resource naming.
  Update any pinned tool names in your own configs/prompts.
- Document that `update_user`'s `customLists` replaces the whole array rather than merging by name.
  Omitting an existing list silently deletes it.
- Document that `add_list_entry` upserts by media ID rather than always creating a fresh entry.
  Unset fields (including `status`) keep their previous value on an existing entry, not a new-entry default.
- Document that `add_list_entry`/`update_list_entry`'s `customLists` replaces an entry's full set of enabled lists, not merges.
  Naming only a subset silently un-tags every list left out.
- Document a third `update_user` full-replace exception: `customLists`, alongside `notificationOptions`/`disabledListActivity`.
- Document that reordering/renaming `advancedScoring` categories silently reinterprets already-stored per-category scores.
- Document that `get_user_stats`/`get_full_user_info` statistics can lag behind an account's real list state (AniList's own aggregation).
- Document that `post_message_activity` is always public — AniList's mutation accepts a `private` argument this tool doesn't expose.
- Document `search_activity`'s asymmetric `user` validation: unknown username errors, unknown numeric ID silently returns empty.
- Document that `search_thread`'s `categoryId`/`mediaCategoryId` silently filter to an empty result on an unknown ID.
- Document that `search_media`'s `genres`/`tag_in` silently filter to no results on an unrecognized name, matching `format_in`.
- Document that `get_user_recent_activity` returns full activity content, not just IDs.
- Document that `update_user`'s `notificationOptions`/`disabledListActivity` entries require an explicit `enabled`/`disabled` value.
  Omitting it writes `null` on `notificationOptions`, but fails the whole call with a `500` on `disabledListActivity` (confirmed live).
- Document that `search_user` points to specific downstream tools (profile, stats, list, follow), not a generic "profile/list tools."
- Document that `get_media_characters`/`get_media_staff` request no explicit ordering, unlike `get_character`/`get_staff`'s popularity sort.
- Document that `get_anime_schedule` returns results soonest-airing first.
- Document `get_recommendations_for_media`'s `mediaListEntry` login-gating, and add its missing `pageInfo.hasNextPage` to the output schema.

## [0.3.0] - 2026-07-26

### Added

- Add `page`/`perPage` pagination to `get_site_statistics` (previously fixed to the last 7 days); AniList caps `perPage` at 25 regardless of input. [4af0916](https://github.com/Grinv/anilist-mcp-server/commit/4af0916)

### Changed

- Halve `get_thread_comments`'s network round-trips for a given `threadId` by combining the not-found existence check into the same request as the real query, instead of a separate one. [4268f5f](https://github.com/Grinv/anilist-mcp-server/commit/4268f5f)
- Add missing `destructiveHint`/`idempotentHint`/`openWorldHint` MCP tool annotations across write tools, for accurate client-side risk hints. [ff469f6](https://github.com/Grinv/anilist-mcp-server/commit/ff469f6)
- Document that `get_studio`'s returned titles cap at 10 and `get_todays_birthdays`'s results cap at 50 — both fixed, unpaginated limits. [ff469f6](https://github.com/Grinv/anilist-mcp-server/commit/ff469f6)
- Document that `favourite` returns the account's entire current favourites across all 5 categories, not just the toggled item. [ff469f6](https://github.com/Grinv/anilist-mcp-server/commit/ff469f6)
- Document that `get_user_activity` doesn't filter by activity type, cross-referencing `search_activity` for that. [ff469f6](https://github.com/Grinv/anilist-mcp-server/commit/ff469f6)

## [0.2.2] - 2026-07-25

### Changed

- Rename `search_activity`'s `userId` parameter to `user`, accepting a username too — the old name was silently ignored, falling back to the unfiltered global feed instead of erroring. [f2b28bd](https://github.com/Grinv/anilist-mcp-server/commit/f2b28bd)
- Document that `delete_activity`/`delete_thread`/`delete_thread_comment`/`remove_list_entry` error on an already-deleted id instead of silently succeeding. [8fa063c](https://github.com/Grinv/anilist-mcp-server/commit/8fa063c)
- Document that `add_list_entry`/`update_list_entry`'s `advancedScores` errors when advanced scoring is disabled or a category name doesn't match. [8fa063c](https://github.com/Grinv/anilist-mcp-server/commit/8fa063c)

### Fixed

- Surface the real upstream error detail for 5xx/network/timeout/rate-limit/not-modified tool errors instead of a generic message. [2c2fe8b](https://github.com/Grinv/anilist-mcp-server/commit/2c2fe8b)
- Fix `get_media`'s `ids` and every user-scoped tool's `user` parameter wrongly saying "is required" for a present-but-wrongly-typed value. [189c21a](https://github.com/Grinv/anilist-mcp-server/commit/189c21a)

## [0.2.1] - 2026-07-23

### Changed

- Halve `get_anime_schedule`/`get_user_activity`'s network round-trips for a given `mediaId` or numeric user ID by combining the not-found existence check into the same request as the real query, instead of a separate one. [aacfa8b](https://github.com/Grinv/anilist-mcp-server/commit/aacfa8b)

### Fixed

- Fix `get_user_activity` silently returning an empty activity list for a nonexistent numeric user ID instead of an error, unlike its existing username path. [33a0262](https://github.com/Grinv/anilist-mcp-server/commit/33a0262)
- Fix `get_anime_schedule` silently returning an empty schedule for a nonexistent `mediaId` instead of an error. [33a0262](https://github.com/Grinv/anilist-mcp-server/commit/33a0262)
- Fix several single-ID tools (`get_activity`, `get_character`, `get_staff`, `get_studio`, `get_recommendation`, `get_recommendations_for_media`, `get_thread`, `get_media_statistics`, `get_media_characters`, `get_media_staff`, `get_media_reviews`, `get_media_relations`) crashing or silently returning invalid output for a nonexistent ID — they now return a clean not-found error instead. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Fix `get_media` silently dropping array `ids` that don't resolve to a real title — it now fills `null` in that position instead, keeping the result the same length as `ids`. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Fix `get_thread_comments` returning a misleadingly-empty success for a nonexistent `threadId` instead of an error. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Fix not-found tool errors discarding their specific detail (e.g. which ID was invalid) behind a generic "(404)" message. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Fix a 403 error always blaming the authenticated account's permissions, even when it's actually an unrelated upstream security block (e.g. a WAF rejecting unusual request content). [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Fix inline GraphQL errors always being classified as a generic bad request, even when AniList embeds a specific status (e.g. 404/401) in the response. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Reject `add_list_entry`/`update_list_entry`'s `advancedScores` values outside the documented 0-10 scale, instead of accepting e.g. `15` silently. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Give a clear validation message for `get_media`'s `ids` and every user-scoped tool's `user` parameter when missing/malformed, instead of a generic Zod error. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Clarify `get_user_profile`/`get_full_user_info`'s description: the account settings they return (notifications, list display, etc.) aren't restricted to the caller's own account — AniList returns them for any user looked up. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Clarify `favourite`'s description: AniList doesn't validate that `id` actually belongs to the given `kind` — a mismatched pair silently succeeds instead of erroring. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)
- Fix the `seasonal_overview` prompt ignoring `season`/`year` when only one of the two was given, instead of treating them as the independent filters `search_media` actually supports. [58ee542](https://github.com/Grinv/anilist-mcp-server/commit/58ee542)

## [0.2.0] - 2026-07-22

Everything below is one commit: [0a537f7](https://github.com/Grinv/anilist-mcp-server/commit/0a537f7).

### Added

- Add `tag_in`, `onList`, `averageScore`/`popularity`/`episodes` range filters, `startDate`/`endDate` range filters, and `source_in` to `search_media`.
- Add `includeDescription` to `search_media`, returning each result's full synopsis on request (kept off by default — up to 25 results per call).
- Return `media`/`staffMedia` filmography (with `characterRole`/`staffRole`) from `get_character`/`get_staff`.
- Add `includeBody` to `get_media_reviews`, returning each review's full text on request (kept off by default — it can be long).
- Return `nextAiringEpisode`, `externalLinks`, and (login required) `mediaListEntry` from `get_media`; add `includeStreamingEpisodes` for `streamingEpisodes` (kept off by default — AniList doesn't paginate this field, so long-running titles can return hundreds of entries).
- Return `replyCount`/`likeCount`/`isLiked` from activity tools, and `replyCount`/`viewCount`/`likeCount`/`isLiked` from thread/comment tools.
- Add `airingNotifications`, `profileColor`, `donatorBadge`, `timezone`, `activityMergeTime`, `staffNameLanguage`, and `restrictMessagesToFollowing` to `update_user`.
- Add `rowOrder` to `update_user`, readable back via `mediaListOptions.rowOrder`.
- Add `notificationOptions` to `update_user` — requires all 20 notification types every call, since AniList replaces the entire list rather than merging a partial one.
- Add `disabledListActivity` to `update_user` — requires all 6 list statuses every call; AniList rejects a partial list.
- Add `animeListOptions`/`mangaListOptions` to `update_user` (advanced scoring, custom lists, list display settings, and `theme`) — previously not settable at all; `theme`'s AniList read-back is an untyped, deprecated value, not guaranteed to match what was set.
- Add `hiddenFromStatusLists` to `add_list_entry`/`update_list_entry`, and return it from `get_user_list`.
- Return `isSticky`, `isLocked`, `mediaCategories`, and `childComments` from the thread read tools, so a `post_thread`/`post_thread_comment` call can actually be verified.
- Return account preferences (`options`, `mediaListOptions`) from the user-profile tools and from `update_user`'s own response, so a settings change can actually be verified.
- Return `customLists` and `advancedScores` from `get_user_list` — previously set via `add_list_entry`/`update_list_entry` but unreadable.

### Fixed

- Stop `search_thread` from treating an empty/whitespace `term` differently from an omitted one (same fix already applied to `search_media`).
- Clear the read cache after every successful mutation — a read immediately after a write could otherwise serve stale pre-mutation data for up to `CACHE_TTL_MS`.
- Correct `add_list_entry`'s description: AniList defaults an entry with no `status` to `CURRENT` (with `startedAt` set to today), not `PLANNING`.
- Clarify that `search_media`'s `season`/`seasonYear` each work standalone (e.g. every Summer across all years) — the previous "pair with X" wording implied they're only meaningful together.
- Give `submit_anilist_redirect` a clean, actionable message when the OAuth redirect denied access or had no `code`, instead of a generic "Unexpected error".
- Reject `add_list_entry`/`update_list_entry`'s `advancedScores` when `advancedScoringEnabled` is `false`, instead of only checking that a category list exists.
- Fix `get_notifications`' ACTIVITY_MESSAGE items always coming back with an empty message: AniList nests the DM text one level inside `message.message`, not directly on `message`.
- Add the 3 stylised variants (`ROMAJI_STYLISED`, `ENGLISH_STYLISED`, `NATIVE_STYLISED`) to `update_user`'s `titleLanguage` — the enum only listed half of AniList's actual options.
- Fix `get_media` with an array of `ids` returning results sorted by AniList's own default order instead of the input order the tool's own description promises — confirmed live (`[154587, 21]` came back as `[21, 154587]`).
- Stop `get_media_tags`' description from claiming `search_media` can't filter by tag — it now can (`tag_in`, added this same release).

### Changed

- Bump `@modelcontextprotocol/server` to `2.0.0-beta.5` (from `beta.4`).

## [0.1.5] - 2026-07-22

Everything below is one commit: [194c7d3](https://github.com/Grinv/anilist-mcp-server/commit/194c7d3).

### Added

- Add `search_thread`, `post_thread`, `post_thread_comment`, and `delete_thread_comment` — forum threads were previously read/delete-only.

### Fixed

- Stop every `pageInfo` field (`total`, `perPage`, `currentPage`, `lastPage`, `hasNextPage`) from failing output validation when AniList returns `null` for it instead of omitting it — confirmed live on an emptied thread's comment page.

## [0.1.4] - 2026-07-21

### Added

- Return `rankings` from `get_media` — AniList's own ranking badges (e.g. "#134 highest rated all time", "#11 highest rated 2024"). ([e47b610](https://github.com/Grinv/anilist-mcp-server/commit/e47b610))

### Fixed

- Stop `search_media` from treating an empty/whitespace `term` differently from an omitted one — it now falls back to the documented term-less browse/ranking mode instead of silently returning zero results. ([30b14c0](https://github.com/Grinv/anilist-mcp-server/commit/30b14c0))
- Paginate `get_media_tags` (`page`/`perPage`) instead of always returning the full ~425-tag list in one response. ([30b14c0](https://github.com/Grinv/anilist-mcp-server/commit/30b14c0))
- Paginate `get_user_list` by `chunk`/`perChunk` (AniList's own mechanism for this field) instead of returning a user's entire list in one response. ([30b14c0](https://github.com/Grinv/anilist-mcp-server/commit/30b14c0))
- Stop blaming "credentials" for every 401/403: the error message now distinguishes a token that was actually sent (invalid/expired, or the account just isn't allowed to do this specific thing) from no token at all (log in for an anonymous 401; a likely WAF block or outage, not a permissions problem, for an anonymous 403). ([30b14c0](https://github.com/Grinv/anilist-mcp-server/commit/30b14c0))
- Bound every AniList numeric-ID input to GraphQL's 32-bit `Int` range, so an out-of-range ID now fails local validation with a clear message instead of a raw upstream GraphQL type error. ([30b14c0](https://github.com/Grinv/anilist-mcp-server/commit/30b14c0))

## [0.1.3] - 2026-07-21

### Fixed

- Fix a startup race where a `SIGINT`/`SIGTERM` arriving between `serveStdio()` starting and the signal handlers being registered would kill the process immediately instead of shutting down gracefully — handlers are now armed first. ([40d16ba](https://github.com/Grinv/anilist-mcp-server/commit/40d16ba))

## [0.1.2] - 2026-07-21

_Note: this version was bumped locally via `npm version` but its tag was never pushed — superseded minutes later by v0.1.3, so it was never published to npm and has no git tag or GitHub Release. The changes below still shipped: they're part of v0.1.3 and every release since. Left as-is rather than retroactively tagging/publishing it now, since `npm publish` would move the `latest` dist-tag backward to this old version._

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
