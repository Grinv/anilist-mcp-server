import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as search from "../clients/anilist/search.js";
import { ApiError } from "../lib/errors.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { activityItem, activityTypeFilter } from "./activity.js";
import {
  pageInfoSchema,
  MEDIA_TYPES,
  idOnly,
  mediaId,
  categoryId,
  userIdOrName,
  paginationFields,
  personDescriptionField,
} from "./outputSchemas.js";

const FORMATS = [
  "TV",
  "TV_SHORT",
  "MOVIE",
  "SPECIAL",
  "OVA",
  "ONA",
  "MUSIC",
  "MANGA",
  "NOVEL",
  "ONE_SHOT",
] as const;
const STATUSES = ["FINISHED", "RELEASING", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"] as const;
const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
const SOURCES = [
  "ORIGINAL",
  "MANGA",
  "LIGHT_NOVEL",
  "VISUAL_NOVEL",
  "VIDEO_GAME",
  "OTHER",
  "NOVEL",
  "DOUJINSHI",
  "ANIME",
  "WEB_NOVEL",
  "LIVE_ACTION",
  "GAME",
  "COMIC",
  "MULTIMEDIA_PROJECT",
  "PICTURE_BOOK",
] as const;

const fuzzyDateFilter = z
  .object({
    year: z.int().positive().describe("Required — a date filter needs at least a year."),
    month: z.int().min(1).max(12).optional(),
    day: z.int().min(1).max(31).optional(),
  })
  .describe("A partial date; omit `month`/`day` you don't want to narrow by.");
// All `_greater`/`_lesser` bounds on Page.media are strict (docs/api-references.md).
const mediaDateBound = (which: "start" | "end", side: "greater" | "lesser") =>
  fuzzyDateFilter
    .optional()
    .describe(
      `Restrict to entries whose ${which} date is strictly ${
        side === "greater" ? "AFTER" : "BEFORE"
      } this date (the bound date itself is excluded). An omitted month/day counts as 0, so ` +
        `{year: 2020} here means ${
          side === "greater" ? '"from 2020-01-01 on"' : '"up to 2019-12-31"'
        }.`,
    );
const MEDIA_SORTS = [
  "ID",
  "ID_DESC",
  "TITLE_ROMAJI",
  "TITLE_ROMAJI_DESC",
  "TITLE_ENGLISH",
  "TITLE_ENGLISH_DESC",
  "TITLE_NATIVE",
  "TITLE_NATIVE_DESC",
  "TYPE",
  "TYPE_DESC",
  "FORMAT",
  "FORMAT_DESC",
  "START_DATE",
  "START_DATE_DESC",
  "END_DATE",
  "END_DATE_DESC",
  "SCORE",
  "SCORE_DESC",
  "POPULARITY",
  "POPULARITY_DESC",
  "TRENDING",
  "TRENDING_DESC",
  "EPISODES",
  "EPISODES_DESC",
  "DURATION",
  "DURATION_DESC",
  "STATUS",
  "STATUS_DESC",
  "CHAPTERS",
  "CHAPTERS_DESC",
  "VOLUMES",
  "VOLUMES_DESC",
  "UPDATED_AT",
  "UPDATED_AT_DESC",
  "SEARCH_MATCH",
  "FAVOURITES",
  "FAVOURITES_DESC",
] as const;

const mediaSearchInput = z.object({
  type: z.enum(MEDIA_TYPES).describe("Whether to search anime or manga."),
  term: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Free-text search term (matches title). Omit to only filter."),
  genres: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict to entries matching ALL of these genre names (see get_genres for valid " +
        "names) — an unrecognized genre name doesn't error, it just filters out all results, " +
        "same silent-mismatch behavior as `format_in`/`tag_in` below.",
    ),
  format_in: z
    .array(z.enum(FORMATS))
    .optional()
    .describe(
      "Restrict to these formats. Only formats valid for the `type` you're searching match " +
        "anything — e.g. NOVEL/ONE_SHOT with type: ANIME, or TV/OVA/ONA with type: MANGA, will " +
        "just filter out all results, not error.",
    ),
  status_in: z.array(z.enum(STATUSES)).optional().describe("Restrict to these release statuses."),
  season: z
    .enum(SEASONS)
    .optional()
    .describe(
      "Restrict to this airing season. Works alone — matches every year's occurrence of that " +
        "season, NOT just the current year (unlike anilist.co's own season filter UI, which " +
        "implicitly assumes the current year when you don't also pick one). Combine with " +
        "`seasonYear` for one specific season+year.",
    ),
  seasonYear: z
    .int()
    .positive()
    .optional()
    .describe(
      "Restrict to this airing/release year (matches any season within it). Works alone or " +
        "combined with `season` for one specific season+year — neither requires the other.",
    ),
  tag_in: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict to entries matching ALL of these exact tag names (see get_media_tags for valid " +
        "names — unlike `genres`, tag names are case-sensitive and more specific, e.g. " +
        '"Time Loop" or "Tragedy"). An unrecognized tag name doesn\'t error, it just silently ' +
        "matches nothing (same behavior as `genres`/`format_in` above, confirmed live).",
    ),
  onList: z
    .boolean()
    .optional()
    .describe(
      "[Requires login] Restrict to (true) or exclude (false) entries already on the " +
        "authenticated user's own list. Omit to ignore list status entirely. Errors if not " +
        "logged in (confirmed live: AniList would otherwise silently ignore it and return " +
        "unfiltered results).",
    ),
  averageScore_greater: z
    .int()
    .nonnegative()
    .max(100)
    .optional()
    .describe("Restrict to entries with an average score strictly greater than this (0-100)."),
  averageScore_lesser: z
    .int()
    .nonnegative()
    .max(100)
    .optional()
    .describe("Restrict to entries with an average score strictly less than this (0-100)."),
  popularity_greater: z
    .int()
    .nonnegative()
    .optional()
    .describe("Restrict to entries with more list-adds than this."),
  popularity_lesser: z
    .int()
    .nonnegative()
    .optional()
    .describe("Restrict to entries with fewer list-adds than this."),
  episodes_greater: z
    .int()
    .nonnegative()
    .optional()
    .describe("Restrict to entries with more episodes/chapters than this."),
  episodes_lesser: z
    .int()
    .nonnegative()
    .optional()
    .describe("Restrict to entries with fewer episodes/chapters than this."),
  startDate_greater: mediaDateBound("start", "greater"),
  startDate_lesser: mediaDateBound("start", "lesser"),
  endDate_greater: mediaDateBound("end", "greater"),
  endDate_lesser: mediaDateBound("end", "lesser"),
  source_in: z
    .array(z.enum(SOURCES))
    .optional()
    .describe("Restrict to entries adapted from these source material types."),
  genre_not_in: z
    .array(z.string())
    .optional()
    .describe(
      "Exclude entries having ANY of these genres. Unlike `genres`, an unrecognized name " +
        "excludes nothing (no-op, confirmed live).",
    ),
  tag_not_in: z
    .array(z.string())
    .optional()
    .describe("Exclude entries having ANY of these exact tag names (see `tag_in`)."),
  minimumTagRank: z
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Only count a tag in `tag_in`/`tag_not_in` when its relevance rank (0-100, as in " +
        "get_media's `tags[].rank`) is at least this — e.g. 90 for titles where the tag is " +
        "central, not incidental. Applies to both lists (confirmed live).",
    ),
  format_not_in: z.array(z.enum(FORMATS)).optional().describe("Exclude these formats."),
  status_not_in: z.array(z.enum(STATUSES)).optional().describe("Exclude these release statuses."),
  countryOfOrigin: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .describe(
      'Restrict to this country of origin, as an uppercase ISO 3166-1 alpha-2 code (e.g. "JP", ' +
        '"KR" for manhwa, "CN" for manhua/donghua, "TW"). An unused code matches nothing.',
    ),
  duration_greater: z
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Anime only: episode length strictly greater than this, in minutes. With type: MANGA " +
        "AniList silently applies it to volume count instead (shared column, confirmed live).",
    ),
  duration_lesser: z
    .int()
    .nonnegative()
    .optional()
    .describe("Anime only: episode length strictly less than this, in minutes (see above)."),
  chapters_greater: z
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Manga only: more chapters than this. Same underlying column as `episodes_greater` — " +
        "with type: ANIME it filters episode count (confirmed live).",
    ),
  chapters_lesser: z
    .int()
    .nonnegative()
    .optional()
    .describe("Manga only: fewer chapters than this (same column as `episodes_lesser`)."),
  volumes_greater: z
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Manga only: more volumes than this. With type: ANIME AniList silently applies it to " +
        "episode duration instead (shared column, confirmed live).",
    ),
  volumes_lesser: z
    .int()
    .nonnegative()
    .optional()
    .describe("Manga only: fewer volumes than this (see above)."),
  licensedBy_in: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict to entries licensed/streamed by ANY of these sites (names as in get_media's " +
        '`externalLinks[].site`, e.g. "Crunchyroll", "Netflix"; case-insensitive). An ' +
        "unrecognized site name matches nothing.",
    ),
  sfw: z
    .boolean()
    .default(false)
    .describe(
      "Set true to exclude adult (isAdult) entries — same as `isAdult: false`. Adult results " +
        "are NOT filtered by default.",
    ),
  isAdult: z
    .boolean()
    .optional()
    .describe(
      "AniList's own adult-content filter: true returns ONLY adult (18+) entries, false " +
        "excludes them (same as `sfw: true`). Omit to include both. No login or account " +
        "setting is needed for adult results. `sfw: true` with `isAdult: true` contradict " +
        "each other and are rejected.",
    ),
  sort: z
    .array(z.enum(MEDIA_SORTS))
    .nonempty()
    .optional()
    .describe(
      'Sort order, most-significant key first (e.g. ["SCORE_DESC"] for highest-rated first, ' +
        '["POPULARITY_DESC"] for most popular, ["TRENDING_DESC"] for what\'s hot right now). ' +
        "Defaults to relevance-ranked SEARCH_MATCH when a `term` is given; with no term and no " +
        "explicit sort, results come back in AniList's own default order. Set an explicit sort " +
        "for a term-less ranking/browse query (e.g. top-rated or most-popular).",
    ),
  includeDescription: z
    .boolean()
    .default(false)
    .describe(
      "Also fetch each result's full synopsis (`description`). Kept off by default — with " +
        "up to 50 results per call, always including it would burn tokens on text you may not " +
        "need; use get_media for a single title's full synopsis instead.",
    ),
  ...paginationFields(10),
});

