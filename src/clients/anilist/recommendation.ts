import type { AniListContext } from "./context.js";
import { assertFound } from "../../lib/errors.js";
import type { MediaId, RecommendationId } from "./ids.js";

export async function getRecommendation(
  ctx: AniListContext,
  id: RecommendationId,
): Promise<unknown> {
  const query = `query($id:Int){Recommendation(id:$id){id rating userRating
    media{id title{romaji english}} mediaRecommendation{id title{romaji english}}}}`;
  const data = await ctx.gql.request<{ Recommendation: unknown }>(query, { id }, ctx.authHeader());
  return assertFound(data.Recommendation, `No recommendation found with ID ${id}.`);
}

interface RecommendationsPage {
  pageInfo: unknown;
  nodes: { mediaRecommendation?: { mediaListEntry?: unknown } | null }[];
}

export async function getRecommendationsForMedia(
  ctx: AniListContext,
  mediaId: MediaId,
  page = 1,
  perPage = 10,
  excludeInList = false,
): Promise<unknown> {
  // mediaListEntry is viewer-relative — only resolves when authHeader() carries
  // a token; requesting it unauthenticated is harmless (always comes back
  // null, so excludeInList silently filters nothing rather than erroring).
  const query = `query($id:Int,$page:Int,$perPage:Int){Media(id:$id){recommendations(page:$page,perPage:$perPage,sort:RATING_DESC){
    pageInfo{hasNextPage}
    nodes{id rating userRating mediaRecommendation{id title{romaji english} siteUrl mediaListEntry{id status}}}
  }}}`;
  const data = await ctx.gql.request<{ Media: { recommendations: RecommendationsPage } | null }>(
    query,
    { id: mediaId, page, perPage },
    ctx.authHeader(),
  );
  const { recommendations } = assertFound(data.Media, `No anime/manga found with ID ${mediaId}.`);
  if (!excludeInList) return recommendations;
  return {
    ...recommendations,
    nodes: recommendations.nodes.filter((n) => !n.mediaRecommendation?.mediaListEntry),
  };
}
