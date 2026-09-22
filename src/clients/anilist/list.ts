import type { AniListContext } from "./context.js";
import { ApiError } from "../../lib/errors.js";
import type { MediaId, ListEntryId, UserId } from "./ids.js";
import type { MediaType, MediaListStatus } from "./enums.js";

export interface MediaListEntryInput {
  mediaId?: MediaId;
  listEntryId?: ListEntryId;
  status?: MediaListStatus;
  /** 0-10 scale (decimals allowed) — converted internally to AniList's raw
   *  0-100 `scoreRaw`, which (unlike `score`) always means the same thing
   *  regardless of the account's configured `scoreFormat`. */
  score?: number;
  progress?: number;
  progressVolumes?: number;
  repeat?: number;
  priority?: number;
  private?: boolean;
  notes?: string;
  hiddenFromStatusLists?: boolean;
  startedAt?: { year?: number; month?: number; day?: number };
  completedAt?: { year?: number; month?: number; day?: number };
  customLists?: string[];
  /** Per-category scores on a 0-10 scale, keyed by the account's own advanced
   *  scoring category names (see docs/api-references.md). */
  advancedScores?: Record<string, number>;
}

/** Response shape per `format`. `full` is the original grouped GraphQL
 *  passthrough; `compact` is a flat, de-duplicated TSV of the six fields a
 *  sync/comparison task actually uses, which is roughly a tenth the size —
 *  measured live on a 325-entry list: 210KB of grouped JSON vs ~21KB of rows. */
export type UserListFormat = "compact" | "full";

export interface UserListOptions {
  chunk?: number;
  perChunk?: number;
  format?: UserListFormat;
  /** Server-side `status_in` filter. Omitted entirely when absent, so the
   *  default stays "every status". */
  statuses?: MediaListStatus[];
}

export type UserListResult =
  | { format: "full"; lists: unknown; hasNextChunk: boolean | null }
  | {
      format: "compact";
      count: number;
      columns: string;
      rows: string;
      hasNextChunk: boolean | null;
    };

/** Tab-separated, in the order `COMPACT_SELECTION` builds them. */
const COMPACT_COLUMNS = "entryId\tmediaId\tidMal\tstatus\tscore\tprogress\ttitle";

// `score` is pinned to POINT_10_DECIMAL here for the same reason the full
// selection pins it (see fields.ts) — unformatted, AniList returns it in the
// account's own display scoreFormat.
const COMPACT_SELECTION = `id status score(format:POINT_10_DECIMAL) progress
      media{id idMal title{romaji english}}`;

const FULL_SELECTION = `id status score(format:POINT_10_DECIMAL) progress progressVolumes repeat priority private notes
      hiddenFromStatusLists
      startedAt{year month day} completedAt{year month day} updatedAt createdAt
      customLists(asArray: true) advancedScores
      media{id idMal title{romaji english} episodes chapters siteUrl}`;

interface CompactEntry {
  id: number;
  status: string | null;
  score: number | null;
  progress: number | null;
  media: {
    id: number | null;
    idMal: number | null;
    title: { romaji: string | null; english: string | null } | null;
  } | null;
}

/** Collapses any whitespace (a title can carry a newline or a stray tab) so a
 *  row can never break the TSV it sits in. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cell(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Flattens the grouped response into unique rows. Deduplicated by entry id on
 *  purpose: AniList lists the SAME entry once per group it belongs to, so an
 *  entry filed under a custom list arrives twice (confirmed live: 325 rows for
 *  324 unique entries on a public list). The grouping itself is dropped —
 *  every row carries its own `status`, and custom-list membership is only
 *  available in `full`. */
function toCompactRows(lists: { entries: CompactEntry[] | null }[] | null): {
  count: number;
  rows: string;
} {
  const seen = new Set<number>();
  const rows: string[] = [];
  for (const group of lists ?? []) {
    for (const entry of group?.entries ?? []) {
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      const title = entry.media?.title;
      rows.push(
        [
          cell(entry.id),
          cell(entry.media?.id),
          cell(entry.media?.idMal),
          cell(entry.status),
          cell(entry.score),
          cell(entry.progress),
          oneLine(title?.english ?? title?.romaji ?? ""),
        ].join("\t"),
      );
    }
  }
  return { count: rows.length, rows: rows.join("\n") };
}

