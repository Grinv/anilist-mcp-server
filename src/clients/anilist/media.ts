import type { AniListContext } from "./context.js";
import { assertFound } from "../../lib/errors.js";
import type { MediaId } from "./ids.js";
import {
  MEDIA_FIELDS,
  MEDIA_DESCRIPTION_FIELD,
  MEDIA_DETAIL_FIELDS,
  MEDIA_STREAMING_EPISODES_FIELD,
  existsFragment,
} from "./fields.js";

export async function getMedia(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  ids: MediaId | MediaId[],
  includeStreamingEpisodes = false,
): Promise<unknown> {
  const fields = `${MEDIA_FIELDS}${MEDIA_DESCRIPTION_FIELD}${MEDIA_DETAIL_FIELDS}${includeStreamingEpisodes ? MEDIA_STREAMING_EPISODES_FIELD : ""}`;
  if (Array.isArray(ids)) {
    const query = `query($ids:[Int],$type:MediaType){Page(perPage:${ids.length}){media(id_in:$ids,type:$type){${fields}}}}`;
    const data = await ctx.gql.request<{ Page: { media: { id: MediaId }[] } }>(
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
  id: MediaId,
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
  id: MediaId,
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
  id: MediaId,
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
  id: MediaId,
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
  id: MediaId,
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
  mediaId?: MediaId,
  notYetAired = true,
  page = 1,
  perPage = 25,
): Promise<{ schedule: unknown; hasNextPage: boolean | null }> {
  // airingSchedules(mediaId) doesn't error on a bad mediaId (see
  // docs/api-references.md's "Page connection filtered by a parent id"
  // section) — existsFragment() aliases the existence check into this same
  // request instead of a separate round trip when mediaId is given.
  // type:ANIME on the exists check (not just id) — airingSchedules has no
  // type filter of its own, so a real MANGA id would otherwise pass this
  // check and just return an empty schedule instead of erroring (confirmed
  // live).
  const existsField = mediaId !== undefined ? existsFragment("Media", "mediaId", "type:ANIME") : "";
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
    schedule: { pageInfo: { hasNextPage: boolean | null }; airingSchedules: unknown };
  }>(query, { mediaId, notYetAired, page, perPage }, ctx.authHeader());
  if (mediaId !== undefined) assertFound(data.exists, `No anime found with ID ${mediaId}.`);
  return {
    schedule: data.schedule.airingSchedules,
    hasNextPage: data.schedule.pageInfo.hasNextPage,
  };
}
