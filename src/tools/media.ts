import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as media from "../clients/anilist/media.js";
import * as favourites from "../clients/anilist/favourites.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import {
  pageInfoSchema,
  toggleFavouriteResult,
  MEDIA_TYPES,
  fuzzyDateOut,
} from "./outputSchemas.js";

const mediaType = z.enum(MEDIA_TYPES).describe("Whether `id`/`ids` refers to anime or manga.");

const idsSchema = z
  .union([z.number().int(), z.array(z.number().int()).min(1)])
  .describe("A single AniList anime/manga ID, or an array of IDs to fetch in one call.");

/** MEDIA_FIELDS(+MEDIA_DETAIL_FIELDS) — only `id` is guaranteed; every other
 *  AniList field is nullable, so it's modeled as `.nullish()` here. */
const mediaObject = z
  .object({
    id: z.number().int(),
    idMal: z.number().int().nullish(),
    type: z.string().nullish(),
    format: z.string().nullish(),
    status: z.string().nullish(),
    episodes: z.number().int().nullish(),
    chapters: z.number().int().nullish(),
    volumes: z.number().int().nullish(),
    duration: z.number().int().nullish(),
    genres: z.array(z.string()).nullish(),
    averageScore: z.number().nullish(),
    popularity: z.number().nullish(),
    isAdult: z.boolean().nullish(),
    isFavourite: z.boolean().nullish(),
    siteUrl: z.string().nullish(),
    season: z.string().nullish(),
    seasonYear: z.number().int().nullish(),
    countryOfOrigin: z.string().nullish(),
    title: z
      .object({
        romaji: z.string().nullish(),
        english: z.string().nullish(),
        native: z.string().nullish(),
      })
      .nullish(),
    coverImage: z.object({ large: z.string().nullish() }).nullish(),
    startDate: fuzzyDateOut.nullish(),
    endDate: fuzzyDateOut.nullish(),
    description: z.string().nullish(),
    trailer: z
      .object({
        id: z.string().nullish(),
        site: z.string().nullish(),
        thumbnail: z.string().nullish(),
      })
      .nullish(),
    tags: z
      .array(
        z
          .object({
            name: z.string().optional(),
            rank: z.number().int().nullish(),
            isMediaSpoiler: z.boolean().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const statisticsObject = z
  .object({
    scoreDistribution: z
      .array(
        z.object({ score: z.number().nullish(), amount: z.number().int().nullish() }).passthrough(),
      )
      .nullish(),
    statusDistribution: z
      .array(
        z
          .object({ status: z.string().nullish(), amount: z.number().int().nullish() })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const charactersConnection = z
  .object({
    pageInfo: pageInfoSchema.optional(),
    edges: z
      .array(
        z
          .object({
            role: z.string().nullish(),
            voiceActors: z
              .array(
                z
                  .object({
                    id: z.number().int(),
                    name: z.object({ full: z.string().nullish() }).nullish(),
                    languageV2: z.string().nullish(),
                  })
                  .passthrough(),
              )
              .nullish(),
            node: z
              .object({
                id: z.number().int(),
                name: z
                  .object({ full: z.string().nullish(), native: z.string().nullish() })
                  .nullish(),
                siteUrl: z.string().nullish(),
              })
              .passthrough()
              .nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const staffConnection = z
  .object({
    pageInfo: pageInfoSchema.optional(),
    edges: z
      .array(
        z
          .object({
            role: z.string().nullish(),
            node: z
              .object({
                id: z.number().int(),
                name: z.object({ full: z.string().nullish() }).nullish(),
              })
              .passthrough()
              .nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const reviewsConnection = z
  .object({
    pageInfo: pageInfoSchema.optional(),
    nodes: z
      .array(
        z
          .object({
            id: z.number().int(),
            summary: z.string().nullish(),
            rating: z.number().nullish(),
            ratingAmount: z.number().nullish(),
            score: z.number().nullish(),
            siteUrl: z.string().nullish(),
            user: z
              .object({ id: z.number().int(), name: z.string().nullish() })
              .passthrough()
              .nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const relationsObject = z
  .object({
    edges: z
      .array(
        z
          .object({
            relationType: z.string().nullish(),
            node: z
              .object({
                id: z.number().int(),
                type: z.string().nullish(),
                format: z.string().nullish(),
                title: z
                  .object({ romaji: z.string().nullish(), english: z.string().nullish() })
                  .nullish(),
                siteUrl: z.string().nullish(),
              })
              .passthrough()
              .nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const scheduleItem = z
  .object({
    airingAt: z.number().nullish(),
    timeUntilAiring: z.number().nullish(),
    episode: z.number().int().nullish(),
    media: z
      .object({
        id: z.number().int(),
        title: z.object({ romaji: z.string().nullish(), english: z.string().nullish() }).nullish(),
        siteUrl: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const FAVOURITE_KINDS = ["ANIME", "MANGA", "CHARACTER", "STAFF", "STUDIO"] as const;

export function registerMediaTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_media",
    {
      title: "Get anime/manga details",
      description:
        "Get detailed information about one or more anime or manga by their AniList ID(s): " +
        "title, format, status, episode/chapter/volume count, genres, score, synopsis, and " +
        "dates. Use search_media first to resolve a title to its AniList ID. Returns a single " +
        "object if `ids` is a single ID, or an array (same order as `ids`) if `ids` is an array.",
      inputSchema: z.object({ type: mediaType, ids: idsSchema }),
      outputSchema: z.object({ media: z.union([mediaObject, z.array(mediaObject)]) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ type, ids }) =>
      guard(async () => jsonResult({ media: await media.getMedia(client.ctx(), type, ids) })),
  );

  server.registerTool(
    "get_media_statistics",
    {
      title: "Get an anime/manga's score/status distribution",
      description:
        "Get an anime/manga's watch/read-status counts (watching/completed/planning/etc.) and " +
        "score distribution histogram across all AniList users. Use search_media first to " +
        "resolve a title to its AniList ID.",
      inputSchema: z.object({ type: mediaType, id: z.number().int().describe("AniList ID.") }),
      outputSchema: z.object({ statistics: statisticsObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ type, id }) =>
      guard(async () =>
        jsonResult({ statistics: await media.getMediaStatistics(client.ctx(), type, id) }),
      ),
  );

  server.registerTool(
    "get_media_characters",
    {
      title: "Get an anime/manga's characters",
      description:
        "List an anime/manga's characters with their role (Main/Supporting/Background) and, " +
        "for anime, Japanese voice actors. Use search_media first to resolve a title to its " +
        "AniList ID.",
      inputSchema: z.object({
        type: mediaType,
        id: z.number().int().describe("AniList ID."),
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(25).describe("Results per page (max 25)."),
      }),
      outputSchema: z.object({ characters: charactersConnection }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ type, id, page, perPage }) =>
      guard(async () =>
        jsonResult({
          characters: await media.getMediaCharacters(client.ctx(), type, id, page, perPage),
        }),
      ),
  );

  server.registerTool(
    "get_media_staff",
    {
      title: "Get an anime/manga's production staff",
      description:
        "List an anime/manga's staff (director, writer, character designer, author, " +
        "illustrator, etc.) with their role. Use search_media first to resolve a title to its " +
        "AniList ID.",
      inputSchema: z.object({
        type: mediaType,
        id: z.number().int().describe("AniList ID."),
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(25).describe("Results per page (max 25)."),
      }),
      outputSchema: z.object({ staff: staffConnection }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ type, id, page, perPage }) =>
      guard(async () =>
        jsonResult({ staff: await media.getMediaStaff(client.ctx(), type, id, page, perPage) }),
      ),
  );

  server.registerTool(
    "get_media_reviews",
    {
      title: "Get an anime/manga's reviews",
      description:
        "List user-written reviews for an anime or manga, highest-rated first. Use " +
        "search_media first to resolve a title to its AniList ID.",
      inputSchema: z.object({
        type: mediaType,
        id: z.number().int().describe("AniList ID."),
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25)."),
      }),
      outputSchema: z.object({ reviews: reviewsConnection }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ type, id, page, perPage }) =>
      guard(async () =>
        jsonResult({ reviews: await media.getMediaReviews(client.ctx(), type, id, page, perPage) }),
      ),
  );

  server.registerTool(
    "get_media_relations",
    {
      title: "Get a title's related media",
      description:
        "Get the anime/manga related to a given title (prequels, sequels, side stories, " +
        "adaptations, spin-offs) with the relation type. Use search_media first to resolve a " +
        "title to its AniList ID.",
      inputSchema: z.object({
        id: z.number().int().describe("AniList anime/manga ID."),
        type: z.enum(["ANIME", "MANGA"]).describe("Whether `id` refers to an anime or a manga."),
      }),
      outputSchema: z.object({ relations: relationsObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id, type }) =>
      guard(async () =>
        jsonResult({ relations: await media.getMediaRelations(client.ctx(), type, id) }),
      ),
  );

  server.registerTool(
    "get_anime_schedule",
    {
      title: "Get the anime airing schedule",
      description:
        "Get upcoming (or a specific title's) episode air times. Omit `mediaId` for the " +
        "site-wide upcoming schedule, or pass it (from search_media/get_media) to get one " +
        "title's next-episode air time. Anime only — manga has no airing schedule.",
      inputSchema: z.object({
        mediaId: z.number().int().optional().describe("Restrict to this AniList anime ID."),
        notYetAired: z
          .boolean()
          .default(true)
          .describe("Set false to include already-aired episodes too."),
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(25).describe("Results per page (max 25)."),
      }),
      outputSchema: z.object({ schedule: z.array(scheduleItem) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ mediaId, notYetAired, page, perPage }) =>
      guard(async () =>
        jsonResult({
          schedule: await media.getSchedule(client.ctx(), mediaId, notYetAired, page, perPage),
        }),
      ),
  );

  server.registerTool(
    "favourite",
    {
      title: "Favourite/unfavourite an anime, manga, character, staff member, or studio",
      description:
        "[Requires login] Toggle an anime, manga, character, staff member, or studio in the " +
        "authenticated user's AniList favourites. Calling it again on the same `kind`+`id` " +
        "un-favourites it. Resolve `id` first via search_media/get_media (kind: ANIME/MANGA), " +
        "search_character/get_character, search_staff/get_staff, or search_studio/get_studio, " +
        "matching `kind`.",
      inputSchema: z.object({
        kind: z.enum(FAVOURITE_KINDS).describe("Which kind of entity `id` refers to."),
        id: z.number().int().describe("AniList ID of that anime/manga/character/staff/studio."),
      }),
      outputSchema: z.object({ favourites: toggleFavouriteResult }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ kind, id }) =>
      guard(async () =>
        jsonResult({ favourites: await favourites.toggleFavourite(client.ctx(), kind, id) }),
      ),
  );
}