export async function getUserList(
  ctx: AniListContext,
  type: MediaType,
  user: UserId | string,
  opts: UserListOptions = {},
): Promise<UserListResult> {
  const { chunk = 1, perChunk = 25, format = "compact", statuses } = opts;
  const byId = typeof user === "number";
  // No existence check needed here — confirmed live (see docs/api-references.md's
  // "Page connection filtered by a parent id" section) that MediaListCollection
  // itself 404s the entire response for a nonexistent user, unlike
  // threadComments/activities/airingSchedules, which need the existsFragment()
  // alias trick because their underlying Page connections silently return an
  // empty-but-successful result instead.
  // AniList paginates MediaListCollection by `chunk`/`perChunk` (entry count
  // across ALL statuses), not the `page`/`perPage`-over-a-Page convention
  // used elsewhere in this API — a chunk boundary can therefore fall in the
  // middle of a status group. Unpaginated, this field returns the account's
  // entire list (up to AniList's own 11,000-entry cap) in one response,
  // which for an active account is large enough to blow a calling agent's
  // context budget — hence the modest DEFAULT `perChunk` here and in the
  // tool schema. There is deliberately no maximum: AniList imposes none
  // (confirmed live at `perChunk: 5000`), so a caller that knowingly wants
  // a whole list in one call can ask for it.
  // `status_in` is AniList's own server-side filter (confirmed live: it
  // narrows the entries AND still returns the custom-list groups whose
  // entries match), so a status-scoped read never pays for the rest of the
  // list. `undefined` is stripped from variables before sending, so omitting
  // it means "every status" rather than "none".
  // Compact skips the group metadata entirely — toCompactRows() discards it,
  // so there's no reason to pay for it upstream either.
  const groupFields = format === "compact" ? "" : "name isCustomList isSplitCompletedList status ";
  const selection = format === "compact" ? COMPACT_SELECTION : FULL_SELECTION;
  const query = `query($userId:Int,$userName:String,$type:MediaType,$chunk:Int,$perChunk:Int,$statusIn:[MediaListStatus]){MediaListCollection(userId:$userId,userName:$userName,type:$type,chunk:$chunk,perChunk:$perChunk,status_in:$statusIn){
    hasNextChunk
    lists{${groupFields}entries{
      ${selection}
    }}
  }}`;
  const variables = {
    ...(byId ? { userId: user } : { userName: user }),
    type,
    chunk,
    perChunk,
    statusIn: statuses,
  };
  // Authenticated (when available) so the caller's own private entries and
  // viewer-relative fields resolve correctly, not just what an anonymous
  // request would see.
  const data = await ctx.gql.request<{
    MediaListCollection: {
      lists: { entries: CompactEntry[] | null }[] | null;
      hasNextChunk: boolean | null;
    };
  }>(query, variables, ctx.authHeader());
  const { lists, hasNextChunk } = data.MediaListCollection;
  if (format === "full") return { format: "full", lists, hasNextChunk };
  return { format: "compact", ...toCompactRows(lists), columns: COMPACT_COLUMNS, hasNextChunk };
}

/** Both anime- and manga-list advanced scoring categories, in the account's
 *  own configured order, plus whether the feature is actually enabled for
 *  each list. Confirmed live: `advancedScoring` can be a non-empty category
 *  list even when `advancedScoringEnabled` is `false` (disabling the feature
 *  on the site doesn't clear a previously-configured category list) — so
 *  the enabled flag must be checked explicitly; a non-empty category array
 *  is NOT itself proof the feature is on. Only fetched when the caller
 *  actually supplies advancedScores. Bypasses the read cache: a stale
 *  category order here would silently misfile a score into the wrong
 *  category with no error, which is exactly what this whole
 *  positional-ordering feature exists to prevent. */
