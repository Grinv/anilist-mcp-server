import type { AniListContext } from "./context.js";

export type FavouriteKind = "ANIME" | "MANGA" | "CHARACTER" | "STAFF" | "STUDIO";

const ARG_NAME: Record<FavouriteKind, string> = {
  ANIME: "animeId",
  MANGA: "mangaId",
  CHARACTER: "characterId",
  STAFF: "staffId",
  STUDIO: "studioId",
};

export async function toggleFavourite(
  ctx: AniListContext,
  kind: FavouriteKind,
  id: number,
): Promise<unknown> {
  const argName = ARG_NAME[kind];
  const query = `mutation($id:Int){ToggleFavourite(${argName}:$id){anime{nodes{id}}manga{nodes{id}}characters{nodes{id}}staff{nodes{id}}studios{nodes{id}}}}`;
  const data = await ctx.gql.request<{ ToggleFavourite: unknown }>(
    query,
    { id },
    ctx.requireAuth(),
  );
  return data.ToggleFavourite;
}
