import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as activity from "../clients/anilist/activity.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import {
  pageInfoSchema,
  deleteResult,
  anilistId,
  activityId,
  userId,
  userIdOrName,
  paginationFields,
  mediaTitleOut,
  deleteToolAnnotations,
} from "./outputSchemas.js";

// Fields ACTIVITY_FRAGMENT selects identically on every branch of AniList's
// ActivityUnion (TextActivity/ListActivity/MessageActivity). `type` itself
// isn't here — each branch below declares its own literal/enum for it, since
// that's the zod discriminant.
const activityCommon = {
  id: anilistId,
  createdAt: z.number().nonnegative().nullish(),
  siteUrl: z.httpUrl().nullish(),
  replyCount: z.int().nonnegative().nullish(),
  likeCount: z.int().nonnegative().nullish(),
  isLiked: z.boolean().nullish(),
};

const activityUserRef = z.object({ id: anilistId, name: z.string().nullish() }).loose();

const textActivityItem = z
  .object({
    ...activityCommon,
    type: z.literal("TEXT"),
    text: z.string().nullish(),
    user: activityUserRef.nullish(),
  })
  .loose();

const listActivityItem = z
  .object({
    ...activityCommon,
    // AniList's ActivityType enum has a 3rd value, MEDIA_LIST — not observed
    // live (a spot-check of both the newest and the very first activities on
    // AniList found only ANIME_LIST/MANGA_LIST for this branch), but included
    // since it's a real enum member the API schema documents.
    type: z.enum(["ANIME_LIST", "MANGA_LIST", "MEDIA_LIST"]),
    status: z.string().nullish(),
    progress: z.string().nullish(),
    user: activityUserRef.nullish(),
    media: z
      .object({
        id: anilistId,
        title: mediaTitleOut.nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

const messageActivityItem = z
  .object({
    ...activityCommon,
    type: z.literal("MESSAGE"),
    message: z.string().nullish(),
    recipient: activityUserRef.nullish(),
    messenger: activityUserRef.nullish(),
  })
  .loose();

/** Matches the ACTIVITY_FRAGMENT union (TextActivity/ListActivity/MessageActivity),
 *  modeled as a discriminated union on `type` instead of one flat object with
 *  every branch's fields optional — confirmed live (oldest and newest
 *  activities alike) that `type` is always present: GraphQL can't resolve an
 *  `... on X` fragment without already knowing the concrete type, so an
 *  activity missing it isn't a realistic case this needs to tolerate. */
export const activityItem = z.discriminatedUnion("type", [
  textActivityItem,
  listActivityItem,
  messageActivityItem,
]);

const savedTextActivity = z
  .object({ id: anilistId, text: z.string().nullish(), siteUrl: z.httpUrl().nullish() })
  .loose();

const savedMessageActivity = z
  .object({ id: anilistId, message: z.string().nullish(), siteUrl: z.httpUrl().nullish() })
  .loose();

export function registerActivityTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_activity",
    {
      title: "Get an activity post",
      description:
        "Get a single AniList activity post (list update, text post, or message) by its ID, " +
        "including `replyCount`, `likeCount`, and `isLiked`.",
      inputSchema: z.object({
        id: activityId.describe(
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
        "List recent AniList activity posts from a specific user — every activity type " +
        "(list updates, text posts, and message activity they received), the underlying query " +
        "applies no type filter of its own. Accepts an exact AniList username directly " +
        "(it's resolved to an id with one extra internal lookup) — no need to call search_user " +
        "first unless you only have a partial/fuzzy name. Use search_activity instead if you " +
        "want to restrict to one activity type (TEXT/ANIME_LIST/MANGA_LIST/MEDIA_LIST/MESSAGE) " +
        "or browse without pinning to one user. Use get_user_recent_activity instead if you " +
        "just want a quick, fixed-size (5-item) recent snapshot without paginating.",
      inputSchema: z.object({
        user: userIdOrName.describe(
          "AniList user ID, or username. Unlike search_activity's own `user` filter, both an " +
            "unknown numeric ID and an unknown username error here rather than silently " +
            "returning an empty feed.",
        ),
        ...paginationFields(10),
      }),
      outputSchema: z.object({
        results: z
          .object({
            pageInfo: pageInfoSchema.optional(),
            activities: z.array(activityItem).optional(),
          })
          .loose(),
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
        id: activityId.optional().describe("Activity ID to update instead of creating a new post."),
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
        recipientId: userId.describe(
          "AniList numeric user ID of the message recipient (resolve a username via " +
            "search_user first).",
        ),
        message: z
          .string()
          .min(2)
          .max(10000)
          .describe("The message text to post (per AniList's own schema: 2-10000 characters)."),
        id: activityId.optional().describe("Activity ID to update instead of creating a new post."),
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
        id: activityId.describe(
          "AniList activity ID to delete — from get_user_activity, get_user_recent_activity, " +
            "search_activity, or the id returned by a previous " +
            "post_text_activity/post_message_activity call.",
        ),
      }),
      outputSchema: z.object({ result: deleteResult }),
      annotations: deleteToolAnnotations,
    },
    ({ id }) =>
      guard(async () => jsonResult({ result: await activity.deleteActivity(client.ctx(), id) })),
  );
}
