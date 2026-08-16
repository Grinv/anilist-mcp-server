import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as people from "../clients/anilist/people.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import {
  anilistId,
  characterId,
  staffId,
  mediaTitleOut,
  favouriteOut,
  personDescriptionField,
} from "./outputSchemas.js";
import { BIRTHDAY_KINDS } from "../clients/anilist/enums.js";

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
      .object({ edges: z.array(mediaCredit.extend({ characterRole: z.string().nullish() })) })
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
      .object({ edges: z.array(mediaCredit.extend({ staffRole: z.string().nullish() })) })
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
        "anime/manga they appear in (`media`, up to 25 by popularity, with their `characterRole` " +
        "— MAIN/SUPPORTING/BACKGROUND — in each). Use search_character first to resolve a name " +
        "to its ID.",
      inputSchema: z.object({ id: characterId.describe("AniList character ID.") }),
      outputSchema: z.object({ character: characterObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) =>
      guard(async () => jsonResult({ character: await people.getCharacter(client.ctx(), id) })),
  );

  server.registerTool(
    "get_staff",
    {
      title: "Get staff member details",
      description:
        "Get a staff member's profile by AniList staff ID: name, image, occupations, " +
        "description, and the anime/manga they worked on (`staffMedia`, up to 25 by popularity, " +
        "with their `staffRole` — e.g. Director, Character Design — in each). Use search_staff " +
        "first to resolve a name to its ID.",
      inputSchema: z.object({ id: staffId.describe("AniList staff ID.") }),
      outputSchema: z.object({ staff: staffObject }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) => guard(async () => jsonResult({ staff: await people.getStaff(client.ctx(), id) })),
  );

  server.registerTool(
    "get_todays_birthdays",
    {
      title: "Get today's birthday characters or staff",
      description:
        "List AniList characters or staff members whose birthday (month/day) is today, up to " +
        "50 results (a fixed cap, not paginated — entries beyond 50 are silently omitted, not " +
        "an error). Returns character-shaped or staff-shaped objects for kind: CHARACTER/STAFF " +
        "respectively, but a lighter fetch than get_character/get_staff: it does NOT include " +
        "those tools' `media`/`staffMedia` filmography, nor each entry's bio (`description`) " +
        "unless you set `includeDescription` — call get_character/get_staff by ID for an " +
        "entry's full roles/works and bio, don't read a missing filmography here as 'none'.",
      inputSchema: z.object({
        kind: z.enum(BIRTHDAY_KINDS).describe("Whether to list characters or staff members."),
        includeDescription: personDescriptionField("get_character/get_staff"),
      }),
      outputSchema: z.object({
        results: z.array(birthdayObject),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ kind, includeDescription }) =>
      guard(async () =>
        jsonResult({
          results: await people.getTodaysBirthdays(client.ctx(), kind, includeDescription),
        }),
      ),
  );
}
