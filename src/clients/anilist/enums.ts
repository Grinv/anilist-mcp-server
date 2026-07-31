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

/** The five categories AniList lets you favourite (toggle_favourite). */
export const FAVOURITE_KINDS = ["ANIME", "MANGA", "CHARACTER", "STAFF", "STUDIO"] as const;
export type FavouriteKind = (typeof FAVOURITE_KINDS)[number];

/** get_todays_birthdays operates on characters or staff. */
export const BIRTHDAY_KINDS = ["CHARACTER", "STAFF"] as const;
export type BirthdayKind = (typeof BIRTHDAY_KINDS)[number];
