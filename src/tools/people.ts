import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AniListClient } from "../clients/anilist.js";
import * as people from "../clients/anilist/people.js";
import { jsonResult } from "../lib/result.js";
import { guard } from "./guard.js";
import { anilistId } from "./outputSchemas.js";

const characterObject = z
  .object({
    id: z.number().int(),
    name: z.object({ full: z.string().nullish(), native: z.string().nullish() }).nullish(),
    image: z.object({ large: z.string().nullish() }).nullish(),
    description: z.string().nullish(),
    favourites: z.number().int().nullish(),
    isFavourite: z.boolean().nullish(),
    siteUrl: z.string().nullish(),
  })
  .passthrough();

const staffObject = z
  .object({
    id: z.number().int(),
    name: z.object({ full: z.string().nullish(), native: z.string().nullish() }).nullish(),
    image: z.object({ large: z.string().nullish() }).nullish(),
    description: z.string().nullish(),
    primaryOccupations: z.array(z.string()).nullish(),
    favourites: z.number().int().nullish(),
    isFavourite: z.boolean().nullish(),
    siteUrl: z.string().nullish(),
  })
  .passthrough();

const BIRTHDAY_KINDS = ["CHARACTER", "STAFF"] as const;

export function registerPeopleTools(server: McpServer, client: AniListClient): void {
  server.registerTool(
    "get_character",
    {
      title: "Get character details",
      description:
        "Get a character's profile by AniList character ID: name, image, description. Use " +
        "search_character first to resolve a name to its ID.",
      inputSchema: z.object({ id: anilistId.describe("AniList character ID.") }),
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
        "description. Use search_staff first to resolve a name to its ID.",
      inputSchema: z.object({ id: anilistId.describe("AniList staff ID.") }),
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
        "List all AniList characters or staff members whose birthday (month/day) is today. " +
        "Returns character-shaped objects for kind: CHARACTER, or staff-shaped objects (same " +
        "fields plus `primaryOccupations`) for kind: STAFF.",
      inputSchema: z.object({
        kind: z.enum(BIRTHDAY_KINDS).describe("Whether to list characters or staff members."),
      }),
      outputSchema: z.object({
        results: z.union([z.array(characterObject), z.array(staffObject)]),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ kind }) =>
      guard(async () =>
        jsonResult({ results: await people.getTodaysBirthdays(client.ctx(), kind) }),
      ),
  );
}
