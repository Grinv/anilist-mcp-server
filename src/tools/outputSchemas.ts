// Output-schema fragments shared across multiple tools/*.ts files, since they
// describe the same upstream AniList GraphQL types (PageInfo, Deleted) — kept
// in one place so a schema fix/addition doesn't have to be hand-applied
// identically across every file that happens to return that type.
import { z } from "zod";

export const pageInfoSchema = z
  .object({
    total: z
      .number()
      .int()
      .optional()
      .describe(
        "Not currently accurate (a known AniList performance limitation) — don't rely on it " +
          "to decide whether to fetch more pages.",
      ),
    perPage: z.number().int().optional(),
    currentPage: z.number().int().optional(),
    lastPage: z
      .number()
      .int()
      .optional()
      .describe(
        "Not currently accurate (a known AniList performance limitation) — use `hasNextPage` " +
          "instead to decide whether to fetch another page.",
      ),
    hasNextPage: z.boolean().optional(),
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
