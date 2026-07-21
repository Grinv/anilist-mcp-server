import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as user from "../clients/anilist/user.js";
import * as activity from "../clients/anilist/activity.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { pageInfoSchema, idOnly, anilistId } from "./outputSchemas.js";

const userIdOrName = z
  .union([anilistId, z.string().min(1)])
  .describe("AniList user ID, or username.");

const TITLE_LANGUAGES = ["ROMAJI", "ENGLISH", "NATIVE"] as const;
const SCORE_FORMATS = ["POINT_100", "POINT_10_DECIMAL", "POINT_10", "POINT_5", "POINT_3"] as const;

// idOnly matches the ACTIVITY_FRAGMENT union (TextActivity/ListActivity/
// MessageActivity); only `id` is common to every branch.

/** USER_FIELDS — only `id` is guaranteed; the rest is nullable/absent
 *  depending on what the account has actually set. */
const userProfileObject = z
  .object({
    id: z.number().int(),
    name: z.string().nullish(),
    about: z.string().nullish(),
    avatar: z.object({ large: z.string().nullish() }).nullish(),
    bannerImage: z.string().nullish(),
    siteUrl: z.string().nullish(),
    donatorTier: z.number().int().nullish(),
    donatorBadge: z.string().nullish(),
    isFollowing: z.boolean().nullish(),
    isFollower: z.boolean().nullish(),
  })
  .passthrough();

const animeStats = z
  .object({
    count: z.number().int().nullish(),
    meanScore: z.number().nullish(),
    minutesWatched: z.number().int().nullish(),
    episodesWatched: z.number().int().nullish(),
  })
  .passthrough();

const mangaStats = z
  .object({
    count: z.number().int().nullish(),
    meanScore: z.number().nullish(),
    chaptersRead: z.number().int().nullish(),
    volumesRead: z.number().int().nullish(),
  })
  .passthrough();

const userStatsObject = z
  .object({
    statistics: z
      .object({ anime: animeStats.nullish(), manga: mangaStats.nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const fullUserObject = z
  .object({
    id: z.number().int(),
    name: z.string().nullish(),
    about: z.string().nullish(),
    avatar: z.object({ large: z.string().nullish() }).nullish(),
    bannerImage: z.string().nullish(),
    siteUrl: z.string().nullish(),
    donatorTier: z.number().int().nullish(),
    donatorBadge: z.string().nullish(),
    isFollowing: z.boolean().nullish(),
    isFollower: z.boolean().nullish(),
    statistics: z
      .object({ anime: animeStats.nullish(), manga: mangaStats.nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const followResult = z
  .object({ id: z.number().int(), name: z.string().nullish(), isFollowing: z.boolean().nullish() })
  .passthrough();

const updateUserResult = z
  .object({ id: z.number().int(), name: z.string().nullish() })
  .passthrough();

export function registerUserTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_user_profile",
    {
      title: "Get a user's profile",
      description:
        "Get an AniList user's public profile: name, about text, avatar, donator status. Accepts " +
        "an exact AniList username directly — no need to call search_user first unless you only " +
        "have a partial/fuzzy name and need to look up the exact one.",
      inputSchema: z.object({ user: userIdOrName }),
      outputSchema: z.object({ profile: userProfileObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ user: userOrName }) =>
      guard(async () =>
        jsonResult({ profile: await user.getUserProfile(client.ctx(), userOrName) }),
      ),
  );

  server.registerTool(
    "get_user_stats",
    {
      title: "Get a user's statistics",
      description:
        "Get an AniList user's anime/manga statistics: counts, mean score, time watched, " +
        "episodes/chapters/volumes consumed. Accepts an exact AniList username directly — no " +
        "need to call search_user first unless you only have a partial/fuzzy name.",
      inputSchema: z.object({ user: userIdOrName }),
      outputSchema: z.object({ stats: userStatsObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ user: userOrName }) =>
      guard(async () => jsonResult({ stats: await user.getUserStats(client.ctx(), userOrName) })),
  );

  server.registerTool(
    "get_full_user_info",
    {
      title: "Get a user's complete profile and stats",
      description:
        "Get an AniList user's profile AND statistics in a single call — use this instead of " +
        "calling get_user_profile and get_user_stats separately. Accepts an exact AniList " +
        "username directly — no need to call search_user first unless you only have a " +
        "partial/fuzzy name.",
      inputSchema: z.object({ user: userIdOrName }),
      outputSchema: z.object({ user: fullUserObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ user: userOrName }) =>
      guard(async () => jsonResult({ user: await user.getFullUserInfo(client.ctx(), userOrName) })),
  );

  server.registerTool(
    "get_user_recent_activity",
    {
      title: "Get a user's most recent activity",
      description:
        "Get an AniList user's 5 most recent activity posts (a fixed count, not configurable; " +
        "use get_user_activity for a paginated full feed instead). Accepts an exact AniList " +
        "username directly — no need to call search_user first unless you only have a " +
        "partial/fuzzy name (username resolution costs one extra internal lookup either way).",
      inputSchema: z.object({ user: userIdOrName }),
      outputSchema: z.object({
        activity: z
          .object({
            pageInfo: pageInfoSchema.optional(),
            activities: z.array(idOnly).optional(),
          })
          .passthrough(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ user: userOrName }) =>
      guard(async () =>
        jsonResult({ activity: await activity.getUserActivity(client.ctx(), userOrName, 1, 5) }),
      ),
  );

  server.registerTool(
    "get_authorized_user",
    {
      title: "Get the logged-in user's profile",
      description:
        "[Requires login] Get the profile of the AniList account currently authorized via " +
        "login_anilist/ANILIST_ACCESS_TOKEN — use this to confirm which account is connected.",
      inputSchema: z.object({}),
      outputSchema: z.object({ user: userProfileObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => guard(async () => jsonResult({ user: await user.getAuthorizedUser(client.ctx()) })),
  );

  server.registerTool(
    "follow_user",
    {
      title: "Follow/unfollow a user",
      description:
        "[Requires login] Toggle following another AniList user from the authenticated " +
        "user's account. Calling it again on the same user unfollows them.",
      inputSchema: z.object({
        id: anilistId.describe(
          "AniList numeric user ID to follow/unfollow — this mutation has no username form; " +
            "resolve one via search_user or get_user_profile first.",
        ),
      }),
      outputSchema: z.object({ user: followResult }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ id }) => guard(async () => jsonResult({ user: await user.followUser(client.ctx(), id) })),
  );

  server.registerTool(
    "update_user",
    {
      title: "Update your AniList account settings",
      description:
        "[Requires login] Update settings on the authenticated user's own AniList account " +
        "(about text, preferred title language, adult-content visibility, score format). Only " +
        "set the fields you want to change.",
      inputSchema: z.object({
        about: z.string().optional().describe("New profile 'about' text."),
        titleLanguage: z
          .enum(TITLE_LANGUAGES)
          .optional()
          .describe("Preferred title display language."),
        displayAdultContent: z
          .boolean()
          .optional()
          .describe("Whether to show adult content in search/browse."),
        scoreFormat: z
          .enum(SCORE_FORMATS)
          .optional()
          .describe(
            "Preferred list score format (affects how scores DISPLAY on anilist.co only — " +
              "add_list_entry/update_list_entry's `score` parameter always stays on a 0-10 " +
              "scale regardless of this setting, so no conversion is needed on your end).",
          ),
      }),
      outputSchema: z.object({ user: updateUserResult }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (args) => guard(async () => jsonResult({ user: await user.updateUser(client.ctx(), args) })),
  );
}
