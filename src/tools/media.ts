import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as media from "../clients/anilist/media.js";
import * as favourites from "../clients/anilist/favourites.js";
import { FAVOURITE_KINDS } from "../clients/anilist/enums.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { ApiError } from "../lib/errors.js";
import type { MediaId, MalId } from "../clients/anilist/ids.js";
import {
  pageInfoSchema,
  toggleFavouriteResult,
  MEDIA_TYPES,
  fuzzyDateOut,
  anilistId,
  mediaId,
  malId,
  paginationFields,
  mediaTitleOut,
  favouriteOut,
  communityScoreOut,
  personalScoreOut,
} from "./outputSchemas.js";

const mediaType = z.enum(MEDIA_TYPES).describe("Whether `id` refers to anime or manga.");

/** 50, not a round number of our choosing: the batch path builds
 *  `Page(perPage: ids.length)`, and AniList silently clamps `perPage` above
 *  50 (confirmed live), which would turn the surplus ids into nulls that look
 *  exactly like "no such title". See media.ts's fetchMedia(). */
const MAX_BATCH = 50;

const idsSchema = z
  .union([mediaId, z.array(mediaId).min(1).max(MAX_BATCH)], {
    // A plain string `error` fires for every union-mismatch reason alike, so a
    // wrong-but-present value (e.g. a decimal) would get told "is required" —
    // misleading when something WAS passed. Branch on `issue.input` instead.
    error: (issue) =>
      issue.input === undefined
        ? "ids must be a single AniList ID (number), or a non-empty array of IDs."
        : `ids must be a single AniList ID (number), or a non-empty array of up to ${MAX_BATCH} IDs.`,
  })
  .optional()
  .describe(
    `A single AniList anime/manga ID, or an array of up to ${MAX_BATCH} IDs to fetch in one ` +
      "call (AniList's own per-page ceiling; it clamps anything higher, which would silently " +
      "drop the surplus). Pass this OR `malIds`, not both. Each entry includes the full " +
      "synopsis/tags/rankings, so a large batch is a large response.",
  );

const malIdsSchema = z
  .union([malId, z.array(malId).min(1).max(MAX_BATCH)], {
    error: (issue) =>
      issue.input === undefined
        ? "malIds must be a single MyAnimeList ID (number), or a non-empty array of IDs."
        : `malIds must be a single MyAnimeList ID (number), or a non-empty array of up to ${MAX_BATCH} IDs.`,
  })
  .optional()
  .describe(
    `A single MyAnimeList ID (\`idMal\`), or an array of up to ${MAX_BATCH}, to resolve ` +
      "straight to AniList titles — use this instead of searching by title when you already " +
      "have MAL IDs (e.g. syncing a MAL list), since a title search costs one call per title " +
      "and can match the wrong entry. Pass this OR `ids`, not both. MAL numbers anime and " +
      "manga separately, so the SAME ID is a different title depending on `type` — passing " +
      "the wrong `type` returns the wrong title, not an error.",
  );

/** `ids` and `malIds` are two ways of naming the same thing, so exactly one
 *  must be given. Zod can't express that here without a refinement (which the
 *  SDK's JSON-Schema bridge would have to represent), so it's enforced in the
 *  handler and stated in both fields' descriptions — an ApiError, which
 *  guard() turns into a normal actionable tool error rather than a throw. */
async function fetchByEitherId(
  client: AniListClient,
  type: (typeof MEDIA_TYPES)[number],
  ids: MediaId | MediaId[] | undefined,
  malIds: MalId | MalId[] | undefined,
  includeStreamingEpisodes: boolean,
): Promise<unknown> {
  if ((ids === undefined) === (malIds === undefined)) {
    throw new ApiError({
      code: "bad_request",
      message:
        ids === undefined
          ? "Pass `ids` (AniList IDs) or `malIds` (MyAnimeList IDs) — one of them is required."
          : "Pass either `ids` or `malIds`, not both — they name the same titles two ways.",
    });
  }
  return ids === undefined
    ? media.getMediaByMalId(client.ctx(), type, malIds!, includeStreamingEpisodes)
    : media.getMedia(client.ctx(), type, ids, includeStreamingEpisodes);
}

/** MEDIA_FIELDS(+MEDIA_DETAIL_FIELDS) — only `id` is guaranteed; every other
 *  AniList field is nullable, so it's modeled as `.nullish()` here. */
