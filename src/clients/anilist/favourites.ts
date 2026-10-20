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

interface FavouritesPage {
  pageInfo?: { hasNextPage?: boolean | null } | null;
  nodes?: { id: number }[] | null;
}

export async function toggleFavourite(
  ctx: AniListContext,
  kind: FavouriteKind,
  id: number,
): Promise<{ favourites: unknown; isFavourite: boolean | null }> {
  const argName = ARG_NAME[kind];
  const connection = CONNECTION[kind];
  // Only the toggled kind's connection is selected: a toggle can't change the
  // other four, so echoing them on every call was pure response weight. The
  // output schema keeps all five keys optional, so the narrower shape still
  // validates. perPage:50 (AniList's max; the default is 25): a newly added
  // favourite goes to the END of the list (confirmed live), so on a long list
  // it can sit past this page.
  const query = `mutation($id:Int){ToggleFavourite(${argName}:$id){${connection}(perPage:50){pageInfo{hasNextPage} nodes{id}}}}`;
  const data = await ctx.gql.request<{
    ToggleFavourite: Partial<Record<string, FavouritesPage | null>> | null;
  }>(query, { id }, ctx.requireAuth());
  const page = data.ToggleFavourite?.[connection];
  // In the returned page → now a favourite. Absent from a complete list → not
  // one. Absent but the list continues past this page → can't tell.
  const isFavourite = page?.nodes?.some((n) => n.id === id)
    ? true
    : page?.pageInfo?.hasNextPage === false
      ? false
      : null;
  return { favourites: data.ToggleFavourite, isFavourite };
}
