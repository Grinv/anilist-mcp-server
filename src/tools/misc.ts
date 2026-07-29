import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as misc from "../clients/anilist/misc.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { pageInfoSchema, anilistId, paginationFields } from "./outputSchemas.js";

const mediaTagItem = z
  .object({
    id: z.number().int().optional(),
    name: z.string().optional(),
    description: z.string().nullish(),
    category: z.string().nullish(),
    isAdult: z.boolean().nullish(),
  })
  .passthrough();

const statSeries = z
  .object({
    nodes: z
      .array(
        z
          .object({
            date: z.number().nullish(),
            count: z.number().int().nullish(),
            change: z.number().int().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    pageInfo: pageInfoSchema.optional(),
  })
  .passthrough();

const siteStatisticsObject = z
  .object({
    users: statSeries.nullish(),
    anime: statSeries.nullish(),
    manga: statSeries.nullish(),
  })
  .passthrough();

/** STUDIO_FIELDS — only `id`/`name` are near-certain; everything else is
 *  nullable/absent depending on what AniList actually has for the studio. */
const studioObject = z
  .object({
    id: z.number().int().optional(),
    name: z.string().optional(),
    isAnimationStudio: z.boolean().nullish(),
    isFavourite: z.boolean().nullish(),
    siteUrl: z.string().nullish(),
    media: z
      .object({
        nodes: z
          .array(
            z
              .object({
                id: z.number().int().optional(),
                title: z
                  .object({ romaji: z.string().nullish(), english: z.string().nullish() })
                  .nullish(),
              })
              .passthrough(),
          )
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

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
      .number()
      .int()
      .nullish()
      .describe(
        "Exact total tag count — unlike this field's usual meaning on AniList-paginated " +
          "tools, this one IS accurate: it's computed client-side from the full ~425-tag " +
          "collection fetched in one request, not from AniList's own degraded page resolver. " +
          "Safe to rely on to know when you've paged through everything.",
      ),
    lastPage: z
      .number()
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
        page: z.number().int().positive().default(1).describe("Page number for pagination."),
        perPage: z
          .number()
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
        "more via this lookup), by AniList studio ID or by name. Use search_studio first if you " +
        "only have a partial name and need to resolve it to an ID. If both `id` and `name` are " +
        "given, `id` takes precedence and `name` is ignored.",
      inputSchema: z
        .object({
          id: anilistId.optional().describe("AniList studio ID. Provide this or `name`."),
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
