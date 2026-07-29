import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as search from "../clients/anilist/search.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import {
  pageInfoSchema,
  MEDIA_TYPES,
  idOnly,
  anilistId,
  userIdOrName,
  paginationFields,
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
const ACTIVITY_TYPES = ["TEXT", "ANIME_LIST", "MANGA_LIST", "MESSAGE", "MEDIA_LIST"] as const;
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
    year: z.number().int().describe("Required — a date filter needs at least a year."),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
  })
  .describe("A partial date; omit `month`/`day` you don't want to narrow by.");
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
    .number()
    .int()
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
        "authenticated user's own list. Omit to ignore list status entirely. Confirmed live: " +
        "silently no-ops (identical results for true/false/omitted) if not logged in, since " +
        "there's no list to check against — same behavior as " +
        "get_recommendations_for_media's `excludeInList`.",
    ),
  averageScore_greater: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Restrict to entries with an average score strictly greater than this (0-100)."),
  averageScore_lesser: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Restrict to entries with an average score strictly less than this (0-100)."),
  popularity_greater: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Restrict to entries with more list-adds than this."),
  popularity_lesser: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Restrict to entries with fewer list-adds than this."),
  episodes_greater: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Restrict to entries with more episodes/chapters than this."),
  episodes_lesser: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Restrict to entries with fewer episodes/chapters than this."),
  startDate_greater: fuzzyDateFilter
    .optional()
    .describe("Restrict to entries whose start date is on or after this date."),
  startDate_lesser: fuzzyDateFilter
    .optional()
    .describe("Restrict to entries whose start date is on or before this date."),
  endDate_greater: fuzzyDateFilter
    .optional()
    .describe("Restrict to entries whose end date is on or after this date."),
  endDate_lesser: fuzzyDateFilter
    .optional()
    .describe("Restrict to entries whose end date is on or before this date."),
  source_in: z
    .array(z.enum(SOURCES))
    .optional()
    .describe("Restrict to entries adapted from these source material types."),
  sfw: z
    .boolean()
    .default(false)
    .describe(
      "Set true to exclude adult (isAdult) entries. Adult results are NOT filtered by default.",
    ),
  sort: z
    .array(z.enum(MEDIA_SORTS))
    .optional()
    .describe(
      'Sort order, most-significant key first (e.g. ["SCORE_DESC"] for highest-rated first, ' +
        '["POPULARITY_DESC"] for most popular, ["TRENDING_DESC"] for what\'s hot right now). ' +
        "Defaults to relevance-ranked SEARCH_MATCH, which only makes sense when `term` is also " +
        "given — set an explicit sort for a term-less browse/ranking query.",
    ),
  includeDescription: z
    .boolean()
    .default(false)
    .describe(
      "Also fetch each result's full synopsis (`description`). Kept off by default — with " +
        "up to 25 results per call, always including it would burn tokens on text you may not " +
        "need; use get_media for a single title's full synopsis instead.",
    ),
  ...paginationFields(10),
});

// Search results are lists of AniList media/character/staff/etc. objects —
// per the precision policy, each item is typed loosely (id + passthrough)
// rather than duplicating the full MEDIA_FIELDS/CHARACTER_FIELDS/etc. shape.
// idOnly also matches the ACTIVITY_FRAGMENT union below (only `id` is common
// to every branch: TextActivity/ListActivity/MessageActivity).

export function registerSearchTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "search_media",
    {
      title: "Search anime/manga",
      description:
        "Search AniList for anime or manga by title and/or filters (genre, format, status, " +
        "season/year), or browse term-less by ranking (top-rated, most popular, trending — see " +
        "the `sort` parameter) when you don't have a title to search for. Adult (NSFW) results " +
        "are included unless you set `sfw: true` — see the `sfw` parameter. Returns AniList IDs " +
        "to use with get_media and other ID-based tools.",
      inputSchema: mediaSearchInput,
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), media: z.array(idOnly).optional() })
          .passthrough(),
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
              isAdult: args.sfw ? false : undefined,
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
        "Search AniList for characters by name. Returns AniList IDs to use with get_character.",
      inputSchema: z.object({
        term: z.string().min(1).describe("Character name (or part of it) to search for."),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), characters: z.array(idOnly).optional() })
          .passthrough(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ term, page, perPage }) =>
      guard(async () =>
        jsonResult({ results: await search.searchCharacter(client.ctx(), term, page, perPage) }),
      ),
  );

  server.registerTool(
    "search_staff",
    {
      title: "Search staff",
      description:
        "Search AniList for staff members by name. Returns AniList IDs to use with get_staff.",
      inputSchema: z.object({
        term: z.string().min(1).describe("Staff member name (or part of it) to search for."),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), staff: z.array(idOnly).optional() })
          .passthrough(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ term, page, perPage }) =>
      guard(async () =>
        jsonResult({ results: await search.searchStaff(client.ctx(), term, page, perPage) }),
      ),
  );

  server.registerTool(
    "search_studio",
    {
      title: "Search studios",
      description:
        "Search AniList for animation/production studios by name. Returns AniList IDs to use with get_studio.",
      inputSchema: z.object({
        term: z.string().min(1).describe("Studio name (or part of it) to search for."),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), studios: z.array(idOnly).optional() })
          .passthrough(),
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
        term: z.string().min(1).describe("Username (or part of it) to search for."),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({ pageInfo: pageInfoSchema.optional(), users: z.array(idOnly).optional() })
          .passthrough(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ term, page, perPage }) =>
      guard(async () =>
        jsonResult({ results: await search.searchUser(client.ctx(), term, page, perPage) }),
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
          .optional()
          .describe(
            "Free-text search term (matches thread title/body). Omit to just filter/browse.",
          ),
        categoryId: anilistId
          .optional()
          .describe(
            "Restrict to this forum category ID. Not independently listable by any tool — " +
              "resolve one from a thread you've already read (its `categories` field) or from " +
              "a forum URL like anilist.co/forum/recent?category=<id>. A wrong or nonexistent " +
              "ID doesn't error, it silently filters to an empty result — indistinguishable " +
              "from 'no threads in this category.'",
          ),
        mediaCategoryId: anilistId
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
          .passthrough(),
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
        "filtered to one user and/or one activity type. Returns AniList activity IDs to use " +
        "with get_activity.",
      inputSchema: z.object({
        user: userIdOrName
          .optional()
          .describe(
            "Restrict results to this AniList user — numeric ID or exact username (resolved " +
              "to an id with one extra internal lookup; no need to call search_user first " +
              "unless you only have a partial/fuzzy name). Validation is asymmetric: an " +
              "unknown USERNAME errors ('No AniList user named ... was found'), but an " +
              "unknown numeric ID does NOT — it silently returns an empty result, " +
              "indistinguishable from 'this user has no matching activity'. Resolve a numeric " +
              "ID via search_user first if you need to confirm the account actually exists. " +
              "Use get_user_activity instead if you only need one user's feed without the " +
              "type filter.",
          ),
        type: z
          .enum(ACTIVITY_TYPES)
          .optional()
          .describe(
            "Restrict to this activity type. MEDIA_LIST matches both ANIME_LIST and MANGA_LIST " +
              "activities; use ANIME_LIST/MANGA_LIST to restrict to just one.",
          ),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({
            pageInfo: pageInfoSchema.optional(),
            activities: z.array(idOnly).optional(),
          })
          .passthrough(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ user, type, page, perPage }) =>
      guard(async () =>
        jsonResult({
          results: await search.searchActivity(client.ctx(), user, type, page, perPage),
        }),
      ),
  );
}
