import type { AniListContext } from "./context.js";
import {
  MEDIA_FIELDS,
  CHARACTER_FIELDS,
  STAFF_FIELDS,
  USER_FIELDS,
  ACTIVITY_FRAGMENT,
} from "./fields.js";

export async function searchMedia(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  opts: {
    term?: string;
    filter?: Record<string, unknown>;
    page?: number;
    perPage?: number;
    sort?: string[];
  },
): Promise<unknown> {
  // AniList's Media field takes filter args flat (no nested input object),
  // so translate the caller's filter map into the individual arg names below.
  // Undefined variables are stripped by GraphQLClient, so unset filters are
  // simply omitted from the request rather than sent as null.
  const query = `query(
    $search:String,$type:MediaType,$page:Int,$perPage:Int,$sort:[MediaSort],
    $isAdult:Boolean,$genre_in:[String],$format_in:[MediaFormat],$status_in:[MediaStatus],
    $seasonYear:Int,$season:MediaSeason
  ){
    Page(page:$page,perPage:$perPage){
      pageInfo{total currentPage lastPage hasNextPage perPage}
      media(
        search:$search,type:$type,sort:$sort,isAdult:$isAdult,genre_in:$genre_in,
        format_in:$format_in,status_in:$status_in,seasonYear:$seasonYear,season:$season
      ){${MEDIA_FIELDS}}
    }
  }`;
  const f = opts.filter ?? {};
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    {
      search: opts.term,
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

export async function searchActivity(
  ctx: AniListContext,
  userId?: number,
  type?: string,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  const query = `query($userId:Int,$type:ActivityType,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    activities(userId:$userId,type:$type,sort:ID_DESC){${ACTIVITY_FRAGMENT}}
  }}`;
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    { userId, type, page, perPage },
    ctx.authHeader(),
  );
  return data.Page;
}
