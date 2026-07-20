import type { AniListContext } from "./context.js";
import { MEDIA_FIELDS, MEDIA_DETAIL_FIELDS } from "./fields.js";

export async function getMedia(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  ids: number | number[],
): Promise<unknown> {
  if (Array.isArray(ids)) {
    const query = `query($ids:[Int],$type:MediaType){Page(perPage:${ids.length}){media(id_in:$ids,type:$type){${MEDIA_FIELDS}${MEDIA_DETAIL_FIELDS}}}}`;
    const data = await ctx.gql.request<{ Page: { media: unknown[] } }>(
      query,
      { ids, type },
      ctx.authHeader(),
    );
    return data.Page.media;
  }
  const query = `query($id:Int,$type:MediaType){Media(id:$id,type:$type){${MEDIA_FIELDS}${MEDIA_DETAIL_FIELDS}}}`;
  const data = await ctx.gql.request<{ Media: unknown }>(
    query,
    { id: ids, type },
    ctx.authHeader(),
  );
  return data.Media;
}

export async function getMediaStatistics(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  id: number,
): Promise<unknown> {
  const query = `query($id:Int,$type:MediaType){Media(id:$id,type:$type){
    stats {
      scoreDistribution { score amount }
      statusDistribution { status amount }
    }
  }}`;
  const data = await ctx.gql.request<{ Media: { stats: unknown } }>(
    query,
    { id, type },
    ctx.authHeader(),
  );
  return data.Media.stats;
}

export async function getMediaCharacters(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  id: number,
  page = 1,
  perPage = 25,
): Promise<unknown> {
  const query = `query($id:Int,$type:MediaType,$page:Int,$perPage:Int){Media(id:$id,type:$type){
    characters(page:$page,perPage:$perPage){
      pageInfo{hasNextPage}
      edges{
        role
        voiceActors{id name{full} languageV2}
        node{id name{full native} siteUrl}
      }
    }
  }}`;
  const data = await ctx.gql.request<{ Media: { characters: unknown } }>(
    query,
    { id, type, page, perPage },
    ctx.authHeader(),
  );
  return data.Media.characters;
}

export async function getMediaStaff(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  id: number,
  page = 1,
  perPage = 25,
): Promise<unknown> {
  const query = `query($id:Int,$type:MediaType,$page:Int,$perPage:Int){Media(id:$id,type:$type){
    staff(page:$page,perPage:$perPage){
      pageInfo{hasNextPage}
      edges{ role node{id name{full}} }
    }
  }}`;
  const data = await ctx.gql.request<{ Media: { staff: unknown } }>(
    query,
    { id, type, page, perPage },
    ctx.authHeader(),
  );
  return data.Media.staff;
}

export async function getMediaReviews(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  id: number,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  const query = `query($id:Int,$type:MediaType,$page:Int,$perPage:Int){Media(id:$id,type:$type){
    reviews(page:$page,perPage:$perPage,sort:RATING_DESC){
      pageInfo{hasNextPage}
      nodes{id summary rating ratingAmount score siteUrl user{id name}}
    }
  }}`;
  const data = await ctx.gql.request<{ Media: { reviews: unknown } }>(
    query,
    { id, type, page, perPage },
    ctx.authHeader(),
  );
  return data.Media.reviews;
}

export async function getMediaRelations(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  id: number,
): Promise<unknown> {
  const query = `query($id:Int,$type:MediaType){Media(id:$id,type:$type){
    relations{
      edges{relationType node{id type format title{romaji english} siteUrl}}
    }
  }}`;
  const data = await ctx.gql.request<{ Media: { relations: unknown } }>(
    query,
    { id, type },
    ctx.authHeader(),
  );
  return data.Media.relations;
}

export async function getSchedule(
  ctx: AniListContext,
  mediaId?: number,
  notYetAired = true,
  page = 1,
  perPage = 25,
): Promise<unknown> {
  const query = `query($mediaId:Int,$notYetAired:Boolean,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{hasNextPage}
    airingSchedules(mediaId:$mediaId,notYetAired:$notYetAired,sort:TIME){
      airingAt timeUntilAiring episode media{id title{romaji english} siteUrl}
    }
  }}`;
  const data = await ctx.gql.request<{ Page: { airingSchedules: unknown } }>(
    query,
    { mediaId, notYetAired, page, perPage },
    ctx.authHeader(),
  );
  return data.Page.airingSchedules;
}
