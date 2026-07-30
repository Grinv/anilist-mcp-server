import type { AniListContext } from "./context.js";
import { ACTIVITY_FRAGMENT, existsFragment } from "./fields.js";
import { ApiError, assertFound } from "../../lib/errors.js";
import { resolveUserId } from "./user.js";
import type { ActivityId, UserId } from "./ids.js";

export async function getActivity(ctx: AniListContext, id: ActivityId): Promise<unknown> {
  const query = `query($id:Int){Activity(id:$id){${ACTIVITY_FRAGMENT}}}`;
  const data = await ctx.gql.request<{ Activity: unknown }>(query, { id }, ctx.authHeader());
  return assertFound(data.Activity, `No activity found with ID ${id}.`);
}

export async function getUserActivity(
  ctx: AniListContext,
  user: UserId | string,
  page = 1,
  perPage = 10,
): Promise<unknown> {
  // AniList's `activities` field only accepts a numeric `userId` — there is
  // no `userName` argument (confirmed live: "Unknown argument userName on
  // field activities of type Page"), unlike most other user-scoped fields in
  // this API. A numeric id doesn't error on a bad value either (see
  // docs/api-references.md's "Page connection filtered by a parent id"
  // section) — existsFragment() aliases it into this same request instead
  // of a separate round trip. A username has a genuine data dependency (the
  // numeric id it resolves to must be known before `activities(userId:...)`
  // can even be built), so it still needs a separate resolution request
  // first — leaving it unresolved would make AniList treat the `userId`
  // filter as absent and silently return the *global* activity feed instead
  // of erroring.
  const header = ctx.authHeader();
  if (typeof user === "number") {
    const query = `query($userId:Int,$page:Int,$perPage:Int){
      ${existsFragment("User", "userId")}
      feed:Page(page:$page,perPage:$perPage){
        pageInfo{total currentPage lastPage hasNextPage}
        activities(userId:$userId,sort:ID_DESC){${ACTIVITY_FRAGMENT}}
      }
    }`;
    const data = await ctx.gql.request<{ exists: { id: number } | null; feed: unknown }>(
      query,
      { userId: user, page, perPage },
      header,
    );
    assertFound(data.exists, `No AniList user found with ID ${user}.`);
    return data.feed;
  }
  const userId = await resolveUserId(ctx, user, header);
  const activitiesQuery = `query($userId:Int,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    activities(userId:$userId,sort:ID_DESC){${ACTIVITY_FRAGMENT}}
  }}`;
  const pageData = await ctx.gql.request<{ Page: unknown }>(
    activitiesQuery,
    { userId, page, perPage },
    header,
  );
  return pageData.Page;
}

export async function postTextActivity(
  ctx: AniListContext,
  text: string,
  id?: ActivityId,
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
  recipientId: UserId,
  message: string,
  id?: ActivityId,
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

export async function deleteActivity(ctx: AniListContext, id: ActivityId): Promise<unknown> {
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
