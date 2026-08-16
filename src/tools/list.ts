import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as list from "../clients/anilist/list.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import {
  deleteResult,
  MEDIA_TYPES,
  MEDIA_LIST_STATUSES,
  fuzzyDateOut,
  anilistId,
  mediaId,
  listEntryId,
  userIdOrName,
  mediaTitleOut,
  deleteToolAnnotations,
} from "./outputSchemas.js";

const fuzzyDate = z
  .object({
    year: z.int().positive().optional(),
    month: z.int().min(1).max(12).optional(),
    day: z.int().min(1).max(31).optional(),
  })
  .describe("A partial date; omit fields you don't know (e.g. just {year: 2026}).");

// Bounds shared by add_list_entry/update_list_entry — extracted so the two
// near-duplicate schemas can't drift out of sync on a *limit* the way this
// project already shipped once (the `priority` describe-text asymmetry).
// Each call site still chains its own `.describe()`: add/update's prose for
// several of these fields differs in more than a "New " prefix (e.g.
// `status`'s CURRENT-default note only applies to add), so only the Zod
// bounds are shared here, not the full field definition. The cap numbers
// themselves are named constants, interpolated into each site's describe()
// text, so a future limit change can't silently desync the prose from the
// schema the way the raw bound alone doesn't prevent.
const REPEAT_MAX = 1000;
const PRIORITY_MAX = 255;
const NOTES_MAX = 6000;
const scoreBounds = z.number().nonnegative().max(10).optional();
const nonNegativeInt = z.int().nonnegative().optional();
const repeatBounds = z.int().nonnegative().max(REPEAT_MAX).optional();
const priorityBounds = z.int().nonnegative().max(PRIORITY_MAX).optional();
const notesBounds = z.string().max(NOTES_MAX).optional();
const advancedScoresBounds = z.record(z.string(), z.number().nonnegative().max(10)).optional();

const listEntryMediaLite = z
  .object({
    id: anilistId,
    idMal: z.int().positive().nullish(),
    title: mediaTitleOut.nullish(),
    episodes: z.int().positive().nullish(),
    chapters: z.int().positive().nullish(),
    siteUrl: z.httpUrl().nullish(),
  })
  .loose();

const listEntry = z
  .object({
    id: anilistId,
    status: z.string().nullish(),
    score: z.number().nonnegative().nullish(),
    progress: z.int().nonnegative().nullish(),
    progressVolumes: z.int().nonnegative().nullish(),
    repeat: z.int().nonnegative().nullish(),
    priority: z.int().nonnegative().nullish(),
    private: z.boolean().nullish(),
    notes: z.string().nullish(),
    hiddenFromStatusLists: z.boolean().nullish(),
    startedAt: fuzzyDateOut.nullish(),
    completedAt: fuzzyDateOut.nullish(),
    updatedAt: z.number().nonnegative().nullish(),
    createdAt: z.number().nonnegative().nullish(),
    // Requested with `asArray: true` — AniList's default shape here is an
    // untyped `Json` object keyed by every one of the account's configured
    // custom list names (`{listName: boolean}`), which isn't representable
    // as a stable schema; `asArray` gives a predictable list instead.
    customLists: z
      .array(z.object({ name: z.string().nullish(), enabled: z.boolean().nullish() }).loose())
      .nullish()
      .describe(
        "Every custom list configured on the account, with `enabled` showing whether THIS " +
          "entry is filed under it. Naming a list here (via add_list_entry/update_list_entry) " +
          "that isn't already in the account's `animeListOptions`/`mangaListOptions` " +
          "`customLists` is silently a no-op on write — the list must exist first.",
      ),
    // Same untyped `Json` situation as customLists above — the input side
    // takes a plain {category: score} map, but AniList echoes this back in
    // whatever shape it actually stores it in.
    advancedScores: z
      .json()
      .nullish()
      .describe(
        "Per-category advanced scores as AniList actually stores them — an untyped value " +
          "(the write side takes a plain {category: score} map via add_list_entry/" +
          "update_list_entry's `advancedScores`, but the echoed read-back shape isn't " +
          "guaranteed to match it).",
      ),
    media: listEntryMediaLite.nullish(),
  })
  .loose();

const listGroup = z
  .object({
    name: z.string().nullish(),
    isCustomList: z.boolean().nullish(),
    isSplitCompletedList: z.boolean().nullish(),
    status: z.string().nullish(),
    entries: z.array(listEntry).nullish(),
  })
  .loose();

/** SaveMediaListEntry's own selection set: every field add_list_entry/
 *  update_list_entry can actually set, so one call's response is enough to
 *  verify what it wrote without a follow-up read. Derived from `listEntry`
 *  rather than restated, so the two can't drift — minus its nested `media`
 *  (the mutation doesn't select it) plus the flat `mediaId` it does. */
const savedListEntry = listEntry.omit({ media: true }).extend({
  mediaId: anilistId.nullish(),
});

