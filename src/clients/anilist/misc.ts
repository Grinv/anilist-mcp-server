import type { AniListContext } from "./context.js";
import { assertFound } from "../../lib/errors.js";
import { STUDIO_FIELDS } from "./fields.js";

export async function getStudio(ctx: AniListContext, idOrName: number | string): Promise<unknown> {
  const byId = typeof idOrName === "number";
  const query = byId
    ? `query($id:Int){Studio(id:$id){${STUDIO_FIELDS}}}`
    : `query($search:String){Studio(search:$search){${STUDIO_FIELDS}}}`;
  const data = await ctx.gql.request<{ Studio: unknown }>(
    query,
    byId ? { id: idOrName } : { search: idOrName },
    ctx.authHeader(),
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
  pageInfo: { total: number; currentPage: number; perPage: number; hasNextPage: boolean };
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
