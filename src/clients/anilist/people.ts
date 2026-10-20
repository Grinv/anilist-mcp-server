import type { AniListContext } from "./context.js";
import { ApiError, assertFound } from "../../lib/errors.js";
import type { CharacterId, StaffId } from "./ids.js";
import type { BirthdayKind, MediaType } from "./enums.js";
import {
  CHARACTER_FIELDS,
  CHARACTER_DETAIL_FIELDS,
  STAFF_FIELDS,
  STAFF_DETAIL_FIELDS,
  STAFF_VOICE_FIELDS,
  STAFF_VOICE_VARS,
  PERSON_DESCRIPTION_FIELD,
  PERSON_FILMOGRAPHY_VARS,
} from "./fields.js";

/** Pagination and server-side filters for get_character's `media` /
 *  get_staff's `staffMedia` filmography (see fields.ts's
 *  PERSON_FILMOGRAPHY_VARS). Unset filters are dropped from the request. */
export interface PersonFilmographyOptions {
  page?: number;
  perPage?: number;
  type?: MediaType;
  onList?: boolean;
}

export type StaffCredits = "production" | "voice";

export async function getCharacter(
  ctx: AniListContext,
  id: CharacterId,
  opts: PersonFilmographyOptions = {},
): Promise<unknown> {
  const query = `query($id:Int,${PERSON_FILMOGRAPHY_VARS}){Character(id:$id){${CHARACTER_FIELDS}${PERSON_DESCRIPTION_FIELD}${CHARACTER_DETAIL_FIELDS}}}`;
  const { page = 1, perPage = 25, type, onList } = opts;
  const data = await ctx.gql.request<{ Character: unknown }>(
    query,
    { id, page, perPage, type, onList },
    ctx.authHeader(),
  );
  return assertFound(data.Character, `No character found with ID ${id}.`);
}

export async function getStaff(
  ctx: AniListContext,
  id: StaffId,
  opts: PersonFilmographyOptions & { credits?: StaffCredits } = {},
): Promise<unknown> {
  const { page = 1, perPage = 25, type, onList, credits = "production" } = opts;
  const voice = credits === "voice";
  // characterMedia has no `type` argument, so rather than silently ignoring
  // one, say so before any request.
  if (voice && type !== undefined) {
    throw new ApiError({
      code: "bad_request",
      message:
        '`type` only filters production credits; omit it with `credits: "voice"` (voice ' +
        "roles are AniList's anime/game casting, not split by media type).",
    });
  }
  const query = voice
    ? `query($id:Int,${STAFF_VOICE_VARS}){Staff(id:$id){${STAFF_FIELDS}${PERSON_DESCRIPTION_FIELD}${STAFF_VOICE_FIELDS}}}`
    : `query($id:Int,${PERSON_FILMOGRAPHY_VARS}){Staff(id:$id){${STAFF_FIELDS}${PERSON_DESCRIPTION_FIELD}${STAFF_DETAIL_FIELDS}}}`;
  const data = await ctx.gql.request<{ Staff: unknown }>(
    query,
    { id, page, perPage, type, onList },
    ctx.authHeader(),
  );
  return assertFound(data.Staff, `No staff member found with ID ${id}.`);
}

export async function getTodaysBirthdays(
  ctx: AniListContext,
  kind: BirthdayKind,
  includeDescription = false,
  page = 1,
  perPage = 50,
): Promise<{ results: unknown[]; hasNextPage: boolean | null }> {
  const field = kind === "CHARACTER" ? "characters" : "staff";
  const base = kind === "CHARACTER" ? CHARACTER_FIELDS : STAFF_FIELDS;
  const fields = `${base}${includeDescription ? PERSON_DESCRIPTION_FIELD : ""}`;
  // Paginated, not a single fixed Page(perPage:50): a popular day has far more
  // than 50 birthdays (confirmed live: 2026-10-20 had 1,450 characters), so a
  // fixed page silently dropped the rest. FAVOURITES_DESC puts the
  // best-known entries on page 1 — unsorted, AniList returns them in no
  // useful order.
  const query = `query($page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){
    pageInfo{hasNextPage}
    ${field}(isBirthday:true,sort:FAVOURITES_DESC){${fields}}
  }}`;
  const data = await ctx.gql.request<{
    Page: { pageInfo: { hasNextPage: boolean | null } } & Record<string, unknown>;
  }>(query, { page, perPage }, ctx.authHeader());
  return { results: data.Page[field] as unknown[], hasNextPage: data.Page.pageInfo.hasNextPage };
}
