import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as user from "../clients/anilist/user.js";
import * as activity from "../clients/anilist/activity.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { pageInfoSchema, idOnly, anilistId, userIdOrName } from "./outputSchemas.js";
import { NOTIFICATION_TYPES } from "./notification.js";

const TITLE_LANGUAGES = [
  "ROMAJI",
  "ENGLISH",
  "NATIVE",
  "ROMAJI_STYLISED",
  "ENGLISH_STYLISED",
  "NATIVE_STYLISED",
] as const;
const SCORE_FORMATS = ["POINT_100", "POINT_10_DECIMAL", "POINT_10", "POINT_5", "POINT_3"] as const;
const STAFF_NAME_LANGUAGES = ["ROMAJI_WESTERN", "ROMAJI", "NATIVE"] as const;
const MEDIA_LIST_STATUSES = [
  "CURRENT",
  "PLANNING",
  "COMPLETED",
  "DROPPED",
  "PAUSED",
  "REPEATING",
] as const;

// idOnly matches the ACTIVITY_FRAGMENT union (TextActivity/ListActivity/
// MessageActivity); only `id` is common to every branch.

const mediaListOptionsInput = z
  .object({
    sectionOrder: z.array(z.string()).optional().describe("Custom list-status section order."),
    splitCompletedSectionByFormat: z
      .boolean()
      .optional()
      .describe("Split the Completed section by format (TV/Movie/etc.)."),
    customLists: z.array(z.string()).optional().describe("Names of this account's custom lists."),
    advancedScoring: z
      .array(z.string())
      .optional()
      .describe("Advanced-scoring category names (e.g. Story, Characters, Visuals)."),
    advancedScoringEnabled: z
      .boolean()
      .optional()
      .describe("Whether advanced (per-category) scoring is enabled for this list type."),
    theme: z
      .string()
      .optional()
      .describe(
        "List-page color theme name. AniList itself marks this field experimental " +
          "('not yet fully implemented, may change without warning') — its read-back shape " +
          "(see get_user_profile/get_full_user_info/get_authorized_user/update_user's own " +
          "response) is an untyped value, not guaranteed to be the string you set.",
      ),
  })
  .optional();

const mediaListTypeOptions = z
  .object({
    sectionOrder: z.array(z.string()).nullish(),
    splitCompletedSectionByFormat: z.boolean().nullish(),
    customLists: z.array(z.string()).nullish(),
    advancedScoring: z.array(z.string()).nullish(),
    advancedScoringEnabled: z.boolean().nullish(),
    // Read side (`MediaListTypeOptions.theme`) is a deprecated, untyped
    // `Json` scalar (confirmed via introspection) — NOT the plain `String`
    // the write side takes, so it can't be modeled as `z.string()`.
    theme: z.unknown().nullish(),
  })
  .passthrough();

const notificationOptionOut = z
  .object({ type: z.string().nullish(), enabled: z.boolean().nullish() })
  .passthrough();

const listActivityOptionOut = z
  .object({ type: z.string().nullish(), disabled: z.boolean().nullish() })
  .passthrough();

/** What update_user actually changes — without echoing these back, there's
 *  no way to verify one of its calls actually took effect. `rowOrder` reads
 *  back from `mediaListOptions.rowOrder` (a sibling of `scoreFormat`, NOT
 *  nested under `animeList`/`mangaList`) — confirmed live after an earlier,
 *  wrong assumption that it wasn't exposed anywhere. */
const userOptionsFields = {
  options: z
    .object({
      titleLanguage: z.string().nullish(),
      displayAdultContent: z.boolean().nullish(),
      airingNotifications: z.boolean().nullish(),
      profileColor: z.string().nullish(),
      timezone: z.string().nullish(),
      activityMergeTime: z.number().int().nullish(),
      staffNameLanguage: z.string().nullish(),
      restrictMessagesToFollowing: z.boolean().nullish(),
      notificationOptions: z.array(notificationOptionOut).nullish(),
      disabledListActivity: z.array(listActivityOptionOut).nullish(),
    })
    .passthrough()
    .nullish(),
  mediaListOptions: z
    .object({
      scoreFormat: z.string().nullish(),
      rowOrder: z.string().nullish(),
      animeList: mediaListTypeOptions.nullish(),
      mangaList: mediaListTypeOptions.nullish(),
    })
    .passthrough()
    .nullish(),
};

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
    ...userOptionsFields,
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
    ...userOptionsFields,
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
  .object({
    id: z.number().int(),
    name: z.string().nullish(),
    about: z.string().nullish(),
    donatorBadge: z.string().nullish(),
    ...userOptionsFields,
  })
  .passthrough();

