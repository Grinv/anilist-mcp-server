import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as user from "../clients/anilist/user.js";
import * as activity from "../clients/anilist/activity.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import {
  pageInfoSchema,
  anilistId,
  userId,
  userIdOrName,
  MEDIA_LIST_STATUSES,
} from "./outputSchemas.js";
import { NOTIFICATION_TYPES } from "./notification.js";
import { activityItem } from "./activity.js";

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

const mediaListOptionsInput = z
  .object({
    sectionOrder: z.array(z.string()).optional().describe("Custom list-status section order."),
    splitCompletedSectionByFormat: z
      .boolean()
      .optional()
      .describe("Split the Completed section by format (TV/Movie/etc.)."),
    customLists: z
      .array(z.string())
      .optional()
      .describe(
        "Names of this account's custom lists — REPLACES the entire array, not merged " +
          "by name: any existing list name you omit here is silently deleted (confirmed " +
          "live), even though sibling fields like advancedScoring/sectionOrder and the " +
          "other list type (mangaList) are left untouched. Fetch the current array first " +
          "(get_authorized_user's mediaListOptions.animeList/mangaList.customLists) and " +
          "include every name you want to keep, not just the one you're adding.",
      ),
    advancedScoring: z
      .array(z.string())
      .optional()
      .describe(
        "Advanced-scoring category names (e.g. Story, Characters, Visuals) — ordered, and " +
          "the order is load-bearing: every list entry's per-category `advancedScores` is " +
          "stored as a plain positional array, matched against THIS list at read time, not " +
          "by name. Renaming or reordering categories here silently reinterprets every " +
          "already-scored entry's stored values under the new names/positions — e.g. a " +
          "score the user gave for 'Story' can start reading as their 'Characters' score, " +
          "with no error and no way to detect it happened after the fact. Fetch the current " +
          "order first (get_authorized_user's `mediaListOptions.animeList/mangaList." +
          "advancedScoring`) so you know the existing positions before changing anything. " +
          "Only add new categories at the end, or rename in place (same position) — never " +
          "reorder an account that already has scored entries.",
      ),
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
    theme: z.json().nullish(),
  })
  .loose();

const notificationOptionOut = z
  .object({ type: z.string().nullish(), enabled: z.boolean().nullish() })
  .loose();

const listActivityOptionOut = z
  .object({ type: z.string().nullish(), disabled: z.boolean().nullish() })
  .loose();

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
      activityMergeTime: z.int().nonnegative().nullish(),
      staffNameLanguage: z.string().nullish(),
      restrictMessagesToFollowing: z.boolean().nullish(),
      notificationOptions: z.array(notificationOptionOut).nullish(),
      disabledListActivity: z.array(listActivityOptionOut).nullish(),
    })
    .loose()
    .nullish(),
  mediaListOptions: z
    .object({
      scoreFormat: z.string().nullish(),
      rowOrder: z.string().nullish(),
      animeList: mediaListTypeOptions.nullish(),
      mangaList: mediaListTypeOptions.nullish(),
    })
    .loose()
    .nullish(),
};

/** USER_FIELDS — only `id` is guaranteed; the rest is nullable/absent
 *  depending on what the account has actually set. */
const userProfileObject = z
  .object({
    id: anilistId,
    name: z.string().nullish(),
    about: z.string().nullish(),
    avatar: z.object({ large: z.httpUrl().nullish() }).nullish(),
    bannerImage: z.httpUrl().nullish(),
    siteUrl: z.httpUrl().nullish(),
    donatorTier: z.int().nonnegative().nullish(),
    donatorBadge: z.string().nullish(),
    isFollowing: z.boolean().nullish(),
    isFollower: z.boolean().nullish(),
    ...userOptionsFields,
  })
  .loose();

const animeStats = z
  .object({
    count: z.int().nonnegative().nullish(),
    meanScore: z.number().nonnegative().nullish(),
    minutesWatched: z.int().nonnegative().nullish(),
    episodesWatched: z.int().nonnegative().nullish(),
  })
  .loose();

const mangaStats = z
  .object({
    count: z.int().nonnegative().nullish(),
    meanScore: z.number().nonnegative().nullish(),
    chaptersRead: z.int().nonnegative().nullish(),
    volumesRead: z.int().nonnegative().nullish(),
  })
  .loose();

