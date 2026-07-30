import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as misc from "../clients/anilist/misc.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import {
  pageInfoSchema,
  anilistId,
  studioId,
  paginationFields,
  favouriteOut,
} from "./outputSchemas.js";

const mediaTagItem = z
  .object({
    id: anilistId.optional(),
    name: z.string().optional(),
    description: z.string().nullish(),
    category: z.string().nullish(),
    isAdult: z.boolean().nullish(),
  })
  .loose();

// Confirmed live: unlike the generic pageInfoSchema caveat (accurate for
// AniList's degraded search/list connections), this field's total/lastPage
// held steady (500) and lastPage scaled correctly across different perPage
// values for the same query — so, unlike that shared caveat, they're safe to
// rely on here.
const siteStatsPageInfo = pageInfoSchema.extend({
  total: z
    .int()
    .nullish()
    .describe(
      "Total number of daily data points AniList has for this series — confirmed live " +
        "accurate for this field (unlike this schema's usual meaning elsewhere in this " +
        "server), safe to rely on.",
    ),
  lastPage: z
    .int()
    .nullish()
    .describe(
      "Final page number for the requested `perPage` size — confirmed live accurate for " +
        "this field, safe to rely on to know when you've paged through everything.",
    ),
});

const statSeries = z
  .object({
    nodes: z
      .array(
        z
          .object({
            date: z.number().nonnegative().nullish(),
            count: z.int().nonnegative().nullish(),
            change: z.int().nullish(),
          })
          .loose(),
      )
      .nullish(),
    pageInfo: siteStatsPageInfo.optional(),
  })
  .loose();

const siteStatisticsObject = z
  .object({
    users: statSeries.nullish(),
    anime: statSeries.nullish(),
    manga: statSeries.nullish(),
  })
  .loose();

/** STUDIO_FIELDS — only `id`/`name` are near-certain; everything else is
 *  nullable/absent depending on what AniList actually has for the studio. */
const studioObject = z
  .object({
    id: anilistId.optional(),
    name: z.string().optional(),
    isAnimationStudio: z.boolean().nullish(),
    isFavourite: favouriteOut("studio"),
    siteUrl: z.httpUrl().nullish(),
    media: z
      .object({
        nodes: z
          .array(
            z
              .object({
                id: anilistId.optional(),
                title: z
                  .object({ romaji: z.string().nullish(), english: z.string().nullish() })
                  .nullish(),
              })
              .loose(),
          )
          .nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export function registerMiscTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_genres",
    {
      title: "Get genres",
      description:
        "List every genre name AniList uses to tag anime/manga (e.g. Action, Comedy, Slice of " +
        "Life). Call this before filtering search_media by genre, so you pass a " +
        "name AniList actually recognizes.",
      inputSchema: z.object({}),
      outputSchema: z.object({ genres: z.array(z.string()) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => guard(async () => jsonResult({ genres: await misc.getGenres(client.ctx()) })),
  );

  const mediaTagsPageInfo = pageInfoSchema.extend({
    total: z
      .int()
      .nullish()
      .describe(
        "Exact total tag count — unlike this field's usual meaning on AniList-paginated " +
          "tools, this one IS accurate: it's computed client-side from the full ~425-tag " +
          "collection fetched in one request, not from AniList's own degraded page resolver. " +
          "Safe to rely on to know when you've paged through everything.",
      ),
    lastPage: z
      .int()
      .nullish()
      .describe(
        "Exact final page number for the requested `perPage` size (computed client-side) — " +
          "accurate here, unlike the same field on AniList-paginated tools.",
      ),
  });

  server.registerTool(
    "get_media_tags",
    {
      title: "Get media tags",
      description:
        "List every descriptive tag AniList uses on anime/manga (finer-grained than genres, " +
        "e.g. 'Time Skip', 'Tragedy', 'Reincarnation'), with category and adult-content flag. " +
        "There are ~425 tags total, so results are paginated — use `page`/`perPage` rather than " +
        "expecting them all in one response. Use this to look up a tag's exact name before " +
        "passing it to search_media's `tag_in` — tag names are case-sensitive, and an " +
        "unrecognized name doesn't error, it just silently matches nothing (confirmed live).",
      inputSchema: z.object({
        ...paginationFields(25),
      }),
      outputSchema: z.object({
        tags: z.array(mediaTagItem),
        pageInfo: mediaTagsPageInfo.optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ page, perPage }) =>
      guard(async () => jsonResult(await misc.getMediaTags(client.ctx(), page, perPage))),
  );

  server.registerTool(
    "get_site_statistics",
    {
      title: "Get AniList site statistics",
      description:
        "Get AniList's own site-wide statistics (new users/anime/manga daily counts), newest " +
        "first. Useful for questions about AniList's growth/activity, not for anime data. " +
        "Defaults to the last 7 days; use `page`/`perPage` to go further back. Confirmed live " +
        "(bypassing this tool's own 25 cap): AniList's SiteStatistics field silently caps " +
        "`perPage` at 25 itself, so this tool's own limit doesn't lose you anything.",
      inputSchema: z.object({
        page: z.int().positive().default(1).describe("Page number for pagination."),
        perPage: z
          .int()
          .min(1)
          .max(25)
          .default(7)
          .describe("Results per page/series (max 25, enforced by AniList itself)."),
      }),
      outputSchema: z.object({ statistics: siteStatisticsObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ page, perPage }) =>
      guard(async () =>
        jsonResult({ statistics: await misc.getSiteStatistics(client.ctx(), page, perPage) }),
      ),
  );

  server.registerTool(
    "get_studio",
    {
      title: "Get studio",
      description:
        "Get a studio's profile (name, whether it's an animation studio) and its top 10 most " +
        "popular produced titles (a fixed cap, not paginated — AniList's studio field exposes no " +
        "more via this lookup), by AniList studio ID or by name. Confirmed live: `name` already " +
        "does AniList's own fuzzy search (same mechanism as search_studio), so a partial name " +
        '(e.g. "Kyoto Anim") resolves directly — reach for search_studio instead only when you ' +
        "need to browse multiple candidates rather than take the closest match. If both `id` " +
        "and `name` are given, `id` takes precedence and `name` is ignored.",
      inputSchema: z
        .object({
          id: studioId.optional().describe("AniList studio ID. Provide this or `name`."),
          name: z
            .string()
            .min(1)
            .optional()
            .describe("Studio name to look up. Provide this or `id`."),
        })
        .refine((v) => v.id !== undefined || v.name !== undefined, {
          message: "Provide either `id` or `name`.",
        }),
      outputSchema: z.object({ studio: studioObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id, name }) =>
      guard(async () => jsonResult({ studio: await misc.getStudio(client.ctx(), id ?? name!) })),
  );
}
