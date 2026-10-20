import type { AniListContext } from "./context.js";
import type { FavouriteKind } from "./enums.js";

const ARG_NAME: Record<FavouriteKind, string> = {
  ANIME: "animeId",
  MANGA: "mangaId",
  CHARACTER: "characterId",
  STAFF: "staffId",
  STUDIO: "studioId",
};

/** The one `Favourites` connection a toggle of each kind can change. */
const CONNECTION: Record<FavouriteKind, string> = {
  ANIME: "anime",
  MANGA: "manga",
  CHARACTER: "characters",
  STAFF: "staff",
  STUDIO: "studios",
};

export async function toggleFavourite(
  ctx: AniListContext,
  kind: FavouriteKind,
  id: number,
): Promise<unknown> {
  const argName = ARG_NAME[kind];
  // Only the toggled kind's connection is selected: a toggle can't change the
  // other four, so echoing them on every call was pure response weight. The
  // output schema keeps all five keys optional, so the narrower shape still
  // validates.
  const query = `mutation($id:Int){ToggleFavourite(${argName}:$id){${CONNECTION[kind]}{nodes{id}}}}`;
  const data = await ctx.gql.request<{ ToggleFavourite: unknown }>(
    query,
    { id },
    ctx.requireAuth(),
  );
  return data.ToggleFavourite;
}
