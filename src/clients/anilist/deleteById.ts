// The one shape all four Delete* mutations share: `Delete<X>(id){deleted}`.
import type { AniListContext } from "./context.ts";
import { ApiError } from "../../lib/errors.ts";

/** Run `Delete<mutation>(id)` and treat every "nothing was deleted" answer as
 *  not_found. Confirmed live, all four mutations answer an unknown id (also
 *  one just deleted) with a 400 validation error "id: The selected id is
 *  invalid." rather than an empty result. AniList can also return 200 with
 *  `{deleted: false}` (e.g. not owned by the caller), which must not read as
 *  success either. */
export async function deleteById(
  ctx: AniListContext,
  mutation: "DeleteMediaListEntry" | "DeleteActivity" | "DeleteThread" | "DeleteThreadComment",
  id: number,
  label: string,
): Promise<{ deleted?: boolean }> {
  const header = ctx.requireAuth();
  const sentence = `AniList reported this ${label} as not deleted — it may not exist (or was already deleted), or you may not own it.`;
  // A fresh not_found, not cause.withNote(): the cause's 400 is the validation
  // envelope, not a status this not_found should carry.
  const notDeleted = (cause?: ApiError) =>
    new ApiError({
      code: "not_found",
      note: sentence,
      detail: cause?.detail,
      ...(cause ? { message: cause.message, cause } : {}),
    });
  let data: Record<string, { deleted?: boolean } | null>;
  try {
    data = await ctx.gql.request(`mutation($id:Int){${mutation}(id:$id){deleted}}`, { id }, header);
  } catch (err) {
    if (err instanceof ApiError && /selected id is invalid/i.test(err.detail ?? "")) {
      throw notDeleted(err);
    }
    throw err;
  }
  const result = data[mutation];
  if (!result?.deleted) throw notDeleted();
  return result;
}
