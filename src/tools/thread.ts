import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as thread from "../clients/anilist/thread.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import {
  pageInfoSchema,
  deleteResult,
  anilistId,
  mediaId,
  threadId,
  commentId,
  categoryId,
  paginationFields,
  deleteToolAnnotations,
} from "./outputSchemas.js";

const savedThread = z
  .object({
    id: anilistId,
    title: z.string().nullish(),
    siteUrl: z.httpUrl().nullish(),
    replyCount: z.int().nonnegative().nullish(),
    viewCount: z.int().nonnegative().nullish(),
    likeCount: z.int().nonnegative().nullish(),
    isLiked: z.boolean().nullish(),
  })
  .loose();

const savedThreadComment = z
  .object({
    id: anilistId,
    comment: z.string().nullish(),
    siteUrl: z.httpUrl().nullish(),
    likeCount: z.int().nonnegative().nullish(),
    isLiked: z.boolean().nullish(),
  })
  .loose();

const threadObject = z
  .object({
    id: anilistId,
    title: z.string().nullish(),
    body: z.string().nullish(),
    siteUrl: z.httpUrl().nullish(),
    replyCommentId: anilistId.nullish(),
    isSticky: z.boolean().nullish(),
    isLocked: z.boolean().nullish(),
    replyCount: z.int().nonnegative().nullish(),
    viewCount: z.int().nonnegative().nullish(),
    likeCount: z.int().nonnegative().nullish(),
    isLiked: z.boolean().nullish(),
    user: z.object({ id: anilistId, name: z.string().nullish() }).loose().nullish(),
    categories: z.array(z.object({ id: anilistId, name: z.string().nullish() }).loose()).nullish(),
    mediaCategories: z
      .array(
        z
          .object({
            id: anilistId,
            title: z
              .object({ romaji: z.string().nullish(), english: z.string().nullish() })
              .nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

const threadComment = z
  .object({
    id: anilistId,
    comment: z.string().nullish(),
    siteUrl: z.httpUrl().nullish(),
    likeCount: z.int().nonnegative().nullish(),
    isLiked: z.boolean().nullish(),
    user: z.object({ id: anilistId, name: z.string().nullish() }).loose().nullish(),
    // AniList's own untyped `Json` blob — replies posted via
    // post_thread_comment's `parentCommentId` live here, not as separate
    // top-level entries in this array.
    childComments: z.json().nullish(),
  })
  .loose();

export function registerThreadTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_thread",
    {
      title: "Get a forum thread",
      description:
        "Get an AniList forum thread's title, body and metadata (including `replyCount`, " +
        "`viewCount`, `likeCount`, `isLiked`) by its ID.",
      inputSchema: z.object({
        id: threadId.describe(
          "AniList thread ID — use search_thread to find one, or pass one already known " +
            "(e.g. from an AniList forum URL, anilist.co/forum/thread/<id>).",
        ),
      }),
      outputSchema: z.object({ thread: threadObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) => guard(async () => jsonResult({ thread: await thread.getThread(client.ctx(), id) })),
  );

  server.registerTool(
    "get_thread_comments",
    {
      title: "Get comments on a forum thread",
      description:
        "List top-level comments posted on an AniList forum thread, by the thread's ID. " +
        "Replies (posted via post_thread_comment's `parentCommentId`) are nested under their " +
        "parent's `childComments` rather than appearing as separate entries in this list.",
      inputSchema: z.object({
        threadId: threadId.describe(
          "AniList thread ID — use search_thread to find one, or pass one already known " +
            "(e.g. from an AniList forum URL, or from get_thread).",
        ),
        ...paginationFields(25),
      }),
      outputSchema: z.object({
        comments: z
          .object({
            pageInfo: pageInfoSchema.optional(),
            threadComments: z.array(threadComment).optional(),
          })
          .loose(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ threadId, page, perPage }) =>
      guard(async () =>
        jsonResult({
          comments: await thread.getThreadComments(client.ctx(), threadId, page, perPage),
        }),
      ),
  );

  server.registerTool(
    "post_thread",
    {
      title: "Post a forum thread",
      description:
        "[Requires login] Post a new forum thread to the authenticated user's own AniList " +
        "account, or update an existing one by passing its `id`. Use search_thread first if " +
        "you want to check whether a similar thread already exists before posting a new one. " +
        "Note: this tool's own response doesn't include `categories`/`mediaCategories`/" +
        "`isSticky`/`isLocked` — call get_thread with the returned `id` afterward to confirm " +
        "whether a category/sticky/locked change actually applied, especially since " +
        "sticky/locked can silently no-op and categories/mediaCategories can silently drop " +
        "existing values (see those fields' own descriptions below).",
      inputSchema: z
        .object({
          title: z
            .string()
            .min(6)
            .max(120)
            .optional()
            .describe(
              "Thread title (per AniList's own schema: 6-120 characters) — REQUIRED when " +
                "creating a new thread, optional when updating one via `id` (confirmed live: " +
                "omitting it on an update leaves the existing title unchanged, it isn't cleared).",
            ),
          body: z
            .string()
            .min(1)
            .max(30000)
            .optional()
            .describe(
              "Thread body (markdown; per AniList's own schema, up to 30000 characters) — " +
                "REQUIRED when creating a new thread, optional when updating one via `id` " +
                "(confirmed live: omitting it on an update leaves the existing body unchanged).",
            ),
          categories: z
            .array(categoryId)
            .optional()
            .describe(
              "Forum category IDs to post this thread under — REQUIRED when creating a new " +
                "thread (AniList rejects the mutation otherwise), optional when updating one via " +
                "`id`. When updating and you DO set this, it's a full replace, not a merge — " +
                "confirmed live: an existing thread with categories [A] updated with just [B] " +
                "ended up with [B] only, A silently dropped. Fetch the thread's current " +
                "categories first (get_thread) and include every one you want to keep. Not " +
                "independently listable by any tool; resolve one from a thread you've already " +
                "read (get_thread's/search_thread's `categories` field) or from a forum URL " +
                "like anilist.co/forum/recent?category=<id>.",
            ),
          mediaCategories: z
            .array(mediaId)
            .optional()
            .describe(
              "AniList anime/manga IDs to tag this thread with, for threads about a specific " +
                "title (from search_media/get_media). Optional on both create and update. When " +
                "updating and you DO set this, it's a full replace, not a merge — confirmed " +
                "live: an existing thread tagged with [A] updated with just [B] ended up with " +
                "[B] only, A silently dropped (same behavior as `categories` above). Fetch the " +
                "thread's current `mediaCategories` first (get_thread) if you need to keep an " +
                "existing tag alongside a new one.",
            ),
          sticky: z
            .boolean()
            .optional()
            .describe(
              "Pin this thread (only takes effect if you have moderator permission — confirmed " +
                "live that a non-mod account's own thread silently stays unpinned).",
            ),
          locked: z
            .boolean()
            .optional()
            .describe(
              "Lock this thread to prevent further replies (only takes effect if you have " +
                "moderator permission — confirmed live that a non-mod account's own thread " +
                "silently stays unlocked).",
            ),
          id: threadId.optional().describe("Thread ID to update instead of creating a new one."),
        })
        .refine((v) => v.id !== undefined || v.title !== undefined, {
          message: "`title` is required when creating a new thread (no `id` given).",
        })
        .refine((v) => v.id !== undefined || v.body !== undefined, {
          message: "`body` is required when creating a new thread (no `id` given).",
        })
        .refine((v) => v.id !== undefined || v.categories !== undefined, {
          message: "`categories` is required when creating a new thread (no `id` given).",
        }),
      outputSchema: z.object({ thread: savedThread }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ title, body, categories, mediaCategories, sticky, locked, id }) =>
      guard(async () =>
        jsonResult({
          thread: await thread.postThread(client.ctx(), title, body, {
            id,
            categories,
            mediaCategories,
            sticky,
            locked,
          }),
        }),
      ),
  );

  server.registerTool(
    "post_thread_comment",
    {
      title: "Post a comment on a forum thread",
      description:
        "[Requires login] Post a new comment on an AniList forum thread from the authenticated " +
        "user's account, or update an existing one by passing its `id`.",
      inputSchema: z.object({
        threadId: threadId.describe(
          "AniList thread ID to comment on (from get_thread/search_thread).",
        ),
        comment: z
          .string()
          .min(1)
          .max(12000)
          .describe(
            "The comment text to post (markdown; per AniList's own schema, up to 12000 characters).",
          ),
        parentCommentId: commentId
          .optional()
          .describe(
            "Reply to this specific comment instead of posting top-level (from " +
              "get_thread_comments). The reply then appears nested under that comment's " +
              "`childComments` in get_thread_comments, not as a new top-level entry. Not the " +
              "comment being edited — that's `id`.",
          ),
        id: commentId
          .optional()
          .describe(
            "Comment ID to update instead of creating a new one. Not the comment you're " +
              "replying to — that's `parentCommentId`.",
          ),
      }),
      outputSchema: z.object({ comment: savedThreadComment }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ threadId, comment, parentCommentId, id }) =>
      guard(async () =>
        jsonResult({
          comment: await thread.postThreadComment(client.ctx(), threadId, comment, {
            id,
            parentCommentId,
          }),
        }),
      ),
  );

  server.registerTool(
    "delete_thread",
    {
      title: "Delete a forum thread",
      description:
        "[Requires login] Delete a forum thread the authenticated user owns, by its ID (from " +
        "search_thread, get_thread, or the id returned by post_thread). This cannot be undone, " +
        "and calling it again on an already-deleted id errors rather than silently succeeding.",
      inputSchema: z.object({ id: threadId.describe("AniList thread ID to delete.") }),
      outputSchema: z.object({ result: deleteResult }),
      annotations: deleteToolAnnotations,
    },
    ({ id }) =>
      guard(async () => jsonResult({ result: await thread.deleteThread(client.ctx(), id) })),
  );

  server.registerTool(
    "delete_thread_comment",
    {
      title: "Delete a comment on a forum thread",
      description:
        "[Requires login] Delete a comment the authenticated user owns, by its ID (from " +
        "get_thread_comments or the id returned by post_thread_comment). This cannot be " +
        "undone, and calling it again on an already-deleted id errors rather than silently " +
        "succeeding.",
      inputSchema: z.object({ id: commentId.describe("AniList comment ID to delete.") }),
      outputSchema: z.object({ result: deleteResult }),
      annotations: deleteToolAnnotations,
    },
    ({ id }) =>
      guard(async () => jsonResult({ result: await thread.deleteThreadComment(client.ctx(), id) })),
  );
}
