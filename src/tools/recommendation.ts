import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as recommendation from "../clients/anilist/recommendation.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";

const mediaRefLite = z
  .object({
    id: z.number().int(),
    title: z.object({ romaji: z.string().nullish(), english: z.string().nullish() }).nullish(),
  })
  .passthrough();

const recommendationObject = z
  .object({
    id: z.number().int(),
    rating: z.number().nullish(),
    userRating: z.string().nullish(),
    media: mediaRefLite.nullish(),
    mediaRecommendation: mediaRefLite.nullish(),
  })
  .passthrough();

const recommendationNode = z
  .object({
    id: z.number().int(),
    rating: z.number().nullish(),
    userRating: z.string().nullish(),
    mediaRecommendation: z
      .object({
        id: z.number().int(),
        title: z.object({ romaji: z.string().nullish(), english: z.string().nullish() }).nullish(),
        siteUrl: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export function registerRecommendationTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_recommendation",
    {
      title: "Get a recommendation by ID",
      description:
        "Get a single AniList recommendation pairing (media + the media users recommend " +
        "alongside it) by its AniList recommendation ID. Use get_recommendations_for_media " +
        "first to discover recommendation IDs for a title.",
      inputSchema: z.object({ id: z.number().int().describe("AniList recommendation ID.") }),
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
        "rating. Use search_media first to resolve the title to its AniList ID.",
      inputSchema: z.object({
        mediaId: z
          .number()
          .int()
          .describe("AniList ID of the anime/manga to get recommendations for."),
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25)."),
      }),
      outputSchema: z.object({
        recommendations: z.object({ nodes: z.array(recommendationNode).nullish() }).passthrough(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ mediaId, page, perPage }) =>
      guard(async () =>
        jsonResult({
          recommendations: await recommendation.getRecommendationsForMedia(
            client.ctx(),
            mediaId,
            page,
            perPage,
          ),
        }),
      ),
  );
}
