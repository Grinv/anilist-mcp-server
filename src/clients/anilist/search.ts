import type { AniListContext } from "./context.js";
import { fetchActivityFeed, type ActivityTypeFilter } from "./activity.js";
import { encodeFuzzyDateInt } from "./fuzzyDate.js";
import { ApiError, assertFound } from "../../lib/errors.js";
import type { CategoryId, MediaId, UserId } from "./ids.js";
import type { MediaType } from "./enums.js";
import {
  existsFragment,
  MEDIA_FIELDS,
  MEDIA_DESCRIPTION_FIELD,
  CHARACTER_FIELDS,
  STAFF_FIELDS,
  PERSON_DESCRIPTION_FIELD,
  USER_FIELDS,
  USER_DESCRIPTION_FIELD,
} from "./fields.js";

export async function searchMedia(
  ctx: AniListContext,
  type: MediaType,
  opts: {
    term?: string;
    filter?: Record<string, unknown>;
    page?: number;
    perPage?: number;
    sort?: string[];
    includeDescription?: boolean;
  },
): Promise<unknown> {
  // AniList's Media field takes filter args flat (no nested input object),
  // so translate the caller's filter map into the individual arg names below.
  // Undefined variables are stripped by GraphQLClient, so unset filters are
  // simply omitted from the request rather than sent as null.
  const fields = `${MEDIA_FIELDS}${opts.includeDescription ? MEDIA_DESCRIPTION_FIELD : ""}`;
  const query = `query(
    $search:String,$type:MediaType,$page:Int,$perPage:Int,$sort:[MediaSort],
    $isAdult:Boolean,$genre_in:[String],$format_in:[MediaFormat],$status_in:[MediaStatus],
    $seasonYear:Int,$season:MediaSeason,$tag_in:[String],$onList:Boolean,
    $averageScore_greater:Int,$averageScore_lesser:Int,
    $popularity_greater:Int,$popularity_lesser:Int,
    $episodes_greater:Int,$episodes_lesser:Int,
    $startDate_greater:FuzzyDateInt,$startDate_lesser:FuzzyDateInt,
    $endDate_greater:FuzzyDateInt,$endDate_lesser:FuzzyDateInt,
    $source_in:[MediaSource],
    $genre_not_in:[String],$tag_not_in:[String],$minimumTagRank:Int,
    $format_not_in:[MediaFormat],$status_not_in:[MediaStatus],$countryOfOrigin:CountryCode,
    $duration_greater:Int,$duration_lesser:Int,$chapters_greater:Int,$chapters_lesser:Int,
    $volumes_greater:Int,$volumes_lesser:Int,$licensedBy_in:[String]
  ){
    Page(page:$page,perPage:$perPage){
      pageInfo{total currentPage lastPage hasNextPage perPage}
      media(
        search:$search,type:$type,sort:$sort,isAdult:$isAdult,genre_in:$genre_in,
        format_in:$format_in,status_in:$status_in,seasonYear:$seasonYear,season:$season,
        tag_in:$tag_in,onList:$onList,
        averageScore_greater:$averageScore_greater,averageScore_lesser:$averageScore_lesser,
        popularity_greater:$popularity_greater,popularity_lesser:$popularity_lesser,
        episodes_greater:$episodes_greater,episodes_lesser:$episodes_lesser,
        startDate_greater:$startDate_greater,startDate_lesser:$startDate_lesser,
        endDate_greater:$endDate_greater,endDate_lesser:$endDate_lesser,
        source_in:$source_in,
        genre_not_in:$genre_not_in,tag_not_in:$tag_not_in,minimumTagRank:$minimumTagRank,
        format_not_in:$format_not_in,status_not_in:$status_not_in,countryOfOrigin:$countryOfOrigin,
        duration_greater:$duration_greater,duration_lesser:$duration_lesser,
        chapters_greater:$chapters_greater,chapters_lesser:$chapters_lesser,
        volumes_greater:$volumes_greater,volumes_lesser:$volumes_lesser,
        licensedBy_in:$licensedBy_in
      ){${fields}}
    }
  }`;
  const f = opts.filter ?? {};
  // The tool schema trims `term` and rejects a blank one: a literal
  // `search: ""` matches nothing upstream and silently returns zero results.
  const search = opts.term;
  // SEARCH_MATCH ranks by relevance to `search`, so it's meaningless without a
  // term. Default to it only when there's actually a term; a term-less call
  // with no explicit sort browses in AniList's own default order instead of a
  // relevance ranking against nothing.
  const sort = opts.sort ?? (search ? ["SEARCH_MATCH"] : undefined);
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    {
      search,
      type,
      page: opts.page ?? 1,
      perPage: opts.perPage ?? 10,
      sort,
      isAdult: f.isAdult,
      genre_in: f.genre_in,
      format_in: f.format_in,
      status_in: f.status_in,
      seasonYear: f.seasonYear,
      season: f.season,
      tag_in: f.tag_in,
      onList: f.onList,
      averageScore_greater: f.averageScore_greater,
      averageScore_lesser: f.averageScore_lesser,
      popularity_greater: f.popularity_greater,
      popularity_lesser: f.popularity_lesser,
      episodes_greater: f.episodes_greater,
      episodes_lesser: f.episodes_lesser,
      startDate_greater: encodeFuzzyDateInt(f.startDate_greater as { year?: number } | undefined),
      startDate_lesser: encodeFuzzyDateInt(f.startDate_lesser as { year?: number } | undefined),
      endDate_greater: encodeFuzzyDateInt(f.endDate_greater as { year?: number } | undefined),
      endDate_lesser: encodeFuzzyDateInt(f.endDate_lesser as { year?: number } | undefined),
      source_in: f.source_in,
      genre_not_in: f.genre_not_in,
      tag_not_in: f.tag_not_in,
      minimumTagRank: f.minimumTagRank,
      format_not_in: f.format_not_in,
      status_not_in: f.status_not_in,
      countryOfOrigin: f.countryOfOrigin,
      duration_greater: f.duration_greater,
      duration_lesser: f.duration_lesser,
      chapters_greater: f.chapters_greater,
      chapters_lesser: f.chapters_lesser,
      volumes_greater: f.volumes_greater,
      volumes_lesser: f.volumes_lesser,
      licensedBy_in: f.licensedBy_in,
    },
    f.onList !== undefined ? ctx.requireAuth() : ctx.authHeader(),
  );
  return data.Page;
}