/** search_media's `isAdult` value from its two adult-content fields. `sfw`
 *  predates `isAdult` and is kept (not renamed) on purpose: no schema here is
 *  strict, so a removed key would be silently dropped and a caller still
 *  sending `sfw: true` would start getting adult results. The one
 *  contradictory combination is rejected rather than resolved either way.
 *  Done here, not as a schema refine, so the inputSchema stays a plain
 *  object for JSON Schema conversion. */
function adultFilter(sfw: boolean, isAdult: boolean | undefined): boolean | undefined {
  if (sfw && isAdult === true) {
    throw new ApiError({
      code: "bad_request",
      message:
        "`sfw: true` excludes adult titles but `isAdult: true` asks for only adult titles — " +
        "pass just one: `isAdult: true` for adult-only, or `sfw: true` (or `isAdult: false`) " +
        "to exclude them.",
    });
  }
  return isAdult ?? (sfw ? false : undefined);
}

// Search results are lists of AniList media/character/staff/etc. objects —
// per the precision policy, each item is typed loosely (id + passthrough)
// rather than duplicating the full MEDIA_FIELDS/CHARACTER_FIELDS/etc. shape.
// Exception: search_activity reuses activity.ts's activityItem, since its
// query already selects the full ACTIVITY_FRAGMENT, not just `id`.

