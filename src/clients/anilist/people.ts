import type { AniListContext } from "./context.js";
import { assertFound } from "../../lib/errors.js";
import type { CharacterId, StaffId } from "./ids.js";
import type { BirthdayKind } from "./enums.js";
import {
  CHARACTER_FIELDS,
  CHARACTER_DETAIL_FIELDS,
  STAFF_FIELDS,
  STAFF_DETAIL_FIELDS,
  PERSON_DESCRIPTION_FIELD,
} from "./fields.js";

export async function getCharacter(ctx: AniListContext, id: CharacterId): Promise<unknown> {
  const query = `query($id:Int){Character(id:$id){${CHARACTER_FIELDS}${PERSON_DESCRIPTION_FIELD}${CHARACTER_DETAIL_FIELDS}}}`;
  const data = await ctx.gql.request<{ Character: unknown }>(query, { id }, ctx.authHeader());
  return assertFound(data.Character, `No character found with ID ${id}.`);
}

export async function getStaff(ctx: AniListContext, id: StaffId): Promise<unknown> {
  const query = `query($id:Int){Staff(id:$id){${STAFF_FIELDS}${PERSON_DESCRIPTION_FIELD}${STAFF_DETAIL_FIELDS}}}`;
  const data = await ctx.gql.request<{ Staff: unknown }>(query, { id }, ctx.authHeader());
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