export async function searchCharacter(
  ctx: AniListContext,
  term: string,
  page = 1,
  perPage = 10,
  includeDescription = false,
): Promise<unknown> {
  const fields = `${CHARACTER_FIELDS}${includeDescription ? PERSON_DESCRIPTION_FIELD : ""}`;
  const query = `query($search:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    characters(search:$search){${fields}}
  }}`;
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    { search: term, page, perPage },
    ctx.authHeader(),
  );
  return data.Page;
}

export async function searchStaff(
  ctx: AniListContext,
  term: string,
  page = 1,
  perPage = 10,
  includeDescription = false,
): Promise<unknown> {
  const fields = `${STAFF_FIELDS}${includeDescription ? PERSON_DESCRIPTION_FIELD : ""}`;
  const query = `query($search:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    staff(search:$search){${fields}}
  }}`;
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    { search: term, page, perPage },
    ctx.authHeader(),
  );
  return data.Page;
}

export async function searchStudio(
  ctx: AniListContext,
  term: string,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  const query = `query($search:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    studios(search:$search){id name isAnimationStudio siteUrl}
  }}`;
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    { search: term, page, perPage },
    ctx.authHeader(),
  );
  return data.Page;
}

export async function searchUser(
  ctx: AniListContext,
  term: string,
  page = 1,
  perPage = 10,
  includeDescription = false,
): Promise<unknown> {
  const fields = `${USER_FIELDS}${includeDescription ? USER_DESCRIPTION_FIELD : ""}`;
  const query = `query($search:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    users(search:$search){${fields}}
  }}`;
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    { search: term, page, perPage },
    ctx.authHeader(),
  );
  return data.Page;
}

export async function searchThread(
  ctx: AniListContext,
  term?: string,
  categoryId?: CategoryId,
  mediaCategoryId?: MediaId,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  // threads(mediaCategoryId) returns an empty page for a nonexistent media
  // id — alias an existence check into the same request, like getSchedule.
  const existsField =
    mediaCategoryId !== undefined ? existsFragment("Media", "mediaCategoryId") : "";
  const query = `query($search:String,$categoryId:Int,$mediaCategoryId:Int,$page:Int,$perPage:Int,$sort:[ThreadSort]){${existsField} Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    threads(search:$search,categoryId:$categoryId,mediaCategoryId:$mediaCategoryId,sort:$sort){
      id title siteUrl replyCount viewCount isSticky createdAt user{id name} categories{id name}
    }
  }}`;
  // Trimmed and non-blank via the tool schema, same as searchMedia above.
  const search = term;
  // SEARCH_MATCH without a term degrades to oldest-thread-ID-first (confirmed
  // live: threads 1, 2, 3, ... from 2014), so a term-less browse sorts by most
  // recent reply instead — what anilist.co/forum/recent shows, minus pinning
  // sticky threads to the top.
  const sort = search ? ["SEARCH_MATCH"] : ["REPLIED_AT_DESC"];
  const data = await ctx.gql.request<{ exists?: { id: number } | null; Page: unknown }>(
    query,
    { search, categoryId, mediaCategoryId, page, perPage, sort },
    ctx.authHeader(),
  );
  if (mediaCategoryId !== undefined) {
    assertFound(data.exists, `No anime/manga found with ID ${mediaCategoryId}.`);
  }
  return data.Page;
}

export async function searchActivity(
  ctx: AniListContext,
  user?: UserId | string,
  type?: ActivityTypeFilter,
  page = 1,
  perPage = 10,
  opts: { after?: string; before?: string; isFollowing?: boolean } = {},
): Promise<unknown> {
  // AniList silently IGNORES `isFollowing: true` on an unauthenticated
  // request (confirmed live: it returns the ordinary global feed, no error)
  // — "who you follow" has no meaning without a viewer. Gate it here, before
  // any network call, so the caller gets an actionable login error instead
  // of a global feed mislabeled as their following feed. `isFollowing: false`
  // is treated as absent (no restriction), so it needs no token.
  const isFollowing = opts.isFollowing === true ? true : undefined;
  if (isFollowing && user !== undefined) {
    // Rejected rather than combined: "activity from people I follow" and
    // "activity from this one user" are two different questions; how AniList
    // combines the two filters isn't verified (it needs an authenticated
    // probe), and an un-followed user would plausibly yield a silently empty
    // page — get_user_activity already answers the one-user question.
    throw new ApiError({
      code: "bad_request",
      message:
        "Pass either `user` (one user's activity) or `isFollowing: true` (activity from " +
        "everyone you follow), not both.",
    });
  }
  const header = isFollowing ? ctx.requireAuth() : ctx.authHeader();
  return fetchActivityFeed(
    ctx,
    user,
    page,
    perPage,
    { type, createdAfter: opts.after, createdBefore: opts.before, isFollowing },
    header,
  );
}