export function registerSearchTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "search_media",
    {
      title: "Search anime/manga",
      description:
        "Search AniList for anime or manga by title and/or filters (genre, tag, format, status, " +
        "season/year, country, length — most with an exclusion variant), or browse term-less " +
        "by ranking (top-rated, most popular, trending — see the `sort` parameter) when you " +
        "don't have a title to search for. Adult (NSFW) results are included unless you set " +
        "`sfw: true` (or `isAdult: false`); `isAdult: true` returns adult titles only. Returns " +
        "AniList IDs to use with get_media and other ID-based tools.",
      inputSchema: mediaSearchInput,
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), media: z.array(idOnly).optional() })
          .loose(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      guard(async () =>
        jsonResult({
          results: await search.searchMedia(client.ctx(), args.type, {
            term: args.term,
            page: args.page,
            perPage: args.perPage,
            sort: args.sort,
            includeDescription: args.includeDescription,
            filter: {
              isAdult: adultFilter(args.sfw, args.isAdult),
              genre_in: args.genres,
              format_in: args.format_in,
              status_in: args.status_in,
              season: args.season,
              seasonYear: args.seasonYear,
              tag_in: args.tag_in,
              onList: args.onList,
              averageScore_greater: args.averageScore_greater,
              averageScore_lesser: args.averageScore_lesser,
              popularity_greater: args.popularity_greater,
              popularity_lesser: args.popularity_lesser,
              episodes_greater: args.episodes_greater,
              episodes_lesser: args.episodes_lesser,
              startDate_greater: args.startDate_greater,
              startDate_lesser: args.startDate_lesser,
              endDate_greater: args.endDate_greater,
              endDate_lesser: args.endDate_lesser,
              source_in: args.source_in,
              genre_not_in: args.genre_not_in,
              tag_not_in: args.tag_not_in,
              minimumTagRank: args.minimumTagRank,
              format_not_in: args.format_not_in,
              status_not_in: args.status_not_in,
              countryOfOrigin: args.countryOfOrigin,
              duration_greater: args.duration_greater,
              duration_lesser: args.duration_lesser,
              chapters_greater: args.chapters_greater,
              chapters_lesser: args.chapters_lesser,
              volumes_greater: args.volumes_greater,
              volumes_lesser: args.volumes_lesser,
              licensedBy_in: args.licensedBy_in,
            },
          }),
        }),
      ),
  );

  server.registerTool(
    "search_character",
    {
      title: "Search characters",
      description:
        "Search AniList for characters by name. Returns AniList IDs to use with get_character. " +
        "Each result's bio (`description`) is omitted unless you set `includeDescription`.",
      inputSchema: z.object({
        term: z.string().trim().min(1).describe("Character name (or part of it) to search for."),
        includeDescription: personDescriptionField("get_character"),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), characters: z.array(idOnly).optional() })
          .loose(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ term, page, perPage, includeDescription }) =>
      guard(async () =>
        jsonResult({
          results: await search.searchCharacter(
            client.ctx(),
            term,
            page,
            perPage,
            includeDescription,
          ),
        }),
      ),
  );

  server.registerTool(
    "search_staff",
    {
      title: "Search staff",
      description:
        "Search AniList for staff members by name. Returns AniList IDs to use with get_staff. " +
        "Each result's bio (`description`) is omitted unless you set `includeDescription`.",
      inputSchema: z.object({
        term: z.string().trim().min(1).describe("Staff member name (or part of it) to search for."),
        includeDescription: personDescriptionField("get_staff"),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), staff: z.array(idOnly).optional() })
          .loose(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ term, page, perPage, includeDescription }) =>
      guard(async () =>
        jsonResult({
          results: await search.searchStaff(client.ctx(), term, page, perPage, includeDescription),
        }),
      ),
  );

  server.registerTool(
    "search_studio",
    {
      title: "Search studios",
      description:
        "Search/browse AniList's animation/production studios by name, when you want to see " +
        "multiple candidates rather than take the closest match — get_studio's own `name` " +
        "param already does this same fuzzy search directly and resolves a partial name on its " +
        "own. Returns AniList IDs to use with get_studio.",
      inputSchema: z.object({
        term: z.string().trim().min(1).describe("Studio name (or part of it) to search for."),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), studios: z.array(idOnly).optional() })
          .loose(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ term, page, perPage }) =>
      guard(async () =>
        jsonResult({ results: await search.searchStudio(client.ctx(), term, page, perPage) }),
      ),
  );

  server.registerTool(
    "search_user",
    {
      title: "Search users",
      description:
        "Search AniList for users by username. Returns AniList user IDs to use with " +
        "get_user_profile/get_full_user_info (profile), get_user_stats (statistics), " +
        "get_user_list (their public list), or toggle_follow_user.",
      inputSchema: z.object({
        term: z.string().trim().min(1).describe("Username (or part of it) to search for."),
        includeDescription: personDescriptionField("get_user_profile/get_full_user_info", "about"),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), users: z.array(idOnly).optional() })
          .loose(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ term, page, perPage, includeDescription }) =>
      guard(async () =>
        jsonResult({
          results: await search.searchUser(client.ctx(), term, page, perPage, includeDescription),
        }),
      ),
  );

  server.registerTool(
    "search_thread",
    {
      title: "Search forum threads",
      description:
        "Search/browse AniList's forum threads by title/body text and/or restrict to one " +
        "category. Returns AniList thread IDs (with title/category for context) to use with " +
        "get_thread, get_thread_comments, post_thread, or post_thread_comment.",
      inputSchema: z.object({
        term: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Free-text search term (matches thread title/body); results are relevance-ranked. " +
              "Omit to browse, most recently replied-to first.",
          ),
        categoryId: categoryId
          .optional()
          .describe(
            "Restrict to this forum category ID. Not independently listable by any tool — " +
              "resolve one from a thread you've already read (its `categories` field) or from " +
              "a forum URL like anilist.co/forum/recent?category=<id>. A wrong or nonexistent " +
              "ID doesn't error, it silently filters to an empty result — indistinguishable " +
              "from 'no threads in this category.'",
          ),
        mediaCategoryId: mediaId
          .optional()
          .describe(
            "Restrict to threads tagged with this AniList anime/manga ID (from " +
              "search_media/get_media). Not existence-checked: a nonexistent media ID doesn't " +
              "error, it silently filters to an empty result — resolve the ID via search_media " +
              "first if you need to confirm the title actually exists.",
          ),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), threads: z.array(idOnly).optional() })
          .loose(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ term, categoryId, mediaCategoryId, page, perPage }) =>
      guard(async () =>
        jsonResult({
          results: await search.searchThread(
            client.ctx(),
            term,
            categoryId,
            mediaCategoryId,
            page,
            perPage,
          ),
        }),
      ),
  );

  server.registerTool(
    "search_activity",
    {
      title: "Search activity feed",
      description:
        "Search/browse AniList's activity feed (list updates, text posts, messages), optionally " +
        "filtered to one user or — with `isFollowing` [Requires login] — to your following feed, " +
        "to one or more activity types, and/or to a creation-time window. Each result " +
        "already includes its full content (text/message/status, " +
        "`replyCount`/`likeCount`/`isLiked`, the posting user, " +
        "and — for list activity — the media) — no follow-up get_activity call needed unless " +
        "you need to re-check one specific result's `replyCount`/`likeCount`/`isLiked` later " +
        "(e.g. after liking it).",
      inputSchema: z.object({
        user: userIdOrName
          .optional()
          .describe(
            "Restrict results to this AniList user — numeric ID or exact username (resolved " +
              "to an id with one extra internal lookup; no need to call search_user first " +
              "unless you only have a partial/fuzzy name). An unknown ID or username errors " +
              "with not_found rather than silently returning an empty result.",
          ),
        type: activityTypeFilter(),
        isFollowing: z
          .boolean()
          .optional()
          .describe(
            "[Requires login] Set true for your following feed: activity from users the " +
              "logged-in account follows plus its own (AniList's `isFollowing` filter — confirmed " +
              "live: an account following nobody gets only its own activity). Without a " +
              "token this errors before any request rather than returning the global feed. " +
              "Can't be combined with `user`. false or omitted means no restriction.",
          ),
        createdAfter: z.iso
          .datetime({ offset: true })
          .optional()
          .describe(
            "Only activity created strictly after this ISO 8601 datetime with an offset " +
              '(e.g. "2026-10-01T00:00:00Z"); compared at whole-second precision.',
          ),
        createdBefore: z.iso
          .datetime({ offset: true })
          .optional()
          .describe("Only activity created strictly before this ISO 8601 datetime."),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({
            pageInfo: pageInfoSchema.optional(),
            activities: z.array(activityItem).optional(),
          })
          .loose(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ user, type, isFollowing, createdAfter, createdBefore, page, perPage }) =>
      guard(async () =>
        jsonResult({
          results: await search.searchActivity(client.ctx(), user, type, page, perPage, {
            after: createdAfter,
            before: createdBefore,
            isFollowing,
          }),
        }),
      ),
  );
}
