import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.ts";
import * as people from "../clients/anilist/people.ts";
import { jsonResult } from "../lib/result.ts";
import { guard } from "./guard.ts";
import {
  anilistId,
  characterId,
  staffId,
  mediaTitleOut,
  favouriteOut,
  personDescriptionField,
  paginationFields,
  NESTED_MAX_PER_PAGE,
  pageInfoSchema,
  filmographyOnListField,
} from "./outputSchemas.ts";
import { BIRTHDAY_KINDS, MEDIA_TYPES } from "../clients/anilist/enums.ts";

const mediaCredit = z
  .object({
    node: z
      .object({
        id: anilistId,
        title: mediaTitleOut.nullish(),
        type: z.string().nullish(),
        format: z.string().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

/** Input fields shared by get_character/get_staff for their filmography
 *  connection (`media`/`staffMedia`). Named `page`/`perPage`/`type`/`onList`
 *  — the names get_media_characters/get_media_staff already use for their
 *  nested connection and search_media for the type/list filters — since
 *  neither tool has another paginated or typed field they could collide with. */
const personFilmographyFields = (connection: string) => ({
  ...paginationFields(25, NESTED_MAX_PER_PAGE),
  type: z
    .enum(MEDIA_TYPES)
    .optional()
    .describe(
      `Only return anime (ANIME) or only manga (MANGA) in \`${connection}\` — filtered by ` +
        "AniList before pagination, so pages stay full. Omit for both.",
    ),
  onList: filmographyOnListField,
});

const characterObject = z
  .object({
    id: anilistId,
    name: z.object({ full: z.string().nullish(), native: z.string().nullish() }).nullish(),
    image: z.object({ large: z.httpUrl().nullish() }).nullish(),
    description: z.string().nullish(),
    favourites: z.int().nonnegative().nullish(),
    isFavourite: favouriteOut("character"),
    siteUrl: z.httpUrl().nullish(),
    media: z
      .object({
        pageInfo: pageInfoSchema.optional(),
        edges: z.array(mediaCredit.extend({ characterRole: z.string().nullish() })),
      })
      .nullish(),
  })
  .loose();

const staffObject = z
  .object({
    id: anilistId,
    name: z.object({ full: z.string().nullish(), native: z.string().nullish() }).nullish(),
    image: z.object({ large: z.httpUrl().nullish() }).nullish(),
    description: z.string().nullish(),
    primaryOccupations: z.array(z.string()).nullish(),
    favourites: z.int().nonnegative().nullish(),
    isFavourite: favouriteOut("staff member"),
    siteUrl: z.httpUrl().nullish(),
    staffMedia: z
      .object({
        pageInfo: pageInfoSchema.optional(),
        edges: z.array(mediaCredit.extend({ staffRole: z.string().nullish() })),
      })
      .nullish(),
    characterMedia: z
      .object({
        pageInfo: pageInfoSchema.optional(),
        edges: z.array(
          mediaCredit.extend({
            characterRole: z.string().nullish(),
            characters: z
              .array(
                z
                  .object({
                    id: anilistId,
                    name: z.object({ full: z.string().nullish() }).nullish(),
                  })
                  .loose()
                  .nullable(),
              )
              .nullish(),
          }),
        ),
      })
      .nullish(),
  })
  .loose();

// get_todays_birthdays fetches the lighter CHARACTER_FIELDS/STAFF_FIELDS shape
// (no media/staffMedia filmography, and no `description` unless the caller
// opts in), and a CHARACTER and a STAFF entry share
// every field except staff's `primaryOccupations`. One loose object models
// both: a union of the two loose shapes would be degenerate anyway, since a
// staff object — .loose() with only `id` required — already validates as a
// character, leaving the staff branch unreachable.
const birthdayObject = z
  .object({
    id: anilistId,
    name: z.object({ full: z.string().nullish(), native: z.string().nullish() }).nullish(),
    image: z.object({ large: z.httpUrl().nullish() }).nullish(),
    description: z.string().nullish(),
    primaryOccupations: z.array(z.string()).nullish(), // STAFF entries only
    favourites: z.int().nonnegative().nullish(),
    isFavourite: favouriteOut("character or staff member"),
    siteUrl: z.httpUrl().nullish(),
  })
  .loose();

export function registerPeopleTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_character",
    {
      title: "Get character details",
      description:
        "Get a character's profile by AniList character ID: name, image, description, and the " +
        "anime/manga they appear in (`media`, most popular first, with their `characterRole` " +
        "— MAIN/SUPPORTING/BACKGROUND — in each). Use search_character first to resolve a name " +
        "to its ID. `media` is paginated (`page`/`perPage`, max 25): a long-running franchise " +
        "character can appear in far more titles than one page holds, so check " +
        "`media.pageInfo.hasNextPage` before treating it as the full list. Narrow it with " +
        "`type` (anime or manga only) or `onList`.",
      inputSchema: z.strictObject({
        id: characterId.describe("AniList character ID."),
        ...personFilmographyFields("media"),
      }),
      outputSchema: z.object({ character: characterObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id, page, perPage, type, onList }) =>
      guard(async () =>
        jsonResult({
          character: await people.getCharacter(client.ctx(), id, { page, perPage, type, onList }),
        }),
      ),
  );

  server.registerTool(
    "get_staff",
    {
      title: "Get staff member details",
      description:
        "Get a staff member's profile by AniList staff ID: name, image, occupations, " +
        "description, and the anime/manga they hold production credits on (`staffMedia`, most " +
        "popular first, with their `staffRole` — e.g. Director, Character Design, Theme Song " +
        "Performance — in each). Use search_staff first to resolve a name to its ID. " +
        "Voice-acting roles are NOT part of `staffMedia` (confirmed live: Kana Hanazawa's lists " +
        'only her theme/insert song credits) — for a voice actor, pass `credits: "voice"` to ' +
        "get `characterMedia` instead: each title with the character(s) voiced and their " +
        "`characterRole`. Either list is paginated (`page`/`perPage`, max 25) — check its " +
        "`pageInfo.hasNextPage` before treating it as the full list. Narrow it with `onList`, " +
        "or `type` (anime or manga only; production credits only).",
      inputSchema: z.strictObject({
        id: staffId.describe("AniList staff ID."),
        ...personFilmographyFields("staffMedia"),
        credits: z
          .enum(["production", "voice"])
          .default("production")
          .describe(
            'Which filmography to return: "production" (`staffMedia` — director, writer, ' +
              'theme song, …) or "voice" (`characterMedia` — voice-acting roles). One per call.',
          ),
      }),
      outputSchema: z.object({ staff: staffObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id, page, perPage, type, onList, credits }) =>
      guard(async () =>
        jsonResult({
          staff: await people.getStaff(client.ctx(), id, { page, perPage, type, onList, credits }),
        }),
      ),
  );

  server.registerTool(
    "get_todays_birthdays",
    {
      title: "Get today's birthday characters or staff",
      description:
        "List AniList characters or staff members whose birthday (month/day) is today, most " +
        "favourited first. Paginated — a single day can have well over a thousand entries, " +
        "so check `hasNextPage` before treating a page as the full list. Returns " +
        "character-shaped or staff-shaped objects for kind: CHARACTER/STAFF " +
        "respectively, but a lighter fetch than get_character/get_staff: it does NOT include " +
        "those tools' `media`/`staffMedia` filmography, nor each entry's bio (`description`) " +
        "unless you set `includeDescription` — call get_character/get_staff by ID for an " +
        "entry's full roles/works and bio, don't read a missing filmography here as 'none'.",
      inputSchema: z.strictObject({
        kind: z.enum(BIRTHDAY_KINDS).describe("Whether to list characters or staff members."),
        includeDescription: personDescriptionField("get_character/get_staff"),
        ...paginationFields(50),
      }),
      outputSchema: z.object({
        results: z.array(birthdayObject),
        hasNextPage: z.boolean().nullish(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ kind, includeDescription, page, perPage }) =>
      guard(async () =>
        jsonResult(
          await people.getTodaysBirthdays(client.ctx(), kind, includeDescription, page, perPage),
        ),
      ),
  );
}