const mediaObject = z
  .object({
    id: anilistId,
    idMal: z.int().positive().nullish(),
    type: z.string().nullish(),
    format: z.string().nullish(),
    status: z.string().nullish(),
    episodes: z.int().positive().nullish(),
    chapters: z.int().positive().nullish(),
    volumes: z.int().positive().nullish(),
    duration: z.int().positive().nullish(),
    genres: z.array(z.string()).nullish(),
    averageScore: communityScoreOut("The weighted community rating across all AniList users, on"),
    popularity: z.number().nonnegative().nullish(),
    isAdult: z.boolean().nullish(),
    isFavourite: favouriteOut("title"),
    siteUrl: z.httpUrl().nullish(),
    season: z.string().nullish(),
    seasonYear: z.int().positive().nullish(),
    countryOfOrigin: z.string().nullish(),
    title: z
      .object({
        romaji: z.string().nullish(),
        english: z.string().nullish(),
        native: z.string().nullish(),
      })
      .nullish(),
    coverImage: z.object({ large: z.httpUrl().nullish() }).nullish(),
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
            rank: z.int().positive().nullish(),
            isMediaSpoiler: z.boolean().nullish(),
          })
          .loose(),
      )
      .nullish(),
    // AniList's own ranking badges (e.g. site UI's "#134 highest rated all
    // time" / "#11 highest rated 2024") — `context` is the human-readable
    // label, `allTime`/`year`/`season` say which window it applies to.
    rankings: z
      .array(
        z
          .object({
            rank: z.int().positive().nullish(),
            type: z.string().nullish(),
            format: z.string().nullish(),
            year: z.int().positive().nullish(),
            season: z.string().nullish(),
            allTime: z.boolean().nullish(),
            context: z.string().nullish(),
          })
          .loose(),
      )
      .nullish(),
    nextAiringEpisode: z
      .object({
        id: anilistId,
        airingAt: z.number().nonnegative().nullish(),
        timeUntilAiring: z.number().nullish(),
        episode: z.int().nonnegative().nullish(),
      })
      .loose()
      .nullish(),
    externalLinks: z
      .array(
        z
          .object({
            id: anilistId,
            url: z.string().nullish(),
            site: z.string().nullish(),
            type: z.string().nullish(),
            language: z.string().nullish(),
            icon: z.string().nullish(),
            notes: z.string().nullish(),
            isDisabled: z.boolean().nullish(),
          })
          .loose(),
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
          .loose(),
      )
      .nullish(),
    mediaListEntry: z
      .object({
        id: anilistId,
        status: z.string().nullish(),
        score: personalScoreOut("The caller's own score for this title, on"),
        progress: z.int().nonnegative().nullish(),
        progressVolumes: z.int().nonnegative().nullish(),
        repeat: z.int().nonnegative().nullish(),
        priority: z.int().nonnegative().nullish(),
        private: z.boolean().nullish(),
        notes: z.string().nullish(),
        hiddenFromStatusLists: z.boolean().nullish(),
        customLists: z
          .array(z.object({ name: z.string().nullish(), enabled: z.boolean().nullish() }).loose())
          .nullish(),
        advancedScores: z.json().nullish(),
        startedAt: fuzzyDateOut.nullish(),
        completedAt: fuzzyDateOut.nullish(),
        updatedAt: z.number().nonnegative().nullish(),
        createdAt: z.number().nonnegative().nullish(),
      })
      .loose()
      .nullish()
      .describe(
        "Whether this title is on the caller's own list — viewer-relative, so it only " +
          "resolves when logged in; null both when logged out and when the title just isn't " +
          "on the list (the two cases aren't distinguishable from this field alone).",
      ),
  })
  .loose();

const statisticsObject = z
  .object({
    scoreDistribution: z
      .array(
        z
          .object({
            score: communityScoreOut(
              "The upper edge of this histogram bucket (confirmed live: buckets come back " +
                "as 10, 20, ... 100, i.e. ten-point bands), on",
            ),
            amount: z
              .int()
              .nonnegative()
              .nullish()
              .describe("How many users scored the title within this bucket."),
          })
          .loose(),
      )
      .nullish(),
    statusDistribution: z
      .array(
        z.object({ status: z.string().nullish(), amount: z.int().nonnegative().nullish() }).loose(),
      )
      .nullish(),
  })
  .loose();

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
                    id: anilistId,
                    name: z.object({ full: z.string().nullish() }).nullish(),
                    languageV2: z.string().nullish(),
                  })
                  .loose(),
              )
              .nullish(),
            node: z
              .object({
                id: anilistId,
                name: z
                  .object({ full: z.string().nullish(), native: z.string().nullish() })
                  .nullish(),
                siteUrl: z.httpUrl().nullish(),
              })
              .loose()
              .nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

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
                id: anilistId,
                name: z.object({ full: z.string().nullish() }).nullish(),
              })
              .loose()
              .nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

