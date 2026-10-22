import type { AniListContext } from "./context.ts";
import { assertFound } from "../../lib/errors.ts";
import type { StudioId } from "./ids.ts";
import { STUDIO_FIELDS, STUDIO_DETAIL_FIELDS, STUDIO_FILMOGRAPHY_VARS } from "./fields.ts";

/** Pagination and server-side filters for get_studio's `media` filmography
 *  (see fields.ts's STUDIO_FILMOGRAPHY_VARS). Unset filters are dropped from
 *  the request. */
export interface StudioFilmographyOptions {
  page?: number;
  perPage?: number;
  isMain?: boolean;
  onList?: boolean;
}

export async function getStudio(
  ctx: AniListContext,
  idOrName: StudioId | string,
  opts: StudioFilmographyOptions = {},
): Promise<unknown> {
  const byId = typeof idOrName === "number";
  const fields = `${STUDIO_FIELDS}${STUDIO_DETAIL_FIELDS}`;
  const query = byId
    ? `query($id:Int,${STUDIO_FILMOGRAPHY_VARS}){Studio(id:$id){${fields}}}`
    : `query($search:String,${STUDIO_FILMOGRAPHY_VARS}){Studio(search:$search){${fields}}}`;
  const { page = 1, perPage = 25, isMain, onList } = opts;
  const data = await ctx.gql.request<{ Studio: unknown }>(
    query,
    { ...(byId ? { id: idOrName } : { search: idOrName }), page, perPage, isMain, onList },
    onList !== undefined ? ctx.requireAuth() : ctx.authHeader(),
  );
  return assertFound(data.Studio, `No studio found matching ${JSON.stringify(idOrName)}.`);
}

export async function getGenres(ctx: AniListContext): Promise<unknown> {
  const data = await ctx.gql.request<{ GenreCollection: unknown }>(
    `query{GenreCollection}`,
    {},
    ctx.authHeader(),
  );
  return data.GenreCollection;
}

/** AniList's `MediaTagCollection` field takes no page/perPage args of its own
 *  — it always returns the complete ~425-tag list in one response, which is
 *  large enough (~70KB with descriptions) to blow a calling agent's context
 *  budget. Paginate client-side: the request itself still fetches everything
 *  in one round trip (cheap, and cached by GraphQLClient across calls), but
 *  only the requested slice is returned to the caller. */
export async function getMediaTags(
  ctx: AniListContext,
  page = 1,
  perPage = 25,
): Promise<{
  tags: unknown[];
  pageInfo: {
    total: number;
    currentPage: number;
    perPage: number;
    lastPage: number;
    hasNextPage: boolean;
  };
}> {
  const query = `query{MediaTagCollection{id name description category isAdult}}`;
  const data = await ctx.gql.request<{ MediaTagCollection: unknown[] }>(
    query,
    {},
    ctx.authHeader(),
  );
  const all = data.MediaTagCollection ?? [];
  const start = (page - 1) * perPage;
  return {
    tags: all.slice(start, start + perPage),
    pageInfo: {
      total: all.length,
      currentPage: page,
      perPage,
      lastPage: Math.max(1, Math.ceil(all.length / perPage)),
      hasNextPage: start + perPage < all.length,
    },
  };
}

export async function getSiteStatistics(
  ctx: AniListContext,
  page = 1,
  perPage = 7,
): Promise<unknown> {
  const query = `query($page:Int,$perPage:Int){SiteStatistics{
    users(sort:DATE_DESC,page:$page,perPage:$perPage){nodes{date count change} pageInfo{total currentPage lastPage hasNextPage perPage}}
    anime(sort:DATE_DESC,page:$page,perPage:$perPage){nodes{date count change} pageInfo{total currentPage lastPage hasNextPage perPage}}
    manga(sort:DATE_DESC,page:$page,perPage:$perPage){nodes{date count change} pageInfo{total currentPage lastPage hasNextPage perPage}}
  }}`;
  const data = await ctx.gql.request<{ SiteStatistics: unknown }>(
    query,
    { page, perPage },
    ctx.authHeader(),
  );
  return data.SiteStatistics;
}
