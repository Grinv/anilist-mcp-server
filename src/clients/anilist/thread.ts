import type { AniListContext } from "./context.js";
import { ApiError } from "../../lib/errors.js";

export async function getThread(ctx: AniListContext, id: number): Promise<unknown> {
  const query = `query($id:Int){Thread(id:$id){id title body(asHtml:false) siteUrl replyCommentId
    user{id name} categories{id name}}}`;
  const data = await ctx.gql.request<{ Thread: unknown }>(query, { id }, ctx.authHeader());
  return data.Thread;
}

export async function getThreadComments(
  ctx: AniListContext,
  threadId: number,
  page = 1,
  perPage = 25,
): Promise<unknown> {
  const query = `query($threadId:Int,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    threadComments(threadId:$threadId){id comment(asHtml:false) siteUrl user{id name}}
  }}`;
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    { threadId, page, perPage },
    ctx.authHeader(),
  );
  return data.Page;
}

export async function deleteThread(ctx: AniListContext, id: number): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int){DeleteThread(id:$id){deleted}}`;
  const data = await ctx.gql.request<{ DeleteThread: { deleted?: boolean } | null }>(
    query,
    { id },
    header,
  );
  // AniList can return 200 with `{deleted: false}` (e.g. already gone, or not
  // owned by the caller) instead of a GraphQL error — surface that as a real
  // failure rather than reporting success for a no-op deletion.
  if (!data.DeleteThread?.deleted) {
    throw new ApiError({
      code: "not_found",
      message:
        "AniList reported this thread as not deleted — it may not exist or you may not own it.",
    });
  }
  return data.DeleteThread;
}
