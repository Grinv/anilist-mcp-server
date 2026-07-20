import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as search from "../clients/anilist/search.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { pageInfoSchema, MEDIA_TYPES, idOnly } from "./outputSchemas.js";

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
    .describe("Restrict to entries matching ALL of these genre names (see get_genres)."),
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
    .describe("Restrict to this airing season (pair with seasonYear)."),
  seasonYear: z
    .number()
    .int()
    .optional()
    .describe("Restrict to this airing/release year (pair with season)."),
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
  page: z.number().int().positive().default(1).describe("Page number for pagination."),
  perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25)."),
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
        "season/year). Adult (NSFW) results are included unless you set `sfw: true` — see the " +
        "`sfw` parameter. Returns AniList IDs to use with get_media and other ID-based tools.",
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
            filter: {
              isAdult: args.sfw ? false : undefined,
              genre_in: args.genres,
              format_in: args.format_in,
              status_in: args.status_in,
              season: args.season,
              seasonYear: args.seasonYear,
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
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25)."),
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
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25)."),
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
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25)."),
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
        "Search AniList for users by username. Returns AniList user IDs to use with profile/list tools.",
      inputSchema: z.object({
        term: z.string().min(1).describe("Username (or part of it) to search for."),
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25)."),
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
    "search_activity",
    {
      title: "Search activity feed",
      description:
        "Search/browse AniList's activity feed (list updates, text posts, messages), optionally " +
        "filtered to one user and/or one activity type. Returns AniList activity IDs to use " +
        "with get_activity.",
      inputSchema: z.object({
        userId: z.number().int().optional().describe("Restrict results to this AniList user ID."),
        type: z
          .enum(ACTIVITY_TYPES)
          .optional()
          .describe(
            "Restrict to this activity type. MEDIA_LIST matches both ANIME_LIST and MANGA_LIST " +
              "activities; use ANIME_LIST/MANGA_LIST to restrict to just one.",
          ),
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25)."),
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
    ({ userId, type, page, perPage }) =>
      guard(async () =>
        jsonResult({
          results: await search.searchActivity(client.ctx(), userId, type, page, perPage),
        }),
      ),
  );
}
