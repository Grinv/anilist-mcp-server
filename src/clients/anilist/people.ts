import type { AniListContext } from "./context.js";
import { assertFound } from "../../lib/errors.js";
import type { CharacterId, StaffId } from "./ids.js";
import {
  CHARACTER_FIELDS,
  CHARACTER_DETAIL_FIELDS,
  STAFF_FIELDS,
  STAFF_DETAIL_FIELDS,
} from "./fields.js";

export async function getCharacter(ctx: AniListContext, id: CharacterId): Promise<unknown> {
  const query = `query($id:Int){Character(id:$id){${CHARACTER_FIELDS}${CHARACTER_DETAIL_FIELDS}}}`;
  const data = await ctx.gql.request<{ Character: unknown }>(query, { id }, ctx.authHeader());
  return assertFound(data.Character, `No character found with ID ${id}.`);
}

export async function getStaff(ctx: AniListContext, id: StaffId): Promise<unknown> {
  const query = `query($id:Int){Staff(id:$id){${STAFF_FIELDS}${STAFF_DETAIL_FIELDS}}}`;
  const data = await ctx.gql.request<{ Staff: unknown }>(query, { id }, ctx.authHeader());
  return assertFound(data.Staff, `No staff member found with ID ${id}.`);
}

export async function getTodaysBirthdays(
  ctx: AniListContext,
  kind: "CHARACTER" | "STAFF",
): Promise<unknown> {
  const field = kind === "CHARACTER" ? "characters" : "staff";
  const fields = kind === "CHARACTER" ? CHARACTER_FIELDS : STAFF_FIELDS;
  const query = `query{Page(perPage:50){${field}(isBirthday:true){${fields}}}}`;
  const data = await ctx.gql.request<{ Page: Record<string, unknown[]> }>(
    query,
    {},
    ctx.authHeader(),
  );
  return data.Page[field];
}
