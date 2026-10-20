import type { AniListContext } from "./context.js";
import { assertFound } from "../../lib/errors.js";
import type { MediaId, MalId } from "./ids.js";
import type { MediaType, StaffLanguage, CharacterRole } from "./enums.js";
export type MediaFormat = "compact" | "full";

import {
  MEDIA_FIELDS,
  MEDIA_COMPACT_FIELDS,
  MEDIA_DESCRIPTION_FIELD,
  MEDIA_DETAIL_FIELDS,
  MEDIA_STREAMING_EPISODES_FIELD,
  existsFragment,
} from "./fields.js";

/** Shared implementation behind getMedia (AniList ids) and getMediaByMalId
 *  (MyAnimeList ids). The two differ only in which id field AniList is asked
 *  to filter on and which one the results are re-keyed by — everything else,
 *  including the order-preserving reorder below, is identical. */
async function fetchMedia(
  ctx: AniListContext,
  type: MediaType,
  ids: number | number[],
  idField: "id" | "idMal",
  includeStreamingEpisodes: boolean,
  format: MediaFormat = "full",
): Promise<unknown> {
  // Measured against the live API: the full selection runs 4,182 bytes per
  // title, the compact one 169. Resolving a batch of ids to titles (the
  // `malIds` path especially, whose whole point is mapping one id space onto
  // another) never needed the synopsis, tags, rankings and external links
  // that make up the difference. streamingEpisodes is a detail field, so it
  // has no meaning in compact and is not appended there.
  const fields =
    format === "compact"
      ? MEDIA_COMPACT_FIELDS
      : `${MEDIA_FIELDS}${MEDIA_DESCRIPTION_FIELD}${MEDIA_DETAIL_FIELDS}${includeStreamingEpisodes ? MEDIA_STREAMING_EPISODES_FIELD : ""}`;
  if (Array.isArray(ids)) {
    // Always the full 50 (AniList's max), not ids.length: several AniList
    // entries can share one idMal, and an extra match would otherwise take a
    // page slot and push a requested id into the `?? null` branch below —
    // indistinguishable from "this id doesn't exist". The tool's own cap on
    // the array MUST therefore stay at or below 50: AniList silently clamps a
    // larger `perPage` back to 50 (confirmed live).
    const query = `query($ids:[Int],$type:MediaType){Page(perPage:50){media(${idField}_in:$ids,type:$type){${fields}}}}`;
    const data = await ctx.gql.request<{ Page: { media: Record<string, number>[] } }>(
      query,
      { ids, type },
      ctx.authHeader(),
    );
    // AniList's `id_in`/`idMal_in` filter does NOT preserve the requested
    // order (it came back sorted by id ascending in live testing, regardless
    // of the caller's array order) — reorder client-side so the "same order
    // as ids" this tool promises is actually true. An id that didn't resolve
    // becomes `null` in that position (rather than being silently dropped)
    // so the array stays the same length as `ids` and a caller can tell
    // "this ID doesn't exist" apart from "this title just has sparse data".
    const byId = new Map(data.Page.media.map((m) => [m[idField], m]));
    return ids.map((id) => byId.get(id) ?? null);
  }
  const query = `query($id:Int,$type:MediaType){Media(${idField}:$id,type:$type){${fields}}}`;
  const data = await ctx.gql.request<{ Media: unknown }>(
    query,
    { id: ids, type },
    ctx.authHeader(),
  );
  const label = idField === "idMal" ? "MyAnimeList ID" : "ID";
  return assertFound(
    data.Media,
    `No ${type === "MANGA" ? "manga" : "anime"} found with ${label} ${ids}.`,
  );
}

export async function getMedia(
  ctx: AniListContext,
  type: MediaType,
  ids: MediaId | MediaId[],
  includeStreamingEpisodes = false,
  format: MediaFormat = "full",
): Promise<unknown> {
  return fetchMedia(ctx, type, ids, "id", includeStreamingEpisodes, format);
}

/** Resolve MyAnimeList ids to full AniList media. `type` is not optional
 *  padding: MAL numbers anime and manga independently, so the SAME idMal is a
 *  different title depending on it (confirmed live — `idMal: 1` is Cowboy
 *  Bebop as ANIME and MONSTER as MANGA), and AniList returns the wrong title
 *  rather than an error if the wrong one is passed. */
export async function getMediaByMalId(
  ctx: AniListContext,
  type: MediaType,
  malIds: MalId | MalId[],
  includeStreamingEpisodes = false,
  format: MediaFormat = "full",
): Promise<unknown> {
  return fetchMedia(ctx, type, malIds, "idMal", includeStreamingEpisodes, format);
}

