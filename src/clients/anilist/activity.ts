import type { AniListContext } from "./context.js";
import { ACTIVITY_FRAGMENT, existsFragment } from "./fields.js";
import { assertFound } from "../../lib/errors.js";
import { resolveUserId } from "./user.js";
import { toUnixSeconds } from "./fuzzyDate.js";
import { deleteById } from "./deleteById.js";
import type { ActivityId, UserId } from "./ids.js";
import type { ActivityType } from "./enums.js";

export async function getActivity(ctx: AniListContext, id: ActivityId): Promise<unknown> {
  const query = `query($id:Int){Activity(id:$id){${ACTIVITY_FRAGMENT}}}`;
  const data = await ctx.gql.request<{ Activity: unknown }>(query, { id }, ctx.authHeader());
  return assertFound(data.Activity, `No activity found with ID ${id}.`);
}

/** Optional server-side narrowing for getUserActivity. The two dates are ISO
 *  8601 datetimes (validated as such by the tool schema); each one is
 *  converted to the unix seconds AniList's `createdAt_greater`/
 *  `createdAt_lesser` take. */
export interface UserActivityFilters {
  type?: ActivityTypeFilter;
  createdAfter?: string;
  createdBefore?: string;
}

/** One ActivityType, or several (matched as ANY of them). */
export type ActivityTypeFilter = ActivityType | readonly ActivityType[];

/** Split an ActivityTypeFilter into AniList's two arguments on the same
 *  `activities` connection: a single value goes to `type` (byte-identical to
 *  the request this sent before arrays were accepted), an array to `type_in`
 *  (confirmed live, both with and without `userId`, MEDIA_LIST included).
 *  The unused one is left undefined, so GraphQLClient strips it. */
export function activityTypeVars(type: ActivityTypeFilter | undefined): {
  type?: ActivityType;
  typeIn?: ActivityType[];
} {
  if (type === undefined) return {};
  if (typeof type === "string") return { type };
  return { typeIn: [...type] };
}

/** Both of AniList's `createdAt` bounds are strict (confirmed live: an
 *  activity created at exactly the bound's second is excluded from both
 *  `createdAt_greater` and `createdAt_lesser`), so they're rounded outward
 *  — see toUnixSeconds(). */
export function createdAtBounds(filters: UserActivityFilters): {
  createdAtGreater?: number;
  createdAtLesser?: number;
} {
  return {
    createdAtGreater: toUnixSeconds(filters.createdAfter, Math.floor),
    createdAtLesser: toUnixSeconds(filters.createdBefore, Math.ceil),
  };
}

export async function getUserActivity(
  ctx: AniListContext,
  user: UserId | string,
  page = 1,
  perPage = 10,
  filters: UserActivityFilters = {},
): Promise<unknown> {
  return fetchActivityFeed(ctx, user, page, perPage, filters, ctx.authHeader());
}

/** The one `Page.activities` query behind get_user_activity and
 *  search_activity, so a fix or a new filter lands in both at once.
 *
 *  AniList's `activities` field only accepts a numeric `userId` — there is
 *  no `userName` argument (confirmed live: "Unknown argument userName on
 *  field activities of type Page"). A numeric id doesn't error on a bad value
 *  either (see docs/api-references.md's "Page connection filtered by a parent
 *  id" section) — existsFragment() aliases the check into this same request
 *  instead of a separate round trip. A username has a genuine data
 *  dependency (its numeric id must be known before `activities(userId:...)`
 *  can be built), so it needs a separate resolution request first — left
 *  unresolved, AniList would treat `userId` as absent and silently return
 *  the *global* feed instead of erroring. No `user` at all is the global (or,
 *  with `isFollowing`, the following) feed.
 *
 *  `type`/`type_in`/`isFollowing`/`createdAt_*` are AniList's own filters on
 *  the same connection (confirmed live, combined with `userId`); absent ones
 *  are stripped from the variables, so the argument simply isn't applied. */
export async function fetchActivityFeed(
  ctx: AniListContext,
  user: UserId | string | undefined,
  page: number,
  perPage: number,
  filters: UserActivityFilters & { isFollowing?: true },
  header: Record<string, string> | undefined,
): Promise<unknown> {
  const filterVars = {
    ...activityTypeVars(filters.type),
    ...createdAtBounds(filters),
    isFollowing: filters.isFollowing,
  };
  const params =
    "$userId:Int,$page:Int,$perPage:Int,$type:ActivityType,$typeIn:[ActivityType]," +
    "$isFollowing:Boolean,$createdAtGreater:Int,$createdAtLesser:Int";
  const feedPage = `Page(page:$page,perPage:$perPage){
    pageInfo{total currentPage lastPage hasNextPage}
    activities(userId:$userId,type:$type,type_in:$typeIn,isFollowing:$isFollowing,createdAt_greater:$createdAtGreater,createdAt_lesser:$createdAtLesser,sort:ID_DESC){${ACTIVITY_FRAGMENT}}
  }`;
  if (typeof user === "number") {
    const data = await ctx.gql.request<{ exists: { id: number } | null; feed: unknown }>(
      `query(${params}){${existsFragment("User", "userId")} feed:${feedPage}}`,
      { userId: user, page, perPage, ...filterVars },
      header,
    );
    assertFound(data.exists, `No AniList user found with ID ${user}.`);
    return data.feed;
  }
  const userId = user === undefined ? undefined : await resolveUserId(ctx, user, header);
  const data = await ctx.gql.request<{ Page: unknown }>(
    `query(${params}){${feedPage}}`,
    { userId, page, perPage, ...filterVars },
    header,
  );
  return data.Page;
}

export async function postTextActivity(
  ctx: AniListContext,
  text: string,
  id?: ActivityId,
): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int,$text:String){SaveTextActivity(id:$id,text:$text){
    ... on TextActivity { id text(asHtml:false) siteUrl }
  }}`;
  const data = await ctx.gql.request<{ SaveTextActivity: unknown }>(query, { id, text }, header);
  return data.SaveTextActivity;
}

export async function postMessageActivity(
  ctx: AniListContext,
  recipientId: UserId,
  message: string,
  id?: ActivityId,
): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int,$recipientId:Int,$message:String){SaveMessageActivity(id:$id,recipientId:$recipientId,message:$message){
    ... on MessageActivity { id message(asHtml:false) siteUrl }
  }}`;
  const data = await ctx.gql.request<{ SaveMessageActivity: unknown }>(
    query,
    { id, recipientId, message },
    header,
  );
  return data.SaveMessageActivity;
}

export function deleteActivity(ctx: AniListContext, id: ActivityId): Promise<unknown> {
  return deleteById(ctx, "DeleteActivity", id, "activity");
}
