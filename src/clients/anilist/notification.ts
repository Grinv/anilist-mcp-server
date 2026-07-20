import type { AniListContext } from "./context.js";
import { NOTIFICATION_FIELDS } from "./fields.js";

export interface GetNotificationsOptions {
  typeIn?: string[];
  resetNotificationCount?: boolean;
  page?: number;
  perPage?: number;
}

export async function getNotifications(
  ctx: AniListContext,
  { typeIn, resetNotificationCount, page = 1, perPage = 25 }: GetNotificationsOptions,
): Promise<unknown> {
  // The Notification query has no userId arg — it's always the authenticated
  // viewer's own notifications, so this is unconditionally auth-required.
  const header = ctx.requireAuth();
  const query = `query($page:Int,$perPage:Int,$type_in:[NotificationType],$resetNotificationCount:Boolean){
    Page(page:$page,perPage:$perPage){
      pageInfo { hasNextPage }
      notifications(type_in:$type_in,resetNotificationCount:$resetNotificationCount){${NOTIFICATION_FIELDS}}
    }
  }`;
  // Never cached: this "read" carries a real one-time side effect
  // (resetNotificationCount) and must reflect the current notification list
  // on every call, not a stale snapshot from an earlier call's cache entry.
  const data = await ctx.gql.request<{ Page: unknown }>(
    query,
    { page, perPage, type_in: typeIn, resetNotificationCount },
    header,
    { skipCache: true },
  );
  return data.Page;
}
