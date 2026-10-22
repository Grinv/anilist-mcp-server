import type { AniListContext } from "./context.ts";
import { assertFound } from "../../lib/errors.ts";
import type { ThreadId, CommentId, CategoryId, MediaId } from "./ids.ts";
import { existsFragment } from "./fields.ts";
import { deleteById } from "./deleteById.ts";

export async function getThread(ctx: AniListContext, id: ThreadId): Promise<unknown> {
  const query = `query($id:Int){Thread(id:$id){id title body(asHtml:false) siteUrl replyCommentId
    isSticky isLocked replyCount viewCount likeCount isLiked user{id name} categories{id name}
    mediaCategories{id title{romaji english}}}}`;
  const data = await ctx.gql.request<{ Thread: unknown }>(query, { id }, ctx.authHeader());
  return assertFound(data.Thread, `No thread found with ID ${id}.`);
}

export async function getThreadComments(
  ctx: AniListContext,
  threadId: ThreadId,
  page = 1,
  perPage = 25,
): Promise<unknown> {
  // threadComments' Page connection doesn't error for a nonexistent threadId
  // (see docs/api-references.md's "Page connection filtered by a parent id"
  // section) — existsFragment() aliases the existence check into this same
  // request instead of a separate round trip.
  // threadComments only returns TOP-LEVEL comments — a reply posted via
  // post_thread_comment's parentCommentId doesn't appear in this array at
  // all; it's nested under its parent's own childComments (an untyped
  // AniList `Json` blob, not a further-queryable ThreadComment list).
  const query = `query($threadId:Int,$page:Int,$perPage:Int){
    ${existsFragment("Thread", "threadId")}
    Page(page:$page,perPage:$perPage){
      pageInfo{total currentPage lastPage hasNextPage}
      threadComments(threadId:$threadId){id comment(asHtml:false) siteUrl likeCount isLiked user{id name} childComments}
    }
  }`;
  const data = await ctx.gql.request<{ exists: { id: number } | null; Page: unknown }>(
    query,
    { threadId, page, perPage },
    ctx.authHeader(),
  );
  assertFound(data.exists, `No thread found with ID ${threadId}.`);
  return data.Page;
}

export interface SaveThreadOptions {
  id?: ThreadId;
  categories?: CategoryId[];
  mediaCategories?: MediaId[];
  sticky?: boolean;
  locked?: boolean;
}

export async function postThread(
  ctx: AniListContext,
  title: string | undefined,
  body: string | undefined,
  opts: SaveThreadOptions = {},
): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int,$title:String,$body:String,$categories:[Int],$mediaCategories:[Int],$sticky:Boolean,$locked:Boolean){
    SaveThread(id:$id,title:$title,body:$body,categories:$categories,mediaCategories:$mediaCategories,sticky:$sticky,locked:$locked){
      id title siteUrl replyCount viewCount likeCount isLiked
    }
  }`;
  const data = await ctx.gql.request<{ SaveThread: unknown }>(
    query,
    {
      id: opts.id,
      title,
      body,
      categories: opts.categories,
      mediaCategories: opts.mediaCategories,
      sticky: opts.sticky,
      locked: opts.locked,
    },
    header,
  );
  return data.SaveThread;
}

export async function postThreadComment(
  ctx: AniListContext,
  threadId: ThreadId,
  comment: string,
  opts: { id?: CommentId; parentCommentId?: CommentId } = {},
): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int,$threadId:Int,$parentCommentId:Int,$comment:String){
    SaveThreadComment(id:$id,threadId:$threadId,parentCommentId:$parentCommentId,comment:$comment){
      id comment(asHtml:false) siteUrl likeCount isLiked
    }
  }`;
  const data = await ctx.gql.request<{ SaveThreadComment: unknown }>(
    query,
    { id: opts.id, threadId, parentCommentId: opts.parentCommentId, comment },
    header,
  );
  return data.SaveThreadComment;
}

export function deleteThread(ctx: AniListContext, id: ThreadId): Promise<unknown> {
  return deleteById(ctx, "DeleteThread", id, "thread");
}

export function deleteThreadComment(ctx: AniListContext, id: CommentId): Promise<unknown> {
  return deleteById(ctx, "DeleteThreadComment", id, "comment");
}
