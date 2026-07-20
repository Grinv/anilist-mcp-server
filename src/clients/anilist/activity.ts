import type { AniListContext } from "./context.js";
import { ACTIVITY_FRAGMENT } from "./fields.js";
import { ApiError } from "../../lib/errors.js";

export async function getActivity(ctx: AniListContext, id: number): Promise<unknown> {
  const query = `query($id:Int){Activity(id:$id){${ACTIVITY_FRAGMENT}}}`;
  const data = await ctx.gql.request<{ Activity: unknown }>(query, { id }, ctx.authHeader());
  return data.Activity;
}

export async function getUserActivity(
  ctx: AniListContext,
  user: number | string,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  // AniList's `activities` field only accepts a numeric `userId` — there is
  // no `userName` argument (confirmed live: "Unknown argument userName on
  // field activities of type Page"), unlike most other user-scoped fields in
  // this API. Resolve a username to its id first rather than passing it
  // straight through.
  const header = ctx.authHeader();
  let userId: number;
  if (typeof user === "number") {
    userId = user;
  } else {
    const data = await ctx.gql.request<{ User: { id: number } | null }>(
      `query($name:String){User(name:$name){id}}`,
      { name: user },
      header,
    );
    // A resolved-to-nothing username must fail loudly — passing `userId:
    // undefined` through to `activities(userId:$userId,...)` makes AniList
    // treat the filter as absent entirely and silently return the *global*
    // activity feed instead of erroring, which looks like a valid (wrong) answer.
    if (!data.User) {
      throw new ApiError({
        code: "not_found",
        message: `No AniList user named "${user}" was found.`,
      });
    }
    userId = data.User.id;
  }
  const query = `query($userId:Int,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    activities(userId:$userId,sort:ID_DESC){${ACTIVITY_FRAGMENT}}
  }}`;
  const data = await ctx.gql.request<{ Page: unknown }>(query, { userId, page, perPage }, header);
  return data.Page;
}

export async function postTextActivity(
  ctx: AniListContext,
  text: string,
  id?: number,
): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int,$text:String){SaveTextActivity(id:$id,text:$text){
    ... on TextActivity { id text(asHtml:false) siteUrl }
  }}`;
  const data = await ctx.gql.request<{ SaveTextActivity: unknown }>(query, { id, text }, header);
  return data.SaveTextActivity;
}

export async function postMessageActivity(
  ctx: AniListContext,
  recipientId: number,
  message: string,
  id?: number,
): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int,$recipientId:Int,$message:String){SaveMessageActivity(id:$id,recipientId:$recipientId,message:$message){
    ... on MessageActivity { id message(asHtml:false) siteUrl }
  }}`;
  const data = await ctx.gql.request<{ SaveMessageActivity: unknown }>(
    query,
    { id, recipientId, message },
    header,
  );
  return data.SaveMessageActivity;
}

export async function deleteActivity(ctx: AniListContext, id: number): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int){DeleteActivity(id:$id){deleted}}`;
  const data = await ctx.gql.request<{ DeleteActivity: { deleted?: boolean } | null }>(
    query,
    { id },
    header,
  );
  // AniList can return 200 with `{deleted: false}` (e.g. already gone, or not
  // owned by the caller) instead of a GraphQL error — surface that as a real
  // failure rather than reporting success for a no-op deletion.
  if (!data.DeleteActivity?.deleted) {
    throw new ApiError({
      code: "not_found",
      message:
        "AniList reported this activity as not deleted — it may not exist or you may not own it.",
    });
  }
  return data.DeleteActivity;
}