export function registerUserTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_user_profile",
    {
      title: "Get a user's profile",
      description:
        "Get an AniList user's public profile: name, about text, avatar, donator status — plus " +
        "their account settings (title/name-language preferences, notification toggles, list " +
        "display options). Confirmed live these settings are NOT viewer-gated, so they're " +
        "included for any user, not just the authenticated caller. Accepts an exact AniList " +
        "username directly — no need to call search_user first unless you only have a " +
        "partial/fuzzy name and need to look up the exact one.",
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
        "calling get_user_profile and get_user_stats separately. Like get_user_profile, this " +
        "also returns the target's account settings (notifications, list display, etc.) " +
        "regardless of who's authenticated — AniList doesn't viewer-gate those fields. Accepts " +
        "an exact AniList username directly — no need to call search_user first unless you " +
        "only have a partial/fuzzy name.",
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
        "(about text, preferred title language, adult-content visibility, score format, " +
        "notification/messaging preferences, anime/manga list options). Only set the fields " +
        "you want to change — most fields are a true partial update (see " +
        "`notificationOptions`/`disabledListActivity` below for the two confirmed exceptions). " +
        "Note: this mutation isn't atomic — confirmed live that rejecting one invalid field " +
        "(e.g. an incomplete `disabledListActivity`) can still leave OTHER fields from that " +
        "same call applied. If a call errors, re-check with get_authorized_user rather than " +
        "assuming nothing changed.",
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
        airingNotifications: z
          .boolean()
          .optional()
          .describe("Whether to notify about new episode airings for anime on your list."),
        scoreFormat: z
          .enum(SCORE_FORMATS)
          .optional()
          .describe(
            "Preferred list score format (affects how scores DISPLAY on anilist.co only — " +
              "add_list_entry/update_list_entry's `score` parameter always stays on a 0-10 " +
              "scale regardless of this setting, so no conversion is needed on your end).",
          ),
        rowOrder: z
          .string()
          .optional()
          .describe(
            "Internal list-table row ordering key — reads back from " +
              "`mediaListOptions.rowOrder` in the profile tools/this tool's own response.",
          ),
        profileColor: z.string().optional().describe("Profile accent color (name or hex)."),
        donatorBadge: z
          .string()
          .optional()
          .describe("Custom donator badge text (only takes effect on a donator account)."),
        notificationOptions: z
          .array(
            z.object({
              type: z.enum(NOTIFICATION_TYPES).describe("Notification type to configure."),
              enabled: z.boolean().optional().describe("Whether this notification type is on."),
            }),
          )
          .refine(
            (opts) => new Set(opts.map((o) => o.type)).size === NOTIFICATION_TYPES.length,
            `Must include every one of the ${NOTIFICATION_TYPES.length} notification types exactly once.`,
          )
          .optional()
          .describe(
            "ALL 20 notification types, every time — confirmed live this is a full replace, " +
              "not a partial merge: AniList silently drops every type you don't list (not just " +
              "resets it to default, removes it) with no error. Fetch the account's current " +
              "list first (get_authorized_user's `options.notificationOptions`) and resend it " +
              "in full with just your changes applied.",
          ),
        timezone: z.string().optional().describe('Display timezone (e.g. "+09:00").'),
        activityMergeTime: z
          .number()
          .int()
          .optional()
          .describe("Minutes within which consecutive list activity posts get merged into one."),
        staffNameLanguage: z
          .enum(STAFF_NAME_LANGUAGES)
          .optional()
          .describe("Preferred staff/character name display language."),
        restrictMessagesToFollowing: z
          .boolean()
          .optional()
          .describe("Only allow message activity from users you follow."),
        disabledListActivity: z
          .array(
            z.object({
              type: z.enum(MEDIA_LIST_STATUSES).describe("List status this toggle applies to."),
              disabled: z
                .boolean()
                .optional()
                .describe("Whether posting activity for this status is suppressed."),
            }),
          )
          .refine(
            (opts) => new Set(opts.map((o) => o.type)).size === MEDIA_LIST_STATUSES.length,
            `Must include every one of the ${MEDIA_LIST_STATUSES.length} list statuses exactly once — AniList rejects a partial list.`,
          )
          .optional()
          .describe(
            "ALL 6 list statuses, every time — confirmed live: AniList rejects this with a " +
              '400 error if any status is missing ("Incorrect number of disabled list activity ' +
              "options\"), it's not a partial per-status update. Fetch the current list first " +
              "(get_authorized_user's `options.disabledListActivity`) and resend it in full " +
              "with just your changes applied.",
          ),
        animeListOptions: mediaListOptionsInput.describe(
          "New anime-list display/scoring options — only the fields you set are changed " +
            "(confirmed live: this is a partial merge, unlike add_list_entry's advancedScores).",
        ),
        mangaListOptions: mediaListOptionsInput.describe(
          "New manga-list display/scoring options — same partial-merge behavior as " +
            "`animeListOptions` above.",
        ),
      }),
      outputSchema: z.object({ user: updateUserResult }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => guard(async () => jsonResult({ user: await user.updateUser(client.ctx(), args) })),
  );
}
