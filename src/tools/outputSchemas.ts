// Schema fragments shared across multiple tools/*.ts files: output shapes
// that describe the same upstream AniList GraphQL types (PageInfo, Deleted),
// plus a couple of small input-side helpers (anilistId) — kept in one place
// so a schema fix/addition doesn't have to be hand-applied identically
// across every file that happens to need it.
import { z } from "zod";

/** Bound for any caller-supplied AniList numeric ID (media, user, character,
 *  staff, studio, thread, activity, recommendation, list-entry, …). AniList's
 *  GraphQL `Int` scalar is 32-bit signed, so a value outside this range
 *  always fails upstream with a raw GraphQL type-coercion error instead of a
 *  clear local validation message. Doesn't reject 0/negative values — those
 *  are still representable as `Int` and already fail cleanly upstream as
 *  "not found"; this only guards the range GraphQL can carry at all. */
export const anilistId = z.number().int().min(-2147483648).max(2147483647);

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
export const idOnly = z.object({ id: z.number().int() }).passthrough();

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
