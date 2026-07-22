import type { AniListContext } from "./context.js";
import { assertFound } from "../../lib/errors.js";
import {
  MEDIA_FIELDS,
  MEDIA_DESCRIPTION_FIELD,
  MEDIA_DETAIL_FIELDS,
  MEDIA_STREAMING_EPISODES_FIELD,
} from "./fields.js";

export async function getMedia(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  ids: number | number[],
  includeStreamingEpisodes = false,
): Promise<unknown> {
  const fields = `${MEDIA_FIELDS}${MEDIA_DESCRIPTION_FIELD}${MEDIA_DETAIL_FIELDS}${includeStreamingEpisodes ? MEDIA_STREAMING_EPISODES_FIELD : ""}`;
  if (Array.isArray(ids)) {
    const query = `query($ids:[Int],$type:MediaType){Page(perPage:${ids.length}){media(id_in:$ids,type:$type){${fields}}}}`;
    const data = await ctx.gql.request<{ Page: { media: { id: number }[] } }>(
      query,
      { ids, type },
      ctx.authHeader(),
    );
    // AniList's `id_in` filter does NOT preserve the requested order (it
    // came back sorted by id ascending in live testing, regardless of the
    // caller's array order) — reorder client-side so the "same order as
    // ids" this tool promises is actually true. An id that didn't resolve
    // becomes `null` in that position (rather than being silently dropped)
    // so the array stays the same length as `ids` and a caller can tell
    // "this ID doesn't exist" apart from "this title just has sparse data".
    const byId = new Map(data.Page.media.map((m) => [m.id, m]));
    return ids.map((id) => byId.get(id) ?? null);
  }
  const query = `query($id:Int,$type:MediaType){Media(id:$id,type:$type){${fields}}}`;
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
  const data = await ctx.gql.request<{ Media: { stats: unknown } | null }>(
    query,
    { id, type },
    ctx.authHeader(),
  );
  return assertFound(data.Media, `No anime/manga found with ID ${id}.`).stats;
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
  const data = await ctx.gql.request<{ Media: { characters: unknown } | null }>(
    query,
    { id, type, page, perPage },
    ctx.authHeader(),
  );
  return assertFound(data.Media, `No anime/manga found with ID ${id}.`).characters;
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
  const data = await ctx.gql.request<{ Media: { staff: unknown } | null }>(
    query,
    { id, type, page, perPage },
    ctx.authHeader(),
  );
  return assertFound(data.Media, `No anime/manga found with ID ${id}.`).staff;
}

export async function getMediaReviews(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  id: number,
  page = 1,
  perPage = 10,
  includeBody = false,
): Promise<unknown> {
  // The full review body can run to thousands of characters — only requested
  // on demand (includeBody) so a default listing doesn't burn tokens on text
  // the caller may just want summary/rating for.
  const query = `query($id:Int,$type:MediaType,$page:Int,$perPage:Int){Media(id:$id,type:$type){
    reviews(page:$page,perPage:$perPage,sort:RATING_DESC){
      pageInfo{hasNextPage}
      nodes{id summary${includeBody ? " body(asHtml:false)" : ""} rating ratingAmount score siteUrl user{id name}}
    }
  }}`;
  const data = await ctx.gql.request<{ Media: { reviews: unknown } | null }>(
    query,
    { id, type, page, perPage },
    ctx.authHeader(),
  );
  return assertFound(data.Media, `No anime/manga found with ID ${id}.`).reviews;
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
  const data = await ctx.gql.request<{ Media: { relations: unknown } | null }>(
    query,
    { id, type },
    ctx.authHeader(),
  );
  return assertFound(data.Media, `No anime/manga found with ID ${id}.`).relations;
}

export async function getSchedule(
  ctx: AniListContext,
  mediaId?: number,
  notYetAired = true,
  page = 1,
  perPage = 25,
): Promise<unknown> {
  // airingSchedules(mediaId:...) is a Page connection filter, not a singular
  // lookup — a nonexistent mediaId just filters down to an empty-but-successful
  // page, indistinguishable from "this real anime has no upcoming episodes".
  // When a mediaId is given, alias a Media(id){id} existence check into the
  // SAME request as the real query, rather than a separate round trip —
  // confirmed live that AniList 404s the *entire* response (not just the
  // aliased field) when Media(id) doesn't resolve, so a bad id still
  // surfaces as a clean not_found error from one request. assertFound()
  // below is defense-in-depth for the unobserved case where AniList instead
  // returns 200 with `exists: null`.
  const existsField = mediaId !== undefined ? "exists:Media(id:$mediaId){id}" : "";
  const query = `query($mediaId:Int,$notYetAired:Boolean,$page:Int,$perPage:Int){
    ${existsField}
    schedule:Page(page:$page,perPage:$perPage){
      pageInfo{hasNextPage}
      airingSchedules(mediaId:$mediaId,notYetAired:$notYetAired,sort:TIME){
        airingAt timeUntilAiring episode media{id title{romaji english} siteUrl}
      }
    }
  }`;
  const data = await ctx.gql.request<{
    exists?: { id: number } | null;
    schedule: { airingSchedules: unknown };
  }>(query, { mediaId, notYetAired, page, perPage }, ctx.authHeader());
  if (mediaId !== undefined) assertFound(data.exists, `No anime found with ID ${mediaId}.`);
  return data.schedule.airingSchedules;
}
