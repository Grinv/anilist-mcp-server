import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as activity from "../clients/anilist/activity.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { pageInfoSchema, deleteResult, anilistId, userIdOrName } from "./outputSchemas.js";

/** Matches the ACTIVITY_FRAGMENT union (TextActivity/ListActivity/MessageActivity) —
 *  `id` is the only field common to every branch; the rest are optional since
 *  which ones are populated depends on which concrete activity type came back. */
export const activityItem = z
  .object({
    id: z.number().int(),
    type: z.string().nullish(),
    createdAt: z.number().nullish(),
    siteUrl: z.string().nullish(),
    replyCount: z.number().int().nullish(),
    likeCount: z.number().int().nullish(),
    isLiked: z.boolean().nullish(),
    text: z.string().nullish(),
    status: z.string().nullish(),
    progress: z.string().nullish(),
    message: z.string().nullish(),
    user: z.object({ id: z.number().int(), name: z.string().nullish() }).passthrough().nullish(),
    media: z
      .object({
        id: z.number().int(),
        title: z.object({ romaji: z.string().nullish(), english: z.string().nullish() }).nullish(),
      })
      .passthrough()
      .nullish(),
    recipient: z
      .object({ id: z.number().int(), name: z.string().nullish() })
      .passthrough()
      .nullish(),
    messenger: z
      .object({ id: z.number().int(), name: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const savedTextActivity = z
  .object({ id: z.number().int(), text: z.string().nullish(), siteUrl: z.string().nullish() })
  .passthrough();

const savedMessageActivity = z
  .object({ id: z.number().int(), message: z.string().nullish(), siteUrl: z.string().nullish() })
  .passthrough();

export function registerActivityTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_activity",
    {
      title: "Get an activity post",
      description:
        "Get a single AniList activity post (list update, text post, or message) by its ID, " +
        "including `replyCount`, `likeCount`, and `isLiked`.",
      inputSchema: z.object({
        id: anilistId.describe(
          "AniList activity ID — from get_user_activity, get_user_recent_activity, " +
            "search_activity, or the id returned by post_text_activity/post_message_activity.",
        ),
      }),
      outputSchema: z.object({ activity: activityItem }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) =>
      guard(async () => jsonResult({ activity: await activity.getActivity(client.ctx(), id) })),
  );

  server.registerTool(
    "get_user_activity",
    {
      title: "Get a user's activity feed",
      description:
        "List recent AniList activity posts from a specific user (list updates, text posts). " +
        "Accepts an exact AniList username directly (it's resolved to an id with one extra " +
        "internal lookup) — no need to call search_user first unless you only have a " +
        "partial/fuzzy name. Use search_activity instead if you also want to filter by activity " +
        "type (TEXT/ANIME_LIST/MANGA_LIST/MESSAGE) or browse without pinning to one user.",
      inputSchema: z.object({
        user: userIdOrName,
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25)."),
      }),
      outputSchema: z.object({
        results: z
          .object({
            pageInfo: pageInfoSchema.optional(),
            activities: z.array(activityItem).optional(),
          })
          .passthrough(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ user, page, perPage }) =>
      guard(async () =>
        jsonResult({ results: await activity.getUserActivity(client.ctx(), user, page, perPage) }),
      ),
  );

  server.registerTool(
    "post_text_activity",
    {
      title: "Post a text activity",
      description:
        "[Requires login] Post a new text-status update to the authenticated user's own " +
        "AniList profile, or update an existing one by passing its `id`.",
      inputSchema: z.object({
        text: z
          .string()
          .min(5)
          .max(10000)
          .describe("The text to post (per AniList's own schema: 5-10000 characters)."),
        id: anilistId.optional().describe("Activity ID to update instead of creating a new post."),
      }),
      outputSchema: z.object({ activity: savedTextActivity }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ text, id }) =>
      guard(async () =>
        jsonResult({ activity: await activity.postTextActivity(client.ctx(), text, id) }),
      ),
  );

  server.registerTool(
    "post_message_activity",
    {
      title: "Post a message activity",
      description:
        "[Requires login] Post a new message-style activity to another AniList user's " +
        "profile, or update an existing one by passing its `id`. Despite the name, this is " +
        "NOT a private DM — like post_text_activity, it's publicly visible on both users' " +
        "activity feeds/profiles to anyone who can view them. This is a limitation of this " +
        "tool, not AniList itself: AniList's underlying mutation does accept a `private` " +
        "argument, but this tool doesn't expose it, so every message sent through it is " +
        "public. Don't use it for anything the sender expects to stay confidential.",
      inputSchema: z.object({
        recipientId: anilistId.describe(
          "AniList numeric user ID of the message recipient (resolve a username via " +
            "search_user first).",
        ),
        message: z
          .string()
          .min(2)
          .max(10000)
          .describe("The message text to post (per AniList's own schema: 2-10000 characters)."),
        id: anilistId.optional().describe("Activity ID to update instead of creating a new post."),
      }),
      outputSchema: z.object({ activity: savedMessageActivity }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ recipientId, message, id }) =>
      guard(async () =>
        jsonResult({
          activity: await activity.postMessageActivity(client.ctx(), recipientId, message, id),
        }),
      ),
  );

  server.registerTool(
    "delete_activity",
    {
      title: "Delete an activity post",
      description:
        "[Requires login] Delete an activity post the authenticated user owns. This cannot be " +
        "undone, and calling it again on an already-deleted id errors rather than silently " +
        "succeeding.",
      inputSchema: z.object({
        id: anilistId.describe(
          "AniList activity ID to delete — from get_user_activity, search_activity, or the id " +
            "returned by a previous post_text_activity/post_message_activity call.",
        ),
      }),
      outputSchema: z.object({ result: deleteResult }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ id }) =>
      guard(async () => jsonResult({ result: await activity.deleteActivity(client.ctx(), id) })),
  );
}