async function getAdvancedScoringCategories(
  ctx: AniListContext,
  header: Record<string, string>,
): Promise<{ anime: string[]; manga: string[]; animeEnabled: boolean; mangaEnabled: boolean }> {
  const query = `query{Viewer{mediaListOptions{
    animeList{advancedScoring advancedScoringEnabled}
    mangaList{advancedScoring advancedScoringEnabled}
  }}}`;
  const data = await ctx.gql.request<{
    Viewer: {
      mediaListOptions: {
        animeList: { advancedScoring: string[] | null; advancedScoringEnabled: boolean | null };
        mangaList: { advancedScoring: string[] | null; advancedScoringEnabled: boolean | null };
      };
    };
  }>(query, {}, header, { skipCache: true });
  return {
    anime: data.Viewer.mediaListOptions.animeList.advancedScoring ?? [],
    manga: data.Viewer.mediaListOptions.mangaList.advancedScoring ?? [],
    animeEnabled: data.Viewer.mediaListOptions.animeList.advancedScoringEnabled ?? false,
    mangaEnabled: data.Viewer.mediaListOptions.mangaList.advancedScoringEnabled ?? false,
  };
}

/** The actual ANIME/MANGA type of the entry being saved — looked up from
 *  `mediaId` (add path) or `listEntryId` (update path) rather than guessed,
 *  since accounts can configure overlapping category names for both lists
 *  and guessing from the advancedScores keys alone can silently pick the
 *  wrong one. Bypasses the cache for the same staleness reason as
 *  getAdvancedScoringCategories. */
async function resolveMediaType(
  ctx: AniListContext,
  header: Record<string, string>,
  input: MediaListEntryInput,
): Promise<MediaType | undefined> {
  if (input.mediaId !== undefined) {
    const query = `query($id:Int){Media(id:$id){type}}`;
    const data = await ctx.gql.request<{ Media: { type: MediaType } | null }>(
      query,
      { id: input.mediaId },
      header,
      { skipCache: true },
    );
    return data.Media?.type;
  }
  const query = `query($id:Int){MediaList(id:$id){media{type}}}`;
  const data = await ctx.gql.request<{
    MediaList: { media: { type: MediaType } | null } | null;
  }>(query, { id: input.listEntryId }, header, { skipCache: true });
  return data.MediaList?.media?.type;
}

/** Converts a `{category: 0-10 score}` map into AniList's positional
 *  `[Float]` argument, ordered per the account's advanced-scoring categories
 *  for the entry's actual media type. Throws if a key doesn't match that
 *  list, so a category-name mismatch surfaces as an error instead of
 *  silently landing on the wrong category. */
function orderAdvancedScores(
  advancedScores: Record<string, number>,
  mediaType: MediaType,
  categoryLists: { anime: string[]; manga: string[]; animeEnabled: boolean; mangaEnabled: boolean },
): number[] {
  const isManga = mediaType === "MANGA";
  const categories = isManga ? categoryLists.manga : categoryLists.anime;
  const enabled = isManga ? categoryLists.mangaEnabled : categoryLists.animeEnabled;
  // Checked separately from `categories.length` — confirmed live that a
  // previously-configured category list survives turning the feature off,
  // so a non-empty list is not itself proof advanced scoring is enabled.
  if (!enabled) {
    throw new ApiError({
      code: "bad_request",
      message: `Advanced scoring isn't enabled for ${isManga ? "manga" : "anime"} on this account.`,
    });
  }
  const keys = Object.keys(advancedScores);
  const unknown = keys.filter((k) => !categories.includes(k));
  if (unknown.length) {
    throw new ApiError({
      code: "bad_request",
      message:
        `advancedScores keys (${unknown.join(", ")}) don't match this account's configured ` +
        `advanced scoring categories for ${isManga ? "manga" : "anime"}: ${categories.join(", ")}.`,
    });
  }
  // AniList's advancedScores is also a raw 0-100-per-category scale.
  return categories.map((cat) => Math.round((advancedScores[cat] ?? 0) * 10));
}

