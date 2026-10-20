/** AniList's `FuzzyDateInt` scalar is a single Int in `YyyyMmDd` form (e.g.
 *  `20140204`), distinct from `FuzzyDateInput` (the `{year,month,day}` object
 *  the list-entry mutations take) — the range-filter args (Media's
 *  `startDate_greater` etc., MediaListCollection's `completedAt_greater`
 *  etc.) take this form. Missing month/day become `0`, matching AniList's
 *  own convention for a partial date. Returns undefined for a wholly-empty
 *  input (stripped by GraphQLClient rather than sent as a meaningless 0). */
export function encodeFuzzyDateInt(date?: {
  year?: number;
  month?: number;
  day?: number;
}): number | undefined {
  if (!date || date.year === undefined) return undefined;
  return date.year * 10000 + (date.month ?? 0) * 100 + (date.day ?? 0);
}
