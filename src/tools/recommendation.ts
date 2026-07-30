import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as recommendation from "../clients/anilist/recommendation.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import {
  anilistId,
  mediaId,
  recommendationId,
  paginationFields,
  mediaTitleOut,
} from "./outputSchemas.js";

const mediaRefLite = z
  .object({
    id: anilistId,
    title: mediaTitleOut.nullish(),
  })
  .loose();

/** Net up/down tally across every user who's rated this recommendation
 *  pairing (confirmed via introspection: a plain `Int`, not an enum —
 *  distinct from `userRating` below, which is the caller's OWN vote). */
const ratingOut = z
  .int()
  .nullish()
  .describe("Net rating (RATE_UP minus RATE_DOWN votes across all users), not the caller's own.");

/** The caller's own vote on this recommendation, if logged in and voted —
 *  confirmed via introspection: AniList's real `RecommendationRating` enum
 *  has exactly these 3 values. */
const userRatingOut = z.enum(["NO_RATING", "RATE_UP", "RATE_DOWN"]).nullish();

const recommendationObject = z
  .object({
    id: anilistId,
    rating: ratingOut,
    userRating: userRatingOut,
    media: mediaRefLite.nullish(),
    mediaRecommendation: mediaRefLite.nullish(),
  })
  .loose();

const recommendationNode = z
  .object({
    id: anilistId,
    rating: ratingOut,
    userRating: userRatingOut,
    mediaRecommendation: z
      .object({
        id: anilistId,
        title: mediaTitleOut.nullish(),
        siteUrl: z.httpUrl().nullish(),
        mediaListEntry: z
          .object({ id: anilistId, status: z.string().nullish() })
          .loose()
          .nullish()
          .describe(
            "Whether this recommended title is on the caller's own list — viewer-relative, " +
              "so it only resolves when logged in; null both when logged out and when the " +
              "title just isn't on the list (the two cases aren't distinguishable from this " +
              "field alone).",
          ),
      })
      .loose()
      .nullish(),
  })
  .loose();

export function registerRecommendationTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_recommendation",
    {
      title: "Get a recommendation by ID",
      description:
        "Get a single AniList recommendation pairing (media + the media users recommend " +
        "alongside it) by its AniList recommendation ID — useful for re-checking one specific " +
        "pairing's current `rating`/`userRating` (e.g. after voting on it) without " +
        "re-paginating the whole list. Use get_recommendations_for_media instead to discover " +
        "recommendation IDs for a title in the first place, or to browse/list them. Confirmed " +
        "live (raw GraphQL, independent of this server): this is an AniList-side inconsistency, " +
        "not a client bug — a majority of ids from get_recommendations_for_media's own " +
        "`nodes[].id` 404 here anyway (7 of 10 tested for one title), with no correlation to " +
        "that pairing's `rating`. A 404 on an id you just got from that tool doesn't mean the " +
        "pairing doesn't exist, only that this specific lookup can't resolve it.",
      inputSchema: z.object({ id: recommendationId.describe("AniList recommendation ID.") }),
      outputSchema: z.object({ recommendation: recommendationObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) =>
      guard(async () =>
        jsonResult({ recommendation: await recommendation.getRecommendation(client.ctx(), id) }),
      ),
  );

  server.registerTool(
    "get_recommendations_for_media",
    {
      title: "Get recommendations for a title",
      description:
        "List anime/manga AniList users recommend as similar to a given title, ranked by " +
        "rating. Use search_media first to resolve the title to its AniList ID. Each " +
        "recommendation's `mediaListEntry` (requires login) shows whether it's already on " +
        "your own list — set `excludeInList: true` to filter those out server-side instead of " +
        "checking each one yourself.",
      inputSchema: z.object({
        mediaId: mediaId.describe("AniList ID of the anime/manga to get recommendations for."),
        ...paginationFields(10),
        excludeInList: z
          .boolean()
          .default(false)
          .describe(
            "[Requires login] Omit recommendations already on your own list. Filtered after " +
              "fetching this page, so a page can come back with fewer than `perPage` results — " +
              "not an error, just fewer new ones on that page. No-ops (nothing filtered) if not " +
              "logged in, since there's no list to check against.",
          ),
      }),
      outputSchema: z.object({
        recommendations: z
          .object({
            pageInfo: z
              .object({ hasNextPage: z.boolean().nullish() })
              .loose()
              .optional()
              .describe("Whether another page exists — use this to decide whether to paginate."),
            nodes: z.array(recommendationNode).nullish(),
          })
          .loose(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ mediaId, page, perPage, excludeInList }) =>
      guard(async () =>
        jsonResult({
          recommendations: await recommendation.getRecommendationsForMedia(
            client.ctx(),
            mediaId,
            page,
            perPage,
            excludeInList,
          ),
        }),
      ),
  );
}