export async function saveListEntry(
  ctx: AniListContext,
  input: MediaListEntryInput,
): Promise<unknown> {
  const header = ctx.requireAuth();
  let advancedScores: number[] | undefined;
  if (input.advancedScores) {
    const [categoryLists, mediaType] = await Promise.all([
      getAdvancedScoringCategories(ctx, header),
      resolveMediaType(ctx, header, input),
    ]);
    if (!mediaType) {
      throw new ApiError({
        code: "bad_request",
        message:
          "Could not determine whether this entry is anime or manga, needed to order " +
          "advancedScores against the right category list.",
      });
    }
    advancedScores = orderAdvancedScores(input.advancedScores, mediaType, categoryLists);
  }
  // Two selection sets, chosen by what the caller actually sent. The full one
  // exists so a caller can verify what landed without a follow-up read, and
  // that only matters for the fields AniList does NOT store verbatim:
  // `advancedScores` zeroes omitted categories and `customLists` replaces
  // rather than merges. When neither was sent, echoing them back (plus
  // `notes`, which can run to 6000 characters the caller just supplied) is
  // pure cost on every single write — and a list sync is hundreds of writes.
  // Everything still echoed is a field AniList either stores verbatim or
  // fills in itself (`startedAt` is auto-set on a new CURRENT entry), so the
  // trimmed response is still enough to confirm the write.
  const echoesStoredShape = input.customLists !== undefined || input.advancedScores !== undefined;
  const selection = echoesStoredShape
    ? `id status score(format:POINT_10_DECIMAL) progress progressVolumes repeat priority private notes
    hiddenFromStatusLists mediaId
    startedAt{year month day} completedAt{year month day} updatedAt createdAt
    customLists(asArray: true) advancedScores`
    : `id mediaId status score(format:POINT_10_DECIMAL) progress progressVolumes repeat priority
    private hiddenFromStatusLists startedAt{year month day} completedAt{year month day}`;
  const query = `mutation(
    $id:Int,$mediaId:Int,$status:MediaListStatus,$scoreRaw:Int,$progress:Int,$progressVolumes:Int,
    $repeat:Int,$priority:Int,$private:Boolean,$notes:String,$hiddenFromStatusLists:Boolean,
    $startedAt:FuzzyDateInput,$completedAt:FuzzyDateInput,
    $customLists:[String],$advancedScores:[Float]
  ){SaveMediaListEntry(
    id:$id,mediaId:$mediaId,status:$status,scoreRaw:$scoreRaw,progress:$progress,progressVolumes:$progressVolumes,
    repeat:$repeat,priority:$priority,private:$private,notes:$notes,hiddenFromStatusLists:$hiddenFromStatusLists,
    startedAt:$startedAt,completedAt:$completedAt,customLists:$customLists,advancedScores:$advancedScores
  ){
    ${selection}
  }}`;
  const data = await ctx.gql.request<{ SaveMediaListEntry: unknown }>(
    query,
    {
      id: input.listEntryId,
      mediaId: input.mediaId,
      status: input.status,
      // 0-10 -> AniList's raw 0-100 scale, which — unlike `score` — always
      // means the same thing regardless of the account's scoreFormat.
      scoreRaw: input.score === undefined ? undefined : Math.round(input.score * 10),
      progress: input.progress,
      progressVolumes: input.progressVolumes,
      repeat: input.repeat,
      priority: input.priority,
      private: input.private,
      notes: input.notes,
      hiddenFromStatusLists: input.hiddenFromStatusLists,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      customLists: input.customLists,
      advancedScores,
    },
    header,
  );
  return data.SaveMediaListEntry;
}

/** Every value `UpdateMediaListEntries` can set on a whole batch at once.
 *  Deliberately excludes `advancedScores`, which AniList's own mutation does
 *  accept: it zeroes every category the caller didn't list, and doing that
 *  silently across dozens of entries in one call is data loss, not a bulk
 *  edit. `customLists` isn't here because AniList's bulk mutation has no such
 *  argument at all — which is why a batch can't disturb custom-list
 *  membership (confirmed live: a 31-entry custom list was byte-identical
 *  before and after a bulk update of three of its members). */
export interface BulkListEntryValues {
  status?: MediaListStatus;
  /** 0-10 scale, converted to AniList's raw 0-100 `scoreRaw` exactly as
   *  saveListEntry does. */
  score?: number;
  progress?: number;
  progressVolumes?: number;
  repeat?: number;
  priority?: number;
  private?: boolean;
  notes?: string;
  hiddenFromStatusLists?: boolean;
  startedAt?: { year?: number; month?: number; day?: number };
  completedAt?: { year?: number; month?: number; day?: number };
}

