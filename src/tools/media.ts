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
  anilistId,
  paginationFields,
  mediaTitleOut,
  favouriteOut,
} from "./outputSchemas.js";

const mediaType = z.enum(MEDIA_TYPES).describe("Whether `id` refers to anime or manga.");

const idsSchema = z
  .union([anilistId, z.array(anilistId).min(1)], {
    // A plain string `error` fires for every union-mismatch reason alike, so a
    // wrong-but-present value (e.g. a decimal) would get told "is required" —
    // misleading when something WAS passed. Branch on `issue.input` instead.
    error: (issue) =>
      issue.input === undefined
        ? "ids is required — pass a single AniList ID (number), or a non-empty array of IDs."
        : "ids must be a single AniList ID (number), or a non-empty array of IDs.",
  })
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
    isFavourite: favouriteOut("title"),
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
    // AniList's own ranking badges (e.g. site UI's "#134 highest rated all
    // time" / "#11 highest rated 2024") — `context` is the human-readable
    // label, `allTime`/`year`/`season` say which window it applies to.
    rankings: z
      .array(
        z
          .object({
            rank: z.number().int().nullish(),
            type: z.string().nullish(),
            format: z.string().nullish(),
            year: z.number().int().nullish(),
            season: z.string().nullish(),
            allTime: z.boolean().nullish(),
            context: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    nextAiringEpisode: z
      .object({
        id: z.number().int(),
        airingAt: z.number().nullish(),
        timeUntilAiring: z.number().nullish(),
        episode: z.number().int().nullish(),
      })
      .passthrough()
      .nullish(),
    externalLinks: z
      .array(
        z
          .object({
            id: z.number().int(),
            url: z.string().nullish(),
            site: z.string().nullish(),
            type: z.string().nullish(),
            language: z.string().nullish(),
            icon: z.string().nullish(),
            notes: z.string().nullish(),
            isDisabled: z.boolean().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    streamingEpisodes: z
      .array(
        z
          .object({
            title: z.string().nullish(),
            thumbnail: z.string().nullish(),
            url: z.string().nullish(),
            site: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    mediaListEntry: z
      .object({
        id: z.number().int(),
        status: z.string().nullish(),
        score: z.number().nullish(),
        progress: z.number().int().nullish(),
        progressVolumes: z.number().int().nullish(),
        repeat: z.number().int().nullish(),
        priority: z.number().int().nullish(),
        private: z.boolean().nullish(),
        notes: z.string().nullish(),
        hiddenFromStatusLists: z.boolean().nullish(),
        customLists: z
          .array(
            z.object({ name: z.string().nullish(), enabled: z.boolean().nullish() }).passthrough(),
          )
          .nullish(),
        advancedScores: z.unknown().nullish(),
        startedAt: fuzzyDateOut.nullish(),
        completedAt: fuzzyDateOut.nullish(),
        updatedAt: z.number().nullish(),
        createdAt: z.number().nullish(),
      })
      .passthrough()
      .nullish()
      .describe(
        "Whether this title is on the caller's own list — viewer-relative, so it only " +
          "resolves when logged in; null both when logged out and when the title just isn't " +
          "on the list (the two cases aren't distinguishable from this field alone).",
      ),
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
            body: z.string().nullish(),
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
        title: mediaTitleOut.nullish(),
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
        "title, format, status, episode/chapter/volume count, genres, score, synopsis, dates, " +
        'and `rankings` — AniList\'s own ranking badges (e.g. "#134 highest rated all time", ' +
        '"#11 highest rated 2024"), one entry per rated/popular ranking window the title ' +
        "currently appears in. Also returns `nextAiringEpisode` (for currently-releasing anime), " +
        "`externalLinks` (official sites, streaming platforms), and — [requires login] — " +
        "`mediaListEntry`, the authenticated user's own list entry for this title, or null if " +
        "it isn't on their list. Use search_media first to resolve a title to its AniList ID. " +
        "Returns a single object if `ids` is a single ID, or an array (same order as `ids`, " +
        "with `null` in place of any ID that didn't resolve to a real anime/manga) if `ids` " +
        "is an array.",
      inputSchema: z.object({
        type: mediaType.describe("Whether `ids` refers to anime or manga."),
        ids: idsSchema,
        includeStreamingEpisodes: z
          .boolean()
          .default(false)
          .describe(
            "Also fetch `streamingEpisodes` (per-episode streaming links). Kept off by " +
              "default — AniList doesn't paginate this field, so a long-running title can " +
              "return hundreds of entries.",
          ),
      }),
      outputSchema: z.object({ media: z.union([mediaObject, z.array(mediaObject.nullable())]) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ type, ids, includeStreamingEpisodes }) =>
      guard(async () =>
        jsonResult({
          media: await media.getMedia(client.ctx(), type, ids, includeStreamingEpisodes),
        }),
      ),
  );

  server.registerTool(
    "get_media_statistics",
    {
      title: "Get an anime/manga's score/status distribution",
      description:
        "Get an anime/manga's watch/read-status counts (watching/completed/planning/etc.) and " +
        "score distribution histogram across all AniList users. Use search_media first to " +
        "resolve a title to its AniList ID.",
      inputSchema: z.object({ type: mediaType, id: anilistId.describe("AniList ID.") }),
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
        "AniList ID. No explicit ordering is requested — don't assume results are grouped by " +
        "role or sorted by popularity (unlike get_character/get_staff's reverse-direction " +
        "lookup, which IS popularity-sorted); confirmed live, a Main-role character can appear " +
        "well after several Supporting ones.",
      inputSchema: z.object({
        type: mediaType,
        id: anilistId.describe("AniList ID."),
        ...paginationFields(25),
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
        "AniList ID. No explicit ordering is requested — don't assume results are sorted by " +
        "role or popularity (unlike get_staff's reverse-direction lookup, which IS " +
        "popularity-sorted).",
      inputSchema: z.object({
        type: mediaType,
        id: anilistId.describe("AniList ID."),
        ...paginationFields(25),
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
        "List user-written reviews for an anime or manga, highest-rated first. Always includes " +
        "`summary` (a short excerpt); set `includeBody` to also fetch each review's full text " +
        "(can be long — leave it off unless you actually need the full text). Use search_media " +
        "first to resolve a title to its AniList ID.",
      inputSchema: z.object({
        type: mediaType,
        id: anilistId.describe("AniList ID."),
        ...paginationFields(10),
        includeBody: z
          .boolean()
          .default(false)
          .describe("Also fetch each review's full text (`body`), not just its short `summary`."),
      }),
      outputSchema: z.object({ reviews: reviewsConnection }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ type, id, page, perPage, includeBody }) =>
      guard(async () =>
        jsonResult({
          reviews: await media.getMediaReviews(client.ctx(), type, id, page, perPage, includeBody),
        }),
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
        id: anilistId.describe("AniList anime/manga ID."),
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
        "Get upcoming (or a specific title's) episode air times, soonest-airing first " +
        "(confirmed live). Omit `mediaId` for the site-wide upcoming schedule, or pass it " +
        "(from search_media/get_media) to get one title's next-episode air time. Anime only " +
        "— manga has no airing schedule; a manga id is rejected with a clear error rather than " +
        "silently returning an empty schedule.",
      inputSchema: z.object({
        mediaId: anilistId.optional().describe("Restrict to this AniList anime ID (not manga)."),
        notYetAired: z
          .boolean()
          .default(true)
          .describe("Set false to include already-aired episodes too."),
        ...paginationFields(25),
      }),
      outputSchema: z.object({
        schedule: z.array(scheduleItem),
        hasNextPage: z.boolean().nullish(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ mediaId, notYetAired, page, perPage }) =>
      guard(async () =>
        jsonResult(await media.getSchedule(client.ctx(), mediaId, notYetAired, page, perPage)),
      ),
  );

  server.registerTool(
    "toggle_favourite",
    {
      title: "Favourite/unfavourite an anime, manga, character, staff member, or studio",
      description:
        "[Requires login] Toggle an anime, manga, character, staff member, or studio in the " +
        "authenticated user's AniList favourites. Calling it again on the same `kind`+`id` " +
        "un-favourites it. The response is not scoped to just the toggled item: it returns the " +
        "account's entire current favourites (id-only) across all 5 categories " +
        "(anime/manga/characters/staff/studios), so expect a wide result even for a single " +
        "toggle. Resolve `id` first via search_media/get_media (kind: ANIME/MANGA), " +
        "search_character/get_character, search_staff/get_staff, or search_studio/get_studio, " +
        "matching `kind`. Confirmed live: AniList does NOT validate that `id` actually belongs " +
        "to the given `kind` — e.g. passing an anime's ID with `kind: CHARACTER` succeeds " +
        "silently instead of erroring, favouriting a nonexistent character. Always resolve " +
        "`id` from the tool matching `kind` rather than reusing an ID you already have on hand. " +
        "Note: immediately re-checking with get_media/get_character/get_staff/get_studio's own " +
        "`isFavourite` can briefly still show the pre-toggle value — a confirmed AniList-side " +
        "read-after-write lag, not a bug in this call; this tool's own response already " +
        "reflects the new favourites list correctly.",
      inputSchema: z.object({
        kind: z.enum(FAVOURITE_KINDS).describe("Which kind of entity `id` refers to."),
        id: anilistId.describe("AniList ID of that anime/manga/character/staff/studio."),
      }),
      outputSchema: z.object({ favourites: toggleFavouriteResult }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ kind, id }) =>
      guard(async () =>
        jsonResult({ favourites: await favourites.toggleFavourite(client.ctx(), kind, id) }),
      ),
  );
}
