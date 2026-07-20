import type { AniListContext } from "./context.js";
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
  return data.Studio;
}

export async function getGenres(ctx: AniListContext): Promise<unknown> {
  const data = await ctx.gql.request<{ GenreCollection: unknown }>(
    `query{GenreCollection}`,
    {},
    ctx.authHeader(),
  );
  return data.GenreCollection;
}

export async function getMediaTags(ctx: AniListContext): Promise<unknown> {
  const query = `query{MediaTagCollection{id name description category isAdult}}`;
  const data = await ctx.gql.request<{ MediaTagCollection: unknown }>(query, {}, ctx.authHeader());
  return data.MediaTagCollection;
}

export async function getSiteStatistics(ctx: AniListContext): Promise<unknown> {
  const query = `query{SiteStatistics{
    users(sort:DATE_DESC,perPage:7){nodes{date count change}}
    anime(sort:DATE_DESC,perPage:7){nodes{date count change}}
    manga(sort:DATE_DESC,perPage:7){nodes{date count change}}
  }}`;
  const data = await ctx.gql.request<{ SiteStatistics: unknown }>(query, {}, ctx.authHeader());
  return data.SiteStatistics;
}
