import type { AniListContext } from "./context.js";
import { USER_FIELDS, USER_DETAIL_FIELDS } from "./fields.js";

export async function getUserProfile(ctx: AniListContext, user: number | string): Promise<unknown> {
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
  return data.User;
}

export async function getUserStats(ctx: AniListContext, user: number | string): Promise<unknown> {
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
  return data.User;
}

export async function getFullUserInfo(
  ctx: AniListContext,
  user: number | string,
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
  return data.User;
}

export async function getAuthorizedUser(ctx: AniListContext): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `query{Viewer{${USER_FIELDS}${USER_DETAIL_FIELDS}}}`;
  const data = await ctx.gql.request<{ Viewer: unknown }>(query, {}, header);
  return data.Viewer;
}

export async function followUser(ctx: AniListContext, id: number): Promise<unknown> {
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
