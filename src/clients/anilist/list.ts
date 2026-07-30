import type { AniListContext } from "./context.js";
import { ApiError } from "../../lib/errors.js";
import type { MediaId, ListEntryId, UserId } from "./ids.js";

export interface MediaListEntryInput {
  mediaId?: MediaId;
  listEntryId?: ListEntryId;
  status?: "CURRENT" | "PLANNING" | "COMPLETED" | "DROPPED" | "PAUSED" | "REPEATING";
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

export async function getUserList(
  ctx: AniListContext,
  type: "ANIME" | "MANGA",
  user: UserId | string,
  chunk = 1,
  perChunk = 25,
): Promise<{ lists: unknown; hasNextChunk: boolean | null }> {
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
  // context budget.
  const query = `query($userId:Int,$userName:String,$type:MediaType,$chunk:Int,$perChunk:Int){MediaListCollection(userId:$userId,userName:$userName,type:$type,chunk:$chunk,perChunk:$perChunk){
    hasNextChunk
    lists{name isCustomList isSplitCompletedList status entries{
      id status score(format:POINT_10_DECIMAL) progress progressVolumes repeat priority private notes
      hiddenFromStatusLists
      startedAt{year month day} completedAt{year month day} updatedAt createdAt
      customLists(asArray: true) advancedScores
      media{id idMal title{romaji english} episodes chapters siteUrl}
    }}
  }}`;
  // Authenticated (when available) so the caller's own private entries and
  // viewer-relative fields resolve correctly, not just what an anonymous
  // request would see.
  const data = await ctx.gql.request<{
    MediaListCollection: { lists: unknown; hasNextChunk: boolean | null };
  }>(
    query,
    byId ? { userId: user, type, chunk, perChunk } : { userName: user, type, chunk, perChunk },
    ctx.authHeader(),
  );
  return data.MediaListCollection;
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
): Promise<"ANIME" | "MANGA" | undefined> {
  if (input.mediaId !== undefined) {
    const query = `query($id:Int){Media(id:$id){type}}`;
    const data = await ctx.gql.request<{ Media: { type: "ANIME" | "MANGA" } | null }>(
      query,
      { id: input.mediaId },
      header,
      { skipCache: true },
    );
    return data.Media?.type;
  }
  const query = `query($id:Int){MediaList(id:$id){media{type}}}`;
  const data = await ctx.gql.request<{
    MediaList: { media: { type: "ANIME" | "MANGA" } | null } | null;
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
  mediaType: "ANIME" | "MANGA",
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
  const query = `mutation(
    $id:Int,$mediaId:Int,$status:MediaListStatus,$scoreRaw:Int,$progress:Int,$progressVolumes:Int,
    $repeat:Int,$priority:Int,$private:Boolean,$notes:String,$hiddenFromStatusLists:Boolean,
    $startedAt:FuzzyDateInput,$completedAt:FuzzyDateInput,
    $customLists:[String],$advancedScores:[Float]
  ){SaveMediaListEntry(
    id:$id,mediaId:$mediaId,status:$status,scoreRaw:$scoreRaw,progress:$progress,progressVolumes:$progressVolumes,
    repeat:$repeat,priority:$priority,private:$private,notes:$notes,hiddenFromStatusLists:$hiddenFromStatusLists,
    startedAt:$startedAt,completedAt:$completedAt,customLists:$customLists,advancedScores:$advancedScores
  ){id status score(format:POINT_10_DECIMAL) progress mediaId hiddenFromStatusLists}}`;
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
