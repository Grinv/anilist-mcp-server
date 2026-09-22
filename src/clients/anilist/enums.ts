// Single source of truth for the AniList enums that appear on BOTH sides of the
// boundary: the Zod input schemas in tools/ (via `z.enum(...)`) and the domain-
// function signatures here in clients/. It lives in this layer, not tools/,
// because clients/ must never import from tools/ (the dependency only runs
// tools/ -> clients/). Deriving each TS union from the same `as const` array
// keeps the runtime validation and the compile-time signatures from drifting —
// change a value here and both the schema and every signature move together.
//
// Only enums that are genuinely re-typed in clients/ live here. Enums used
// solely inside a Zod schema (sort/format/season/source/notification/etc.) stay
// next to their tool, since z.enum already makes the `as const` array their
// single source for both validation and the inferred handler type.

/** AniList's Media `type` enum. */
export const MEDIA_TYPES = ["ANIME", "MANGA"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** AniList's `MediaListStatus` enum. */
export const MEDIA_LIST_STATUSES = [
  "CURRENT",
  "PLANNING",
  "COMPLETED",
  "DROPPED",
  "PAUSED",
  "REPEATING",
] as const;
export type MediaListStatus = (typeof MEDIA_LIST_STATUSES)[number];

/** AniList's `NotificationType`. Shared for the same reason as the three
 *  below: `update_user`'s `notificationOptions[].type` is validated by
 *  `z.enum()` in tools/ and typed in `NotificationOptionFieldInput` in
 *  clients/, so both sides must read from one array. */
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
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The three `update_user` display settings that are real AniList enums.
 *  They live here, not next to the tool, for this file's stated reason: they
 *  are re-typed on BOTH sides of the boundary — `z.enum()` in tools/user.ts
 *  and `UpdateUserFields` in clients/anilist/user.ts. Typing the client side
 *  as bare `string` (as it was) silently switched off the `z.toZod` check
 *  that keeps the tool schema and the domain interface in step. */
export const TITLE_LANGUAGES = [
  "ROMAJI",
  "ENGLISH",
  "NATIVE",
  "ROMAJI_STYLISED",
  "ENGLISH_STYLISED",
  "NATIVE_STYLISED",
] as const;
export type TitleLanguage = (typeof TITLE_LANGUAGES)[number];

export const SCORE_FORMATS = [
  "POINT_100",
  "POINT_10_DECIMAL",
  "POINT_10",
  "POINT_5",
  "POINT_3",
] as const;
export type ScoreFormat = (typeof SCORE_FORMATS)[number];

export const STAFF_NAME_LANGUAGES = ["ROMAJI_WESTERN", "ROMAJI", "NATIVE"] as const;
export type StaffNameLanguage = (typeof STAFF_NAME_LANGUAGES)[number];

/** The five categories AniList lets you favourite (toggle_favourite). */
export const FAVOURITE_KINDS = ["ANIME", "MANGA", "CHARACTER", "STAFF", "STUDIO"] as const;
export type FavouriteKind = (typeof FAVOURITE_KINDS)[number];

/** get_todays_birthdays operates on characters or staff. */
export const BIRTHDAY_KINDS = ["CHARACTER", "STAFF"] as const;
export type BirthdayKind = (typeof BIRTHDAY_KINDS)[number];
