import type { AniListContext } from "./context.js";
import { USER_FIELDS } from "./fields.js";

export async function getUserProfile(ctx: AniListContext, user: number | string): Promise<unknown> {
  const byId = typeof user === "number";
  const query = byId
    ? `query($id:Int){User(id:$id){${USER_FIELDS}}}`
    : `query($name:String){User(name:$name){${USER_FIELDS}}}`;
  const data = await ctx.gql.request<{ User: unknown }>(
    query,
    byId ? { id: user } : { name: user },
    ctx.authHeader(),
  );
  return data.User;
}

export async function getUserStats(ctx: AniListContext, user: number | string): Promise<unknown> {
  const byId = typeof user === "number";
  const statsFields = `statistics{anime{count meanScore minutesWatched episodesWatched}manga{count meanScore chaptersRead volumesRead}}`;
  const query = byId
    ? `query($id:Int){User(id:$id){${statsFields}}}`
    : `query($name:String){User(name:$name){${statsFields}}}`;
  const data = await ctx.gql.request<{ User: unknown }>(
    query,
    byId ? { id: user } : { name: user },
    ctx.authHeader(),
  );
  return data.User;
}

export async function getFullUserInfo(
  ctx: AniListContext,
  user: number | string,
): Promise<unknown> {
  const byId = typeof user === "number";
  const fields = `${USER_FIELDS} statistics{anime{count meanScore minutesWatched episodesWatched}manga{count meanScore chaptersRead volumesRead}}`;
  const query = byId
    ? `query($id:Int){User(id:$id){${fields}}}`
    : `query($name:String){User(name:$name){${fields}}}`;
  const data = await ctx.gql.request<{ User: unknown }>(
    query,
    byId ? { id: user } : { name: user },
    ctx.authHeader(),
  );
  return data.User;
}

export async function getAuthorizedUser(ctx: AniListContext): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `query{Viewer{${USER_FIELDS}}}`;
  const data = await ctx.gql.request<{ Viewer: unknown }>(query, {}, header);
  return data.Viewer;
}

export async function followUser(ctx: AniListContext, id: number): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int){ToggleFollow(userId:$id){id name isFollowing}}`;
  const data = await ctx.gql.request<{ ToggleFollow: unknown }>(query, { id }, header);
  return data.ToggleFollow;
}

export interface UpdateUserFields {
  about?: string;
  titleLanguage?: string;
  displayAdultContent?: boolean;
  scoreFormat?: string;
}

export async function updateUser(ctx: AniListContext, fields: UpdateUserFields): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($about:String,$titleLanguage:UserTitleLanguage,$displayAdultContent:Boolean,$scoreFormat:ScoreFormat){
    UpdateUser(about:$about,titleLanguage:$titleLanguage,displayAdultContent:$displayAdultContent,scoreFormat:$scoreFormat){id name}
  }`;
  const data = await ctx.gql.request<{ UpdateUser: unknown }>(query, { ...fields }, header);
  return data.UpdateUser;
}
