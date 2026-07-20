import type { AniListContext } from "./context.js";

export async function getRecommendation(ctx: AniListContext, id: number): Promise<unknown> {
  const query = `query($id:Int){Recommendation(id:$id){id rating userRating
    media{id title{romaji english}} mediaRecommendation{id title{romaji english}}}}`;
  const data = await ctx.gql.request<{ Recommendation: unknown }>(query, { id }, ctx.authHeader());
  return data.Recommendation;
}

export async function getRecommendationsForMedia(
  ctx: AniListContext,
  mediaId: number,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  const query = `query($id:Int,$page:Int,$perPage:Int){Media(id:$id){recommendations(page:$page,perPage:$perPage,sort:RATING_DESC){
    nodes{id rating userRating mediaRecommendation{id title{romaji english} siteUrl}}
  }}}`;
  const data = await ctx.gql.request<{ Media: { recommendations: unknown } }>(
    query,
    { id: mediaId, page, perPage },
    ctx.authHeader(),
  );
  return data.Media.recommendations;
}
