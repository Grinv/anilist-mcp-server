import type { AniListContext } from "./context.js";
import { assertFound } from "../../lib/errors.js";
import type { UserId } from "./ids.js";
import { USER_FIELDS, USER_DETAIL_FIELDS } from "./fields.js";

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
  const data = await ctx.gql.request<{ User: { id: UserId } | null }>(query, { name }, header);
  return assertFound(data.User, `No AniList user named "${name}" was found.`).id;
}

export async function getUserProfile(ctx: AniListContext, user: UserId | string): Promise<unknown> {
  const byId = typeof user === "number";
  const fields = `${USER_FIELDS}${USER_DETAIL_FIELDS}`;
  const query = byId
    ? `query($id:Int){User(id:$id){${fields}}}`
    : `query($name:String){User(name:$name){${fields}}}`;
  const data = await ctx.gql.request<{ User: unknown }>(
    query,
    byId ? { id: user } : { name: user },
    ctx.authHeader(),
  );
  return assertFound(data.User, `No AniList user found matching ${JSON.stringify(user)}.`);
}

export async function getUserStats(ctx: AniListContext, user: UserId | string): Promise<unknown> {
  const byId = typeof user === "number";
  const statsFields = `statistics{anime{count meanScore minutesWatched episodesWatched}manga{count meanScore chaptersRead volumesRead}}`;
  const query = byId
    ? `query($id:Int){User(id:$id){${statsFields}}}`
    : `query($name:String){User(name:$name){${statsFields}}}`;
  const data = await ctx.gql.request<{ User: unknown }>(
    query,
    byId ? { id: user } : { name: user },
    ctx.authHeader(),
  );
  return assertFound(data.User, `No AniList user found matching ${JSON.stringify(user)}.`);
}

export async function getFullUserInfo(
  ctx: AniListContext,
  user: UserId | string,
): Promise<unknown> {
  const byId = typeof user === "number";
  const fields = `${USER_FIELDS}${USER_DETAIL_FIELDS} statistics{anime{count meanScore minutesWatched episodesWatched}manga{count meanScore chaptersRead volumesRead}}`;
  const query = byId
    ? `query($id:Int){User(id:$id){${fields}}}`
    : `query($name:String){User(name:$name){${fields}}}`;
  const data = await ctx.gql.request<{ User: unknown }>(
    query,
    byId ? { id: user } : { name: user },
    ctx.authHeader(),
  );
  return assertFound(data.User, `No AniList user found matching ${JSON.stringify(user)}.`);
}

export async function getAuthorizedUser(ctx: AniListContext): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `query{Viewer{${USER_FIELDS}${USER_DETAIL_FIELDS}}}`;
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
  type: string;
  enabled?: boolean;
}

export interface ListActivityOptionFieldInput {
  type: string;
  disabled?: boolean;
}

export interface UpdateUserFields {
  about?: string;
  titleLanguage?: string;
  displayAdultContent?: boolean;
  airingNotifications?: boolean;
  scoreFormat?: string;
  rowOrder?: string;
  profileColor?: string;
  donatorBadge?: string;
  notificationOptions?: NotificationOptionFieldInput[];
  timezone?: string;
  activityMergeTime?: number;
  staffNameLanguage?: string;
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
        animeList{sectionOrder splitCompletedSectionByFormat customLists advancedScoring advancedScoringEnabled theme}
        mangaList{sectionOrder splitCompletedSectionByFormat customLists advancedScoring advancedScoringEnabled theme}
      }
    }
  }`;
  const data = await ctx.gql.request<{ UpdateUser: unknown }>(query, { ...fields }, header);
  return data.UpdateUser;
}