const userStatsObject = z
  .object({
    statistics: z
      .object({ anime: animeStats.nullish(), manga: mangaStats.nullish() })
      .loose()
      .nullish(),
  })
  .loose();

const fullUserObject = z
  .object({
    id: anilistId,
    name: z.string().nullish(),
    about: z.string().nullish(),
    avatar: z.object({ large: z.httpUrl().nullish() }).nullish(),
    bannerImage: z.httpUrl().nullish(),
    siteUrl: z.httpUrl().nullish(),
    donatorTier: z.int().nonnegative().nullish(),
    donatorBadge: z.string().nullish(),
    isFollowing: z.boolean().nullish(),
    isFollower: z.boolean().nullish(),
    ...userOptionsFields,
    statistics: z
      .object({ anime: animeStats.nullish(), manga: mangaStats.nullish() })
      .loose()
      .nullish(),
  })
  .loose();

const followResult = z
  .object({ id: anilistId, name: z.string().nullish(), isFollowing: z.boolean().nullish() })
  .loose();

const updateUserResult = z
  .object({
    id: anilistId,
    name: z.string().nullish(),
    about: z.string().nullish(),
    donatorBadge: z.string().nullish(),
    ...userOptionsFields,
  })
  .loose();

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
        "partial/fuzzy name and need to look up the exact one. Need statistics too? Use " +
        "get_full_user_info instead of also calling get_user_stats separately.",
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
        "need to call search_user first unless you only have a partial/fuzzy name. AniList's " +
        "own stats aggregation can lag behind the account's real list — confirmed live, an " +
        "account with real scored/progressed entries still read back all-zero statistics — " +
        "so don't treat a zeroed result as 'this account has no list activity' without " +
        "cross-checking get_user_list. Need the profile too? Use get_full_user_info instead of " +
        "also calling get_user_profile separately.",
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
        "only have a partial/fuzzy name. Its embedded statistics carry the same staleness " +
        "caveat as get_user_stats: AniList's own aggregation can lag and read all-zero even " +
        "for an account with real list entries.",
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
        "Get an AniList user's 5 most recent activity posts, with full content (not just IDs) " +
        "— a fixed count, not configurable; use get_user_activity for a paginated full feed " +
        "instead. Accepts an exact AniList username directly — no need to call search_user " +
        "first unless you only have a partial/fuzzy name (username resolution costs one " +
        "extra internal lookup either way).",
      inputSchema: z.object({
        user: userIdOrName.describe(
          "AniList user ID, or username. Unlike search_activity's own `user` filter, both an " +
            "unknown numeric ID and an unknown username error here rather than silently " +
            "returning an empty feed.",
        ),
      }),
      outputSchema: z.object({
        activity: z
          .object({
            pageInfo: pageInfoSchema.optional(),
            activities: z.array(activityItem).optional(),
          })
          .loose(),
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
        "login_anilist/ANILIST_ACCESS_TOKEN — use this to confirm which account is connected. " +
        "Also the authoritative source to fetch BEFORE an update_user call touching " +
        "`options.notificationOptions`/`options.disabledListActivity` (confirmed live: full " +
        "array replace, not merge by entry) or `mediaListOptions.animeList/mangaList." +
        "customLists` (confirmed live: same full-replace behavior) — read the current values " +
        "here first and resend them in full alongside your changes. The sibling " +
        "`advancedScoring` array carries a related but distinct risk instead: it's positional, " +
        "not name-matched, so reordering/renaming its entries silently reinterprets already-" +
        "scored list entries (see update_user's own `advancedScoring` field for detail) — " +
        "fetch it here first too before changing it.",
      inputSchema: z.object({}),
      outputSchema: z.object({ user: userProfileObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => guard(async () => jsonResult({ user: await user.getAuthorizedUser(client.ctx()) })),
  );

  server.registerTool(
    "toggle_follow_user",
    {
      title: "Follow/unfollow a user",
      description:
        "[Requires login] Toggle following another AniList user from the authenticated " +
        "user's account. Calling it again on the same user unfollows them.",
      inputSchema: z.object({
        id: userId.describe(
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
        "`notificationOptions`/`disabledListActivity` below for two confirmed exceptions, " +
        "PLUS `animeListOptions`/`mangaListOptions`'s nested `customLists` — a third: that " +
        "one field's ARRAY VALUE is a full replace even though its sibling fields and the " +
        "other list type merge normally).",
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
              "`mediaListOptions.rowOrder` in the profile tools/this tool's own response. " +
              "Confirmed live: AniList validates this server-side and rejects an unrecognized " +
              'value with a clear error ("The selected row order is invalid.") rather than ' +
              "silently ignoring it — unlike `profileColor` below.",
          ),
        profileColor: z
          .string()
          .optional()
          .describe(
            "Profile accent color (name or hex). Confirmed live: AniList silently ignores an " +
              "unrecognized value instead of erroring — the account's existing color is left " +
              "unchanged, with no error surfaced and no way to detect the value was rejected " +
              "other than re-checking with get_authorized_user.",
          ),
        donatorBadge: z
          .string()
          .max(24)
          .optional()
          .describe(
            "Custom donator badge text, up to 24 characters per AniList's own schema (only " +
              "takes effect on a donator account).",
          ),
        notificationOptions: z
          .array(
            z.object({
              type: z.enum(NOTIFICATION_TYPES).describe("Notification type to configure."),
              enabled: z
                .boolean()
                .optional()
                .describe(
                  "Whether this notification type is on. Optional per entry, but not really — " +
                    "omitting it doesn't error and doesn't inherit the previous value either; " +
                    `confirmed live it's written as \`enabled: null\`, effectively unsetting the ` +
                    `type. Always pass an explicit true/false for every one of the ${NOTIFICATION_TYPES.length} types.`,
                ),
            }),
          )
          .refine(
            (opts) =>
              opts.length === NOTIFICATION_TYPES.length &&
              new Set(opts.map((o) => o.type)).size === NOTIFICATION_TYPES.length,
            `Must include every one of the ${NOTIFICATION_TYPES.length} notification types exactly once.`,
          )
          .optional()
          .describe(
            `ALL ${NOTIFICATION_TYPES.length} notification types, every time — confirmed live this is a full replace, ` +
              "not a partial merge: AniList silently drops every type you don't list (not just " +
              "resets it to default, removes it) with no error. Fetch the account's current " +
              "list first (get_authorized_user's `options.notificationOptions`) and resend it " +
              "in full with just your changes applied.",
          ),
        timezone: z
          .string()
          .regex(
            /^-?\d{2}:\d{2}$/,
            'Must be a timezone offset in AniList\'s own documented "-?HH:MM" format, e.g. ' +
              '"09:00" or "-05:00".',
          )
          .optional()
          .describe(
            'Display timezone as an offset, in AniList\'s own documented "-?HH:MM" format ' +
              '(e.g. "09:00", "-05:00"). Confirmed live that AniList validates this ' +
              'server-side and rejects a malformed value with a clear error ("The timezone ' +
              'format is invalid.") — whether a leading "+" is also accepted wasn\'t tested ' +
              "live (this tool has no way to explicitly clear timezone back to unset, so a " +
              "wrong guess here risked an unrevertable change); this regex follows AniList's " +
              "own literal grammar, which mentions only an optional leading minus.",
          ),
        activityMergeTime: z
          .int()
          .min(0)
          .optional()
          .describe(
            "Minutes within which consecutive list activity posts get merged into one. Per " +
              "AniList's own schema: 0 = never merge, 20160+ (2 weeks) = always merge.",
          ),
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
                .describe(
                  "Whether posting activity for this status is suppressed. Optional in the " +
                    "schema, but NOT safe to omit: confirmed live, leaving it out on even one " +
                    `of the ${MEDIA_LIST_STATUSES.length} statuses makes the whole call fail with a 500 Internal Server ` +
                    "Error on AniList's side (not a clean validation error, and not this " +
                    "server's bug) — always pass an explicit true/false for every status.",
                ),
            }),
          )
          .refine(
            (opts) =>
              opts.length === MEDIA_LIST_STATUSES.length &&
              new Set(opts.map((o) => o.type)).size === MEDIA_LIST_STATUSES.length,
            `Must include every one of the ${MEDIA_LIST_STATUSES.length} list statuses exactly once — AniList rejects a partial list.`,
          )
          .optional()
          .describe(
            `ALL ${MEDIA_LIST_STATUSES.length} list statuses, every time — confirmed live: AniList rejects this with a ` +
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