/** Applies ONE set of values to many list entries in a single request, via
 *  AniList's own `UpdateMediaListEntries` ("Update multiple media list
 *  entries to the same values", per its schema description).
 *
 *  Confirmed live against a real account:
 *  - `ids` are list-ENTRY ids, not media ids (passing entry 581991087
 *    updated that entry and echoed back its `mediaId` 1887).
 *  - The call is atomic on validation: a single unknown id fails the whole
 *    request with `400 validation {ids: ["The selected ids is invalid."]}`
 *    and applies NOTHING — a real entry batched alongside a bad id was
 *    verified unchanged afterwards. So there is no partial-batch state to
 *    reconcile, and no need to report per-entry outcomes.
 *  - The 400 does not say WHICH id was rejected, only that one was. */
export async function updateListEntries(
  ctx: AniListContext,
  listEntryIds: ListEntryId[],
  values: BulkListEntryValues,
): Promise<{ updated: number; listEntryIds: number[] }> {
  const header = ctx.requireAuth();
  // An ids-only call would still be a write (AniList has no "change nothing"
  // semantics to rely on), so refuse it here rather than touching every
  // named entry for no reason.
  if (Object.values(values).every((value) => value === undefined)) {
    throw new ApiError({
      code: "bad_request",
      message:
        "No values to apply — set at least one of status, score, progress, progressVolumes, " +
        "repeat, priority, private, notes, hiddenFromStatusLists, startedAt or completedAt.",
    });
  }
  // Only `id` is selected: the caller gets a summary, not an echo. AniList
  // returns [MediaList], which at the full per-entry shape would be ~451
  // bytes times the batch size — the exact cost this tool exists to avoid.
  const query = `mutation(
    $ids:[Int],$status:MediaListStatus,$scoreRaw:Int,$progress:Int,$progressVolumes:Int,
    $repeat:Int,$priority:Int,$private:Boolean,$notes:String,$hiddenFromStatusLists:Boolean,
    $startedAt:FuzzyDateInput,$completedAt:FuzzyDateInput
  ){UpdateMediaListEntries(
    ids:$ids,status:$status,scoreRaw:$scoreRaw,progress:$progress,progressVolumes:$progressVolumes,
    repeat:$repeat,priority:$priority,private:$private,notes:$notes,
    hiddenFromStatusLists:$hiddenFromStatusLists,startedAt:$startedAt,completedAt:$completedAt
  ){id}}`;
  const data = await ctx.gql.request<{ UpdateMediaListEntries: { id: number }[] | null }>(
    query,
    {
      ids: listEntryIds,
      status: values.status,
      scoreRaw: values.score === undefined ? undefined : Math.round(values.score * 10),
      progress: values.progress,
      progressVolumes: values.progressVolumes,
      repeat: values.repeat,
      priority: values.priority,
      private: values.private,
      notes: values.notes,
      hiddenFromStatusLists: values.hiddenFromStatusLists,
      startedAt: values.startedAt,
      completedAt: values.completedAt,
    },
    header,
  );
  const updated = data.UpdateMediaListEntries ?? [];
  return { updated: updated.length, listEntryIds: updated.map((entry) => entry.id) };
}

export async function deleteListEntry(
  ctx: AniListContext,
  listEntryId: ListEntryId,
): Promise<unknown> {
  const header = ctx.requireAuth();
  const query = `mutation($id:Int){DeleteMediaListEntry(id:$id){deleted}}`;
  const data = await ctx.gql.request<{ DeleteMediaListEntry: { deleted?: boolean } | null }>(
    query,
    { id: listEntryId },
    header,
  );
  // AniList can return 200 with `{deleted: false}` (e.g. already gone, or not
  // owned by the caller) instead of a GraphQL error — surface that as a real
  // failure rather than reporting success for a no-op deletion.
  if (!data.DeleteMediaListEntry?.deleted) {
    throw new ApiError({
      code: "not_found",
      message:
        "AniList reported this list entry as not deleted — it may not exist or you may not own it.",
    });
  }
  return data.DeleteMediaListEntry;
}
