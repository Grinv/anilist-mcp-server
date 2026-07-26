import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as notification from "../clients/anilist/notification.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { pageInfoSchema, idOnly } from "./outputSchemas.js";

export const NOTIFICATION_TYPES = [
  "ACTIVITY_MESSAGE",
  "ACTIVITY_REPLY",
  "FOLLOWING",
  "ACTIVITY_MENTION",
  "THREAD_COMMENT_MENTION",
  "THREAD_SUBSCRIBED",
  "THREAD_COMMENT_REPLY",
  "AIRING",
  "ACTIVITY_LIKE",
  "ACTIVITY_REPLY_LIKE",
  "THREAD_LIKE",
  "THREAD_COMMENT_LIKE",
  "ACTIVITY_REPLY_SUBSCRIBED",
  "RELATED_MEDIA_ADDITION",
  "MEDIA_DATA_CHANGE",
  "MEDIA_MERGE",
  "MEDIA_DELETION",
  "MEDIA_SUBMISSION_UPDATE",
  "STAFF_SUBMISSION_UPDATE",
  "CHARACTER_SUBMISSION_UPDATE",
] as const;

// idOnly matches the NOTIFICATION_FIELDS union (20 possible notification
// types); only `id` is common to every branch — the rest depends on `type`.

export function registerNotificationTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_notifications",
    {
      title: "Get your AniList notifications",
      description:
        "[Requires login] Get the authenticated user's AniList notifications: new episodes " +
        "airing, activity likes/replies/mentions, new followers, thread replies/likes, and " +
        "media/staff/character data-submission updates. Every item has `id`, `type` and a " +
        "human-readable `context`/`contexts` string; the rest of the fields depend on `type` " +
        "(e.g. an AIRING item includes `media`/`episode`, a FOLLOWING item includes `user`, an " +
        "ACTIVITY_MESSAGE item includes `message.message` — the actual DM text is nested one " +
        "level inside `message`).",
      inputSchema: z.object({
        type_in: z
          .array(z.enum(NOTIFICATION_TYPES))
          .optional()
          .describe("Restrict to these notification types. Omit to get every type."),
        markAsRead: z
          .boolean()
          .default(false)
          .describe(
            "Set true to also reset AniList's unread-notification badge count to 0, as a side " +
              "effect of this call (the same effect as opening the notifications page on the " +
              "site). Defaults to false so a routine check doesn't clear the badge.",
          ),
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z.number().int().min(1).max(25).default(25).describe("Results per page (max 25)."),
      }),
      outputSchema: z.object({
        results: z
          .object({
            pageInfo: pageInfoSchema.optional(),
            notifications: z.array(idOnly).optional(),
          })
          .passthrough(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ type_in, markAsRead, page, perPage }) =>
      guard(async () =>
        jsonResult({
          results: await notification.getNotifications(client.ctx(), {
            typeIn: type_in,
            resetNotificationCount: markAsRead,
            page,
            perPage,
          }),
        }),
      ),
  );
}
