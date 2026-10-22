import type { AniListContext } from "./context.ts";
import type {
  TitleLanguage,
  ScoreFormat,
  StaffNameLanguage,
  NotificationType,
  MediaListStatus,
} from "./enums.ts";
import { ApiError, assertFound } from "../../lib/errors.ts";
import type { UserId } from "./ids.ts";
import { USER_FIELDS, USER_DESCRIPTION_FIELD, USER_DETAIL_FIELDS } from "./fields.ts";

/** Resolves a username to its numeric AniList UserId — shared by
 *  activity.ts's getUserActivity and search.ts's searchActivity, which both
 *  need this resolved to numeric before building their query: AniList's
 *  `activities`/`userId` filter is numeric-only, unlike most other
 *  user-scoped fields in this API (confirmed live: "Unknown argument
 *  userName on field activities of type Page" — see docs/api-references.md). */
export async function resolveUserId(
  ctx: AniListContext,
  name: string,
  header: Record<string, string> | undefined,
): Promise<UserId> {
  const query = `query($name:String){User(name:$name){id}}`;
  return withNumericNameHint(name, async () => {
    const data = await ctx.gql.request<{ User: { id: UserId } | null }>(query, { name }, header);
    return assertFound(data.User, `No AniList user named "${name}" was found.`).id;
  });
}

/** A `user` given as a digit string (some MCP clients stringify numbers) is
 *  looked up as a USERNAME, not an ID — say so on a not-found instead of
 *  leaving the caller to conclude user 7640432 doesn't exist. */
export async function withNumericNameHint<T>(
  user: UserId | string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (typeof user !== "string" || !/^\d+$/.test(user)) throw err;
    if (!(err instanceof ApiError) || err.code !== "not_found") throw err;
    throw new ApiError({
      code: "not_found",
      status: err.status,
      message:
        `${err.message.replace(/[.\s]*$/, ".")} "${user}" was looked up as a username; to ` +
        `look up user ID ${user}, ` +
        "pass it as a number.",
      cause: err,
    });
  }
}

const STATS_FIELDS = `statistics{anime{count meanScore minutesWatched episodesWatched}manga{count meanScore chaptersRead volumesRead}}`;
const PROFILE_FIELDS = `${USER_FIELDS}${USER_DESCRIPTION_FIELD}${USER_DETAIL_FIELDS}`;

function fetchUser(ctx: AniListContext, user: UserId | string, fields: string): Promise<unknown> {
  const byId = typeof user === "number";
  const query = byId
    ? `query($id:Int){User(id:$id){${fields}}}`
    : `query($name:String){User(name:$name){${fields}}}`;
  return withNumericNameHint(user, async () => {
    const data = await ctx.gql.request<{ User: unknown }>(
      query,
      byId ? { id: user } : { name: user },
      ctx.authHeader(),
    );
    return assertFound(data.User, `No AniList user found matching ${JSON.stringify(user)}.`);
  });
}

export function getUserProfile(ctx: AniListContext, user: UserId | string): Promise<unknown> {
  return fetchUser(ctx, user, PROFILE_FIELDS);
}

export function getUserStats(ctx: AniListContext, user: UserId | string): Promise<unknown> {
  return fetchUser(ctx, user, STATS_FIELDS);
}

export function getFullUserInfo(ctx: AniListContext, user: UserId | string): Promise<unknown> {
  return fetchUser(ctx, user, `${PROFILE_FIELDS} ${STATS_FIELDS}`);
}

export async function getAuthorizedUser(ctx: AniListContext): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `query{Viewer{${USER_FIELDS}${USER_DESCRIPTION_FIELD}${USER_DETAIL_FIELDS}}}`;
  const data = await ctx.gql.request<{ Viewer: unknown }>(query, {}, header);
  return data.Viewer;
}

export async function followUser(ctx: AniListContext, id: UserId): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int){ToggleFollow(userId:$id){id name isFollowing}}`;
  const data = await ctx.gql.request<{ ToggleFollow: unknown }>(query, { id }, header);
  return data.ToggleFollow;
}

export interface MediaListOptionsFieldsInput {
  sectionOrder?: string[];
  splitCompletedSectionByFormat?: boolean;
  customLists?: string[];
  advancedScoring?: string[];
  advancedScoringEnabled?: boolean;
  theme?: string;
}

export interface NotificationOptionFieldInput {
  type: NotificationType;
  enabled: boolean;
}

export interface ListActivityOptionFieldInput {
  type: MediaListStatus;
  disabled: boolean;
}

export interface UpdateUserFields {
  about?: string;
  titleLanguage?: TitleLanguage;
  displayAdultContent?: boolean;
  airingNotifications?: boolean;
  scoreFormat?: ScoreFormat;
  rowOrder?: string;
  profileColor?: string;
  donatorBadge?: string;
  notificationOptions?: NotificationOptionFieldInput[];
  timezone?: string;
  activityMergeTime?: number;
  staffNameLanguage?: StaffNameLanguage;
  restrictMessagesToFollowing?: boolean;
  disabledListActivity?: ListActivityOptionFieldInput[];
  // Confirmed live: AniList's MediaListOptionsInput IS a partial merge, not
  // full-replace (unlike SaveMediaListEntry's advancedScores) — setting just
  // `customLists` here left `advancedScoring`/`sectionOrder`/`mangaList`
  // untouched.
  animeListOptions?: MediaListOptionsFieldsInput;
  mangaListOptions?: MediaListOptionsFieldsInput;
}

export async function updateUser(ctx: AniListContext, fields: UpdateUserFields): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation(
    $about:String,$titleLanguage:UserTitleLanguage,$displayAdultContent:Boolean,$airingNotifications:Boolean,
    $scoreFormat:ScoreFormat,$rowOrder:String,$profileColor:String,$donatorBadge:String,
    $notificationOptions:[NotificationOptionInput],$timezone:String,$activityMergeTime:Int,
    $staffNameLanguage:UserStaffNameLanguage,$restrictMessagesToFollowing:Boolean,
    $disabledListActivity:[ListActivityOptionInput],
    $animeListOptions:MediaListOptionsInput,$mangaListOptions:MediaListOptionsInput
  ){
    UpdateUser(
      about:$about,titleLanguage:$titleLanguage,displayAdultContent:$displayAdultContent,
      airingNotifications:$airingNotifications,scoreFormat:$scoreFormat,rowOrder:$rowOrder,
      profileColor:$profileColor,donatorBadge:$donatorBadge,notificationOptions:$notificationOptions,
      timezone:$timezone,activityMergeTime:$activityMergeTime,staffNameLanguage:$staffNameLanguage,
      restrictMessagesToFollowing:$restrictMessagesToFollowing,disabledListActivity:$disabledListActivity,
      animeListOptions:$animeListOptions,mangaListOptions:$mangaListOptions
    ){
      id name about(asHtml:false) donatorBadge
      options{
        titleLanguage displayAdultContent airingNotifications profileColor timezone
        activityMergeTime staffNameLanguage restrictMessagesToFollowing
        notificationOptions{type enabled}
        disabledListActivity{type disabled}
      }
      mediaListOptions{
        scoreFormat
        rowOrder
        animeList{sectionOrder splitCompletedSectionByFormat customLists advancedScoring advancedScoringEnabled}
        mangaList{sectionOrder splitCompletedSectionByFormat customLists advancedScoring advancedScoringEnabled}
      }
    }
  }`;
  const data = await ctx.gql.request<{ UpdateUser: unknown }>(query, { ...fields }, header);
  return data.UpdateUser;
}