const reviewsConnection = z
  .object({
    pageInfo: pageInfoSchema.optional(),
    nodes: z
      .array(
        z
          .object({
            id: anilistId,
            summary: z.string().nullish(),
            body: z.string().nullish(),
            rating: z
              .number()
              .nonnegative()
              .nullish()
              .describe(
                "Net helpful votes this review received from other users (community " +
                  "helpfulness, confirmed live this is what results are sorted by) — not the " +
                  "reviewer's own opinion of the title, that's `score`.",
              ),
            ratingAmount: z
              .number()
              .nonnegative()
              .nullish()
              .describe("Total votes cast on this review's helpfulness (helpful + unhelpful)."),
            score: communityScoreOut(
              "The reviewer's own rating of the title itself (not a vote count, that's " +
                "`rating`/`ratingAmount` above), on",
            ),
            siteUrl: z.httpUrl().nullish(),
            user: z.object({ id: anilistId, name: z.string().nullish() }).loose().nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

const relationsObject = z
  .object({
    edges: z
      .array(
        z
          .object({
            relationType: z.string().nullish(),
            node: z
              .object({
                id: anilistId,
                type: z.string().nullish(),
                format: z.string().nullish(),
                title: z
                  .object({ romaji: z.string().nullish(), english: z.string().nullish() })
                  .nullish(),
                siteUrl: z.httpUrl().nullish(),
              })
              .loose()
              .nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

const scheduleItem = z
  .object({
    airingAt: z.number().nonnegative().nullish(),
    timeUntilAiring: z.number().nullish(),
    episode: z.int().nonnegative().nullish(),
    media: z
      .object({
        id: anilistId,
        title: mediaTitleOut.nullish(),
        siteUrl: z.httpUrl().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

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
        "it isn't on their list. Identify titles by AniList ID (`ids`) or by MyAnimeList ID " +
        "(`malIds`) — exactly one of the two, and either accepts a batch. Use search_media " +
        "first only when you have neither: a title search costs a call per title and can match " +
        "the wrong entry, so prefer `malIds` whenever you already have MAL IDs. " +
        "Returns a single object if you passed a single ID, or an array (same order as the IDs " +
        "you passed, with `null` in place of any that didn't resolve to a real anime/manga) if " +
        "you passed an array.",
      inputSchema: z.object({
        type: mediaType.describe(
          "Whether the IDs refer to anime or manga. Required for `malIds` in particular: MAL " +
            "numbers the two separately, so the same ID means different titles.",
        ),
        ids: idsSchema,
        malIds: malIdsSchema,
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
    ({ type, ids, malIds, includeStreamingEpisodes }) =>
      guard(async () =>
        jsonResult({
          media: await fetchByEitherId(client, type, ids, malIds, includeStreamingEpisodes),
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
      inputSchema: z.object({ type: mediaType, id: mediaId.describe("AniList ID.") }),
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
        id: mediaId.describe("AniList ID."),
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
        id: mediaId.describe("AniList ID."),
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
        "List user-written reviews for an anime or manga, most-helpful-voted first " +
        "(confirmed live: ordered by `rating`, not `score` — see those fields' own " +
        "descriptions). Always includes `summary` (a short excerpt); set `includeBody` to also " +
        "fetch each review's full text (can be long — leave it off unless you actually need " +
        "the full text). Use search_media first to resolve a title to its AniList ID.",
      inputSchema: z.object({
        type: mediaType,
        id: mediaId.describe("AniList ID."),
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
        type: mediaType,
        id: mediaId.describe("AniList anime/manga ID."),
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
        "— manga has no airing schedule; a manga id (like any non-anime id) is rejected as " +
        "not-found rather than silently returning an empty schedule, though that error reads the " +
        "same as a nonexistent id and doesn't single out the manga/anime mismatch.",
      inputSchema: z.object({
        mediaId: mediaId.optional().describe("Restrict to this AniList anime ID (not manga)."),
        notYetAired: z
          .boolean()
          .default(true)
          .describe(
            "Set false to instead list only already-aired episodes (confirmed live: this " +
              "swaps to a past-only result set, it doesn't add past episodes to the " +
              "still-upcoming ones).",
          ),
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
