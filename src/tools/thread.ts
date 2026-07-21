import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as thread from "../clients/anilist/thread.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { pageInfoSchema, deleteResult, anilistId } from "./outputSchemas.js";

const threadObject = z
  .object({
    id: z.number().int(),
    title: z.string().nullish(),
    body: z.string().nullish(),
    siteUrl: z.string().nullish(),
    replyCommentId: z.number().int().nullish(),
    user: z.object({ id: z.number().int(), name: z.string().nullish() }).passthrough().nullish(),
    categories: z
      .array(z.object({ id: z.number().int(), name: z.string().nullish() }).passthrough())
      .nullish(),
  })
  .passthrough();

const threadComment = z
  .object({
    id: z.number().int(),
    comment: z.string().nullish(),
    siteUrl: z.string().nullish(),
    user: z.object({ id: z.number().int(), name: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export function registerThreadTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_thread",
    {
      title: "Get a forum thread",
      description: "Get an AniList forum thread's title, body and metadata by its ID.",
      inputSchema: z.object({
        id: anilistId.describe(
          "AniList thread ID — there's no search_thread tool, so this typically comes from " +
            "an AniList forum URL (anilist.co/forum/thread/<id>) the caller already has.",
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
      description: "List comments posted on an AniList forum thread, by the thread's ID.",
      inputSchema: z.object({
        threadId: anilistId.describe(
          "AniList thread ID — there's no search_thread tool, so this typically comes from " +
            "an AniList forum URL (anilist.co/forum/thread/<id>) or from get_thread.",
        ),
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(25).describe("Results per page (max 25)."),
      }),
      outputSchema: z.object({
        comments: z
          .object({
            pageInfo: pageInfoSchema.optional(),
            threadComments: z.array(threadComment).optional(),
          })
          .passthrough(),
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
    "delete_thread",
    {
      title: "Delete a forum thread",
      description:
        "[Requires login] Delete a forum thread the authenticated user owns, by its ID. This cannot be undone.",
      inputSchema: z.object({ id: anilistId.describe("AniList thread ID to delete.") }),
      outputSchema: z.object({ result: deleteResult }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ id }) =>
      guard(async () => jsonResult({ result: await thread.deleteThread(client.ctx(), id) })),
  );
}