export function registerListTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_user_list",
    {
      title: "Get a user's anime or manga list",
      description:
        "Get a user's AniList anime or manga list, grouped by status/custom list, with each " +
        "entry's status, score, progress and dates. Works for any public/unlisted user. " +
        "Accepts an exact AniList username directly — no need to call search_user first unless " +
        "you only have a partial/fuzzy name. Paginated by `chunk`/`perChunk` (AniList's own " +
        "mechanism for this — counted across entries of ALL statuses combined, not per status), " +
        "since a large list can otherwise return thousands of entries in one response; check " +
        "`hasNextChunk` and increment `chunk` to keep paging. AniList itself caps this at the " +
        "~11,000 most recently updated unique entries — irrelevant for virtually every account, " +
        "but a hard ceiling if one is ever hit (older entries beyond it aren't retrievable " +
        "through this field at all, by any chunk).",
      inputSchema: z.object({
        type: z.enum(MEDIA_TYPES).describe("Whether to get the anime or manga list."),
        user: userIdOrName,
        chunk: z
          .int()
          .positive()
          .default(1)
          .describe(
            "Chunk number for pagination (AniList paginates this list by chunk, not page).",
          ),
        perChunk: z
          .int()
          .positive()
          .max(25)
          .default(25)
          .describe("Entries per chunk, counted across all statuses combined (max 25)."),
      }),
      outputSchema: z.object({
        lists: z.array(listGroup).nullish(),
        hasNextChunk: z.boolean().nullish(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ type, user, chunk, perChunk }) =>
      guard(async () =>
        jsonResult(await list.getUserList(client.ctx(), type, user, chunk, perChunk)),
      ),
  );

  server.registerTool(
    "add_list_entry",
    {
      title: "Add an entry to your AniList list",
      description:
        "[Requires login] Add an anime/manga to the authenticated user's own AniList list. " +
        "Use search_media first to resolve the title to its AniList media ID. " +
        "Only set the fields you care about — everything else is left at AniList's defaults " +
        "ONLY if this media isn't already on the list. AniList upserts by media ID: if an " +
        "entry for it already exists (e.g. previously dropped, with its own score/notes/" +
        "progress), calling this updates that entry in place instead — every field you don't " +
        "set here keeps its previous value, not a default. Use get_user_list first to check " +
        "for an existing entry if you need a guaranteed-fresh one. The response echoes every " +
        "field this tool can set, as AniList actually stored it — check it instead of assuming " +
        "the write landed verbatim, especially for `advancedScores` and `customLists`, which " +
        "AniList zeroes/replaces rather than merges.",
      inputSchema: z.object({
        mediaId: mediaId.describe("AniList anime/manga ID to add (from search_media)."),
        status: z
          .enum(MEDIA_LIST_STATUSES)
          .optional()
          .describe(
            "List status. If omitted on a genuinely NEW entry, AniList defaults to CURRENT " +
              "(with `startedAt` auto-set to today) — confirmed live; despite AniList's own " +
              "site UI defaulting new entries to Planning, the API itself does not. If the " +
              "media is already on the list, this default does NOT apply — omitting `status` " +
              "on an update-in-place leaves the entry's existing status untouched.",
          ),
        score: scoreBounds.describe(
          "Score out of 10 (decimals allowed, e.g. 8.5), always on this scale regardless of " +
            "the account's configured scoreFormat (set via update_user) — no conversion needed.",
        ),
        progress: nonNegativeInt.describe("Episodes watched / chapters read."),
        progressVolumes: nonNegativeInt.describe("Volumes read (manga only)."),
        repeat: repeatBounds.describe(
          `Number of times rewatched/reread (per AniList's own schema, capped at ${REPEAT_MAX}).`,
        ),
        priority: priorityBounds.describe(
          "List priority (higher = more important; per AniList's own schema, capped at " +
            `${PRIORITY_MAX}).`,
        ),
        private: z.boolean().optional().describe("Hide this entry from your public list."),
        notes: notesBounds.describe(
          `Free-text notes for this entry (per AniList's own schema, capped at ${NOTES_MAX} ` +
            "characters).",
        ),
        hiddenFromStatusLists: z
          .boolean()
          .optional()
          .describe(
            "Hide this entry from the public status-grouped list views (e.g. 'Watching') " +
              "while still counting it in statistics — distinct from `private`, which hides " +
              "the entry entirely.",
          ),
        startedAt: fuzzyDate.optional().describe("Date you started."),
        completedAt: fuzzyDate.optional().describe("Date you completed."),
        customLists: z
          .array(z.string())
          .optional()
          .describe(
            "Names of custom lists to file this entry under — REPLACES this entry's full set " +
              "of enabled lists, not merged: naming only a subset silently turns OFF every " +
              "other list this entry was previously filed under (confirmed live), it doesn't " +
              "leave them alone. Include every list name you want this entry to stay tagged " +
              "with, not just the one you're adding. Also, the list must already exist on the " +
              "account (update_user's `animeListOptions`/`mangaListOptions` `customLists`) — " +
              "naming one that doesn't exist yet is silently a no-op, not an error.",
          ),
        advancedScores: advancedScoresBounds.describe(
          "Per-category scores, 0-10 scale (e.g. {Story: 8, Characters: 9}) — errors if " +
            "advanced scoring isn't enabled for this media's type, or if a key doesn't match " +
            "the account's configured category list for it (anime and manga have SEPARATELY " +
            "configured lists). Any of that list's categories you omit here is set to 0, " +
            "not left unchanged — include every category if you don't want the others zeroed. " +
            "Stored positionally, not by name: matched against the account's category order " +
            "(update_user's `advancedScoring`) at READ time, not write time — if that order is " +
            "later renamed/reordered, a score you write for 'Story' today can silently be read " +
            "back as 'Characters' tomorrow, with no error.",
        ),
      }),
      outputSchema: z.object({ entry: savedListEntry }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) =>
      guard(async () => jsonResult({ entry: await list.saveListEntry(client.ctx(), args) })),
  );

  server.registerTool(
    "update_list_entry",
    {
      title: "Update an entry on your AniList list",
      description:
        "[Requires login] Update an existing entry on the authenticated user's own AniList " +
        "list by its list-entry ID (NOT the media ID — get it from get_user_list, or from " +
        "add_list_entry's response). Only set the fields you want to change. The response " +
        "echoes every field this tool can set, as AniList actually stored it — check it " +
        "instead of assuming the write landed verbatim, especially for `advancedScores` and " +
        "`customLists`, which AniList zeroes/replaces rather than merges.",
      inputSchema: z.object({
        listEntryId: listEntryId.describe("The list ENTRY id to update (not the media id)."),
        status: z.enum(MEDIA_LIST_STATUSES).optional().describe("New list status."),
        score: scoreBounds.describe(
          "New score out of 10 (decimals allowed), always on this scale regardless of the " +
            "account's configured scoreFormat (set via update_user) — no conversion needed.",
        ),
        progress: nonNegativeInt.describe("New episodes watched / chapters read."),
        progressVolumes: nonNegativeInt.describe("New volumes read (manga only)."),
        repeat: repeatBounds.describe(
          `New rewatch/reread count (per AniList's own schema, capped at ${REPEAT_MAX}).`,
        ),
        priority: priorityBounds.describe(
          "New list priority (higher = more important; per AniList's own schema, capped at " +
            `${PRIORITY_MAX}).`,
        ),
        private: z.boolean().optional().describe("Hide/unhide this entry from your public list."),
        notes: notesBounds.describe(
          `New free-text notes (per AniList's own schema, capped at ${NOTES_MAX} characters).`,
        ),
        hiddenFromStatusLists: z
          .boolean()
          .optional()
          .describe(
            "Hide/unhide this entry from the public status-grouped list views (e.g. 'Watching') " +
              "while still counting it in statistics — distinct from `private`, which hides the " +
              "entry entirely.",
          ),
        startedAt: fuzzyDate.optional().describe("New start date."),
        completedAt: fuzzyDate.optional().describe("New completion date."),
        customLists: z
          .array(z.string())
          .optional()
          .describe(
            "New set of custom lists for this entry — REPLACES this entry's full set of " +
              "enabled lists, not merged: naming only a subset silently turns OFF every other " +
              "list this entry was previously filed under (confirmed live for add_list_entry's " +
              "identical field; this tool writes the same underlying value), it doesn't leave " +
              "them alone. Include every list name you want this entry to stay tagged with, not " +
              "just the one you're changing. Also, the list must already exist on the account " +
              "(update_user's `animeListOptions`/`mangaListOptions` `customLists`) — naming one " +
              "that doesn't exist yet is silently a no-op, not an error.",
          ),
        advancedScores: advancedScoresBounds.describe(
          "New per-category scores, keyed and error-checked the same way as add_list_entry " +
            "(errors if advanced scoring is disabled, or a key doesn't match a configured " +
            "category). Unlike this tool's other fields, this one is NOT a true partial " +
            "update: any configured category you omit is set to 0, not left at its previous " +
            "value — pass every category if you're only changing one. Also stored " +
            "positionally, not by name — same read-time reinterpretation risk as " +
            "add_list_entry's `advancedScores` if the account's category order " +
            "(update_user's `advancedScoring`) is later renamed/reordered.",
        ),
      }),
      outputSchema: z.object({ entry: savedListEntry }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ listEntryId, ...rest }) =>
      guard(async () =>
        jsonResult({ entry: await list.saveListEntry(client.ctx(), { listEntryId, ...rest }) }),
      ),
  );

  server.registerTool(
    "remove_list_entry",
    {
      title: "Remove an entry from your AniList list",
      description:
        "[Requires login] Delete an entry from the authenticated user's own AniList list by " +
        "its list-entry ID (NOT the media id) — get it from get_user_list. This cannot be " +
        "undone, and calling it again on an already-deleted id errors rather than silently " +
        "succeeding.",
      inputSchema: z.object({
        listEntryId: listEntryId.describe("The list ENTRY id to delete (not the media id)."),
      }),
      outputSchema: z.object({ result: deleteResult }),
      annotations: deleteToolAnnotations,
    },
    ({ listEntryId }) =>
      guard(async () =>
        jsonResult({ result: await list.deleteListEntry(client.ctx(), listEntryId) }),
      ),
  );
}