export async function getMediaStatistics(
  ctx: AniListContext,
  type: MediaType,
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

export interface MediaCharactersOptions {
  /** Forwarded as `voiceActors(language:)`. Omitted → every dub language. */
  voiceActorLanguage?: StaffLanguage;
  /** Forwarded as `characters(role:)`. Omitted → every role. */
  role?: CharacterRole;
}

export async function getMediaCharacters(
  ctx: AniListContext,
  type: MediaType,
  id: MediaId,
  page = 1,
  perPage = 25,
  opts: MediaCharactersOptions = {},
): Promise<unknown> {
  // sort:[ROLE,RELEVANCE,ID]: role groups, AniList's own relevance ranking
  // within each, id as a stable tiebreak. Without it AniList returns no
  // meaningful order at all (confirmed
  // live: Attack on Titan's first page led with a BACKGROUND "Narrator"
  // ahead of its MAIN cast) — with it, MAIN comes first, then SUPPORTING,
  // then BACKGROUND, most prominent first within each. `voiceActors`
  // unfiltered returns every dub (8 languages for most of AoT's main cast,
  // confirmed live), so `language` is the caller's way to keep that small.
  // Both `$language` and `$role` are plain variables: a null one is the same
  // as omitting the argument, so the defaults stay "all".
  const query = `query($id:Int,$type:MediaType,$page:Int,$perPage:Int,$language:StaffLanguage,$role:CharacterRole){Media(id:$id,type:$type){
    characters(page:$page,perPage:$perPage,sort:[ROLE,RELEVANCE,ID],role:$role){
      pageInfo{hasNextPage}
      edges{
        role
        voiceActors(language:$language,sort:[RELEVANCE,ID]){id name{full} languageV2}
        node{id name{full native} siteUrl}
      }
    }
  }}`;
  const data = await ctx.gql.request<{ Media: { characters: unknown } | null }>(
    query,
    { id, type, page, perPage, language: opts.voiceActorLanguage, role: opts.role },
    ctx.authHeader(),
  );
  return assertFound(data.Media, `No anime/manga found with ID ${id}.`).characters;
}

export async function getMediaStaff(
  ctx: AniListContext,
  type: MediaType,
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
  type: MediaType,
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
  type: MediaType,
  id: MediaId,
): Promise<unknown> {
  // relationType(version:3), not bare: unversioned, AniList answers with
  // its v1 enum — confirmed live, Attack on Titan's (16498) link to its
  // manga reads ADAPTATION bare but SOURCE at version 3, and v1 never emits
  // SOURCE/COMPILATION/CONTAINS (version 2+) or SAME_UNIVERSE (version 3
  // only, the highest the schema documents). Response key stays
  // `relationType`.
  const query = `query($id:Int,$type:MediaType){Media(id:$id,type:$type){
    relations{
      edges{relationType(version:3) node{id type format title{romaji english} siteUrl}}
    }
  }}`;
  const data = await ctx.gql.request<{ Media: { relations: unknown } | null }>(
    query,
    { id, type },
    ctx.authHeader(),
  );
  return assertFound(data.Media, `No anime/manga found with ID ${id}.`).relations;
}

export interface ScheduleWindow {
  /** Unix seconds; forwarded as `airingAt_greater`. */
  airingAfter?: number;
  /** Unix seconds; forwarded as `airingAt_lesser`. */
  airingBefore?: number;
}

export async function getSchedule(
  ctx: AniListContext,
  mediaId?: MediaId,
  notYetAired?: boolean,
  page = 1,
  perPage = 25,
  window: ScheduleWindow = {},
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
  // notYetAired is ANDed with the airingAt window upstream (confirmed live: a
  // ±1-day window returned 29 entries unfiltered, only the 12 future ones
  // with notYetAired:true). So its "upcoming only" default applies only when
  // no window is given — otherwise a window spanning now would silently lose
  // its already-aired half, and one wholly in the past would come back empty.
  const hasWindow = window.airingAfter !== undefined || window.airingBefore !== undefined;
  const effectiveNotYetAired = notYetAired ?? (hasWindow ? undefined : true);
  // Already-aired only: newest first. Ascending would start page 1 at the
  // oldest episode AniList has on record, not the recent ones.
  const sort = effectiveNotYetAired === false ? "TIME_DESC" : "TIME";
  const query = `query($mediaId:Int,$notYetAired:Boolean,$page:Int,$perPage:Int,$after:Int,$before:Int){
    ${existsField}
    schedule:Page(page:$page,perPage:$perPage){
      pageInfo{hasNextPage}
      airingSchedules(mediaId:$mediaId,notYetAired:$notYetAired,airingAt_greater:$after,airingAt_lesser:$before,sort:${sort}){
        airingAt timeUntilAiring episode media{id title{romaji english} siteUrl}
      }
    }
  }`;
  const data = await ctx.gql.request<{
    exists?: { id: number } | null;
    schedule: { pageInfo: { hasNextPage: boolean | null }; airingSchedules: unknown };
  }>(
    query,
    {
      mediaId,
      notYetAired: effectiveNotYetAired,
      page,
      perPage,
      after: window.airingAfter,
      before: window.airingBefore,
    },
    ctx.authHeader(),
  );
  if (mediaId !== undefined) assertFound(data.exists, `No anime found with ID ${mediaId}.`);
  return {
    schedule: data.schedule.airingSchedules,
    hasNextPage: data.schedule.pageInfo.hasNextPage,
  };
}
