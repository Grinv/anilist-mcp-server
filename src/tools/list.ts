import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as list from "../clients/anilist/list.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { deleteResult, MEDIA_TYPES, fuzzyDateOut, anilistId } from "./outputSchemas.js";

const STATUSES = ["CURRENT", "PLANNING", "COMPLETED", "DROPPED", "PAUSED", "REPEATING"] as const;

const fuzzyDate = z
  .object({
    year: z.number().int().optional(),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
  })
  .describe("A partial date; omit fields you don't know (e.g. just {year: 2026}).");

const userIdOrName = z
  .union([anilistId, z.string().min(1)])
  .describe("AniList user ID, or username.");

const listEntryMediaLite = z
  .object({
    id: z.number().int(),
    idMal: z.number().int().nullish(),
    title: z.object({ romaji: z.string().nullish(), english: z.string().nullish() }).nullish(),
    episodes: z.number().int().nullish(),
    chapters: z.number().int().nullish(),
    siteUrl: z.string().nullish(),
  })
  .passthrough();

const listEntry = z
  .object({
    id: z.number().int(),
    status: z.string().nullish(),
    score: z.number().nullish(),
    progress: z.number().int().nullish(),
    progressVolumes: z.number().int().nullish(),
    repeat: z.number().int().nullish(),
    priority: z.number().int().nullish(),
    private: z.boolean().nullish(),
    notes: z.string().nullish(),
    startedAt: fuzzyDateOut.nullish(),
    completedAt: fuzzyDateOut.nullish(),
    updatedAt: z.number().nullish(),
    createdAt: z.number().nullish(),
    media: listEntryMediaLite.nullish(),
  })
  .passthrough();

const listGroup = z
  .object({
    name: z.string().nullish(),
    isCustomList: z.boolean().nullish(),
    isSplitCompletedList: z.boolean().nullish(),
    status: z.string().nullish(),
    entries: z.array(listEntry).nullish(),
  })
  .passthrough();

/** SaveMediaListEntry's own selection set — narrower than a full listEntry
 *  (no dates/notes/etc., since the mutation only asks for these fields back). */
const savedListEntry = z
  .object({
    id: z.number().int(),
    status: z.string().nullish(),
    score: z.number().nullish(),
    progress: z.number().int().nullish(),
    mediaId: z.number().int().nullish(),
  })
  .passthrough();

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
        "`hasNextChunk` and increment `chunk` to keep paging.",
      inputSchema: z.object({
        type: z.enum(MEDIA_TYPES).describe("Whether to get the anime or manga list."),
        user: userIdOrName,
        chunk: z
          .number()
          .int()
          .positive()
          .default(1)
          .describe(
            "Chunk number for pagination (AniList paginates this list by chunk, not page).",
          ),
        perChunk: z
          .number()
          .int()
          .min(1)
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
        "Only set the fields you care about — everything else is left at AniList's defaults.",
      inputSchema: z.object({
        mediaId: anilistId.describe("AniList anime/manga ID to add (from search_media)."),
        status: z
          .enum(STATUSES)
          .optional()
          .describe("List status. Defaults to PLANNING if omitted."),
        score: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe(
            "Score out of 10 (decimals allowed, e.g. 8.5), always on this scale regardless of " +
              "the account's configured scoreFormat (set via update_user) — no conversion needed.",
          ),
        progress: z.number().int().min(0).optional().describe("Episodes watched / chapters read."),
        progressVolumes: z.number().int().min(0).optional().describe("Volumes read (manga only)."),
        repeat: z.number().int().min(0).optional().describe("Number of times rewatched/reread."),
        priority: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("List priority (higher = more important)."),
        private: z.boolean().optional().describe("Hide this entry from your public list."),
        notes: z.string().optional().describe("Free-text notes for this entry."),
        startedAt: fuzzyDate.optional().describe("Date you started."),
        completedAt: fuzzyDate.optional().describe("Date you completed."),
        customLists: z
          .array(z.string())
          .optional()
          .describe("Names of custom lists to file this entry under."),
        advancedScores: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            "Per-category scores, 0-10 scale (e.g. {Story: 8, Characters: 9}) — only meaningful " +
              "if the account has advanced scoring enabled for this media's type. Anime and manga " +
              "have SEPARATELY configured category lists, so keys must match whichever list " +
              "applies to this entry. Any of that list's categories you omit here is set to 0, " +
              "not left unchanged — include every category if you don't want the others zeroed.",
          ),
      }),
      outputSchema: z.object({ entry: savedListEntry }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
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
        "add_list_entry's response). Only set the fields you want to change.",
      inputSchema: z.object({
        listEntryId: anilistId.describe("The list ENTRY id to update (not the media id)."),
        status: z.enum(STATUSES).optional().describe("New list status."),
        score: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe(
            "New score out of 10 (decimals allowed), always on this scale regardless of the " +
              "account's configured scoreFormat (set via update_user) — no conversion needed.",
          ),
        progress: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("New episodes watched / chapters read."),
        progressVolumes: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("New volumes read (manga only)."),
        repeat: z.number().int().min(0).optional().describe("New rewatch/reread count."),
        priority: z.number().int().min(0).optional().describe("New list priority."),
        private: z.boolean().optional().describe("Hide/unhide this entry from your public list."),
        notes: z.string().optional().describe("New free-text notes."),
        startedAt: fuzzyDate.optional().describe("New start date."),
        completedAt: fuzzyDate.optional().describe("New completion date."),
        customLists: z
          .array(z.string())
          .optional()
          .describe("New set of custom lists for this entry."),
        advancedScores: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            "New per-category scores, keyed the same way as add_list_entry. Unlike this tool's " +
              "other fields, this one is NOT a true partial update: any configured category you " +
              "omit is set to 0, not left at its previous value — pass every category if you're " +
              "only changing one.",
          ),
      }),
      outputSchema: z.object({ entry: savedListEntry }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
        "its list-entry ID (NOT the media id) — get it from get_user_list. This cannot be undone.",
      inputSchema: z.object({
        listEntryId: anilistId.describe("The list ENTRY id to delete (not the media id)."),
      }),
      outputSchema: z.object({ result: deleteResult }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ listEntryId }) =>
      guard(async () =>
        jsonResult({ result: await list.deleteListEntry(client.ctx(), listEntryId) }),
      ),
  );
}
