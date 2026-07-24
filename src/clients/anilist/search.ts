import type { AniListContext } from "./context.js";
import { assertFound } from "../../lib/errors.js";
import {
  MEDIA_FIELDS,
  MEDIA_DESCRIPTION_FIELD,
  CHARACTER_FIELDS,
  STAFF_FIELDS,
  USER_FIELDS,
  ACTIVITY_FRAGMENT,
} from "./fields.js";

/** AniList's `FuzzyDateInt` scalar is a single Int in `YyyyMmDd` form (e.g.
 *  `20140204`), distinct from `FuzzyDateInput` (the `{year,month,day}` object
 *  used elsewhere, e.g. list.ts's startedAt/completedAt) — used only for
 *  these range-filter args. Missing month/day become `0`, matching AniList's
 *  own convention for a partial date. Returns undefined for a wholly-empty
 *  input (stripped by GraphQLClient rather than sent as a meaningless 0). */
function encodeFuzzyDateInt(date?: {
  year?: number;
  month?: number;
  day?: number;
}): number | undefined {
  if (!date || date.year === undefined) return undefined;
  return date.year * 10000 + (date.month ?? 0) * 100 + (date.day ?? 0);
}

export async function searchMedia(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
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
    $source_in:[MediaSource]
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
        source_in:$source_in
      ){${fields}}
    }
  }`;
  const f = opts.filter ?? {};
  // An empty/whitespace-only term must behave like an omitted one (the
  // documented term-less browse/ranking mode) rather than being sent to
  // AniList as a literal `search: ""`, which matches nothing and silently
  // returns zero results.
  const search = opts.term?.trim() ? opts.term : undefined;
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    {
      search,
      type,
      page: opts.page ?? 1,
      perPage: opts.perPage ?? 10,
      sort: opts.sort ?? ["SEARCH_MATCH"],
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
    },
    ctx.authHeader(),
  );
  return data.Page;
}

export async function searchCharacter(
  ctx: AniListContext,
  term: string,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  const query = `query($search:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    characters(search:$search){${CHARACTER_FIELDS}}
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
): Promise<unknown> {
  const query = `query($search:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    staff(search:$search){${STAFF_FIELDS}}
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
): Promise<unknown> {
  const query = `query($search:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    users(search:$search){${USER_FIELDS}}
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
  categoryId?: number,
  mediaCategoryId?: number,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  const query = `query($search:String,$categoryId:Int,$mediaCategoryId:Int,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    threads(search:$search,categoryId:$categoryId,mediaCategoryId:$mediaCategoryId,sort:[SEARCH_MATCH]){
      id title siteUrl replyCount viewCount isSticky createdAt user{id name} categories{id name}
    }
  }}`;
  // Same empty/whitespace-term fix as searchMedia above — an explicit
  // `search: ""` matches nothing, silently returning zero results instead of
  // the intended term-less browse/filter mode.
  const search = term?.trim() ? term : undefined;
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    { search, categoryId, mediaCategoryId, page, perPage },
    ctx.authHeader(),
  );
  return data.Page;
}

export async function searchActivity(
  ctx: AniListContext,
  user?: number | string,
  type?: string,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  const header = ctx.authHeader();
  // AniList's `activities` field only accepts a numeric `userId` filter, so a
  // username has a genuine data dependency (its numeric id must be known
  // before `activities(userId:...)` can even be built) and needs a separate
  // resolution request first — same constraint as getUserActivity. Leaving a
  // username unresolved would make AniList treat the `userId` filter as
  // absent and silently return the *global* activity feed instead of
  // erroring on an unknown username.
  let userId: number | undefined;
  if (typeof user === "string") {
    const resolveQuery = `query($name:String){User(name:$name){id}}`;
    const resolveData = await ctx.gql.request<{ User: { id: number } | null }>(
      resolveQuery,
      { name: user },
      header,
    );
    userId = assertFound(resolveData.User, `No AniList user named "${user}" was found.`).id;
  } else {
    userId = user;
  }
  const query = `query($userId:Int,$type:ActivityType,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    activities(userId:$userId,type:$type,sort:ID_DESC){${ACTIVITY_FRAGMENT}}
  }}`;
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    { userId, type, page, perPage },
    header,
  );
  return data.Page;
}
