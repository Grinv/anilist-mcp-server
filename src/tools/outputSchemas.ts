// Schema fragments shared across multiple tools/*.ts files: output shapes
// that describe the same upstream AniList GraphQL types (PageInfo, Deleted),
// plus a couple of small input-side helpers (anilistId, paginationFields) —
// kept in one place so a schema fix/addition doesn't have to be hand-applied
// identically across every file that happens to need it.
import { z } from "zod";

/** Bound for any caller-supplied AniList numeric ID (media, user, character,
 *  staff, studio, thread, activity, recommendation, list-entry, …). AniList's
 *  GraphQL `Int` scalar is 32-bit signed, so a value outside this range
 *  always fails upstream with a raw GraphQL type-coercion error instead of a
 *  clear local validation message. Doesn't reject 0/negative values — those
 *  are still representable as `Int` and already fail cleanly upstream as
 *  "not found"; this only guards the range GraphQL can carry at all. */
export const anilistId = z.number().int().min(-2147483648).max(2147483647);

/** MCP annotations shared by every "delete this real thing by id" tool
 *  (delete_activity, delete_thread, delete_thread_comment, remove_list_entry)
 *  — not idempotent because each one's own description confirms retrying on
 *  an already-deleted id errors instead of silently succeeding a second time,
 *  so a retry-blind client can't safely treat it as a no-op repeat. */
export const deleteToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** The `page`/`perPage` pair every `Page`-based tool takes, spread into that
 *  tool's own `inputSchema` object (e.g. `z.object({ ...paginationFields(10),
 *  otherField: ... })`) — only `perPage`'s default varies per tool. Not used
 *  by `get_site_statistics`: its `perPage` describes a different cap
 *  (AniList's own, not this schema's) and needs its own wording. */
export const paginationFields = (defaultPerPage: number) => ({
  page: z.number().int().positive().default(1).describe("Page number for pagination."),
  perPage: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(defaultPerPage)
    .describe("Results per page (max 25)."),
});

/** The `isFavourite` viewer field every favouritable domain object exposes
 *  (media, character, staff, studio) — same shape, same confirmed-live
 *  read-after-write lag on AniList's own backend (docs/api-references.md's
 *  "viewer fields have a brief read-after-write lag" entry): a re-check via
 *  the matching get_* tool right after toggle_favourite can briefly still
 *  show the pre-toggle value. This server's own cache is correctly cleared;
 *  the staleness comes from AniList itself. */
export const favouriteOut = (kind: string) =>
  z
    .boolean()
    .nullish()
    .describe(
      `[Requires login] Whether this ${kind} is in the caller's favourites. Has a brief ` +
        "read-after-write lag on AniList's own backend — confirmed live, a re-check right " +
        "after toggle_favourite can briefly still show the pre-toggle value.",
    );

// AniList sometimes returns explicit `null` (not just omitting the field) for
// every one of these — confirmed live on a `threadComments` page that had
// just been emptied out (total/currentPage/lastPage all came back `null`,
// not `0`/`1`/`1`). `.nullish()` (not `.optional()`) throughout so that known
// flakiness surfaces as a `null` value instead of a hard output-validation
// failure that kills the whole tool call.
export const pageInfoSchema = z
  .object({
    total: z
      .number()
      .int()
      .nullish()
      .describe(
        "Not currently accurate (a known AniList performance limitation) — don't rely on it " +
          "to decide whether to fetch more pages.",
      ),
    perPage: z.number().int().nullish(),
    currentPage: z.number().int().nullish(),
    lastPage: z
      .number()
      .int()
      .nullish()
      .describe(
        "Not currently accurate (a known AniList performance limitation) — use `hasNextPage` " +
          "instead to decide whether to fetch another page.",
      ),
    hasNextPage: z.boolean().nullish(),
  })
  .passthrough();

export const deleteResult = z.object({ deleted: z.boolean().nullish() }).passthrough();

/** A minimal placeholder for a GraphQL union/type where only `id` is common
 *  to every branch (e.g. the ACTIVITY_FRAGMENT union) — per the precision
 *  policy, loosely typed rather than duplicating the full shape per call
 *  site. Shared so the same one-line schema isn't hand-copied per file. */
export const idOnly = z
  .object({ id: z.number().int() })
  .passthrough()
  .describe(
    "Only `id` is guaranteed here — the real object has more fields, but their shape " +
      "depends on which variant of an underlying union type this is (e.g. which activity " +
      "type), so only the field common to every variant is declared.",
  );

/** A media title as most tools echo it back — just `romaji`/`english`, not
 *  the full `native`/`userPreferred` set `get_media`'s own title needs.
 *  Always paired with `.nullish()` at the call site (the field itself, not
 *  its sub-fields, can be absent depending on what AniList has). */
export const mediaTitleOut = z.object({
  romaji: z.string().nullish(),
  english: z.string().nullish(),
});

/** A FuzzyDate in AniList's *output* shape (all fields nullable — unlike the
 *  input variant, which is a plain optional {year,month,day}). */
export const fuzzyDateOut = z
  .object({
    year: z.number().int().nullish(),
    month: z.number().int().nullish(),
    day: z.number().int().nullish(),
  })
  .passthrough();

const favouriteNodesList = z
  .object({ nodes: z.array(z.object({ id: z.number().int() }).passthrough()).nullish() })
  .passthrough();

export const toggleFavouriteResult = z
  .object({
    anime: favouriteNodesList.nullish(),
    manga: favouriteNodesList.nullish(),
    characters: favouriteNodesList.nullish(),
    staff: favouriteNodesList.nullish(),
    studios: favouriteNodesList.nullish(),
  })
  .passthrough();

/** AniList's Media `type` enum — shared by every tool that operates on either
 *  an anime or a manga through one parameterized call. */
export const MEDIA_TYPES = ["ANIME", "MANGA"] as const;

/** AniList's `MediaListStatus` enum — was independently hand-duplicated in
 *  src/tools/list.ts, src/tools/user.ts, and src/clients/anilist/list.ts;
 *  centralized so a future AniList-side change can't update one copy and
 *  silently leave the others (and whatever they gate, e.g. user.ts's
 *  "every status exactly once" refine) stale. */
export const MEDIA_LIST_STATUSES = [
  "CURRENT",
  "PLANNING",
  "COMPLETED",
  "DROPPED",
  "PAUSED",
  "REPEATING",
] as const;

/** A caller-supplied AniList user reference: either the numeric ID or an
 *  exact username. Shared across every user-scoped tool (activity/list/user
 *  domains) so the custom error message stays in one place instead of being
 *  hand-copied (and left un-customized) per file. */
export const userIdOrName = z
  .union([anilistId, z.string().min(1)], {
    // Same fix as media.ts's idsSchema: a plain string `error` fires for
    // every union-mismatch reason, so branch on `issue.input` to avoid
    // telling the caller "is required" when a wrongly-typed value WAS given.
    error: (issue) =>
      issue.input === undefined
        ? "user is required — pass an AniList numeric ID or a username string."
        : "user must be an AniList numeric ID or a username string.",
  })
  .describe("AniList user ID, or username.");
