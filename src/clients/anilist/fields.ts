// Shared GraphQL field-selection fragments, reused across multiple domain
// modules (e.g. MEDIA_FIELDS in both media.ts and search.ts).

/** Builds the alias fragment for a same-request existence check, e.g.
 *  `existsFragment("Media", "mediaId")` → `exists:Media(id:$mediaId){id}`.
 *  For a `Page` connection filtered by a parent id that doesn't itself error
 *  on a bad id (see docs/api-references.md's "Page connection filtered by a
 *  parent id" section) — combine this into the SAME request as the real
 *  query rather than a separate round trip: AniList 404s the entire
 *  response when an aliased root field fails to resolve, so a bad id still
 *  surfaces as a clean not_found error at no extra request cost. Callers
 *  still need `assertFound(data.exists, message)` afterward — this only
 *  builds the query fragment, not the check itself. */
export function existsFragment(typeName: string, idVar: string): string {
  return `exists:${typeName}(id:$${idVar}){id}`;
}

// Kept lean on purpose: search.ts/recommendation.ts return many media items
// per call, so MEDIA_FIELDS excludes variable-length/rarely-needed fields
// (tags can run 20-30 entries per title). get_media (single or few items)
// additionally appends MEDIA_DETAIL_FIELDS — see media.ts's getMedia().
// `description` is deliberately excluded here too — it can run to several
// hundred/thousand characters, and search_media returns up to 25 media
// items per call — see MEDIA_DESCRIPTION_FIELD below.
export const MEDIA_FIELDS = `
  id
  idMal
  type
  format
  status
  episodes
  chapters
  volumes
  duration
  genres
  averageScore
  popularity
  isAdult
  isFavourite
  siteUrl
  season
  seasonYear
  countryOfOrigin
  title { romaji english native }
  coverImage { large }
  startDate { year month day }
  endDate { year month day }
  trailer { id site thumbnail }
`;

/** Synopsis text — always appended for get_media (a single/few-item lookup,
 *  where the description is usually the point), but only on request
 *  (`includeDescription`) for search_media, whose results can run to 25
 *  media items per call. */
export const MEDIA_DESCRIPTION_FIELD = `description(asHtml: false)`;

/** Extra fields only worth the token cost on a direct get_media lookup, not
 *  on every row of a multi-item search/list result. mediaListEntry is
 *  viewer-relative — it resolves to null when no token is sent, rather than
 *  erroring, so it's safe to always request. `streamingEpisodes` is
 *  deliberately excluded — AniList's field takes no pagination args at all,
 *  so a long-running title can return hundreds of entries; it's appended
 *  separately, only on request (see getMedia()'s includeStreamingEpisodes). */
export const MEDIA_DETAIL_FIELDS = `
  tags { name rank isMediaSpoiler }
  rankings { rank type format year season allTime context }
  nextAiringEpisode { id airingAt timeUntilAiring episode }
  externalLinks { id url site type language icon notes isDisabled }
  mediaListEntry {
    id status score progress progressVolumes repeat priority private notes
    hiddenFromStatusLists customLists(asArray: true) advancedScores
    startedAt { year month day } completedAt { year month day } updatedAt createdAt
  }
`;

/** Unbounded field (see MEDIA_DETAIL_FIELDS's comment above) — appended only
 *  when the caller opts in. */
export const MEDIA_STREAMING_EPISODES_FIELD = `streamingEpisodes { title thumbnail url site }`;

export const CHARACTER_FIELDS = `
  id
  name { full native }
  image { large }
  description(asHtml: false)
  favourites
  isFavourite
  siteUrl
`;

export const STAFF_FIELDS = `
  id
  name { full native }
  image { large }
  description(asHtml: false)
  primaryOccupations
  favourites
  isFavourite
  siteUrl
`;

/** Extra field only worth the token cost on a direct get_character lookup,
 *  not on every row of a search_character result (same reasoning as
 *  MEDIA_DETAIL_FIELDS above). */
export const CHARACTER_DETAIL_FIELDS = `
  media(perPage: 25, sort: POPULARITY_DESC) {
    edges { characterRole node { id title { romaji english } type format } }
  }
`;

/** Extra field only worth the token cost on a direct get_staff lookup, not
 *  on every row of a search_staff result. staffMedia (not `characters`,
 *  which is voice-actor-specific) covers every staff role — writer,
 *  director, VA, etc. */
export const STAFF_DETAIL_FIELDS = `
  staffMedia(perPage: 25, sort: POPULARITY_DESC) {
    edges { staffRole node { id title { romaji english } type format } }
  }
`;

export const STUDIO_FIELDS = `
  id
  name
  isAnimationStudio
  isFavourite
  siteUrl
  media(sort: POPULARITY_DESC, perPage: 10) {
    nodes { id title { romaji english } }
  }
`;

// Kept lean on purpose (same reasoning as MEDIA_FIELDS above): search.ts's
// searchUser returns many users per call. get_user_profile/get_full_user_info/
// get_authorized_user (single-user fetches) additionally append
// USER_DETAIL_FIELDS — confirmed live that options/mediaListOptions are NOT
// viewer-gated: they resolve for any user, not just the caller, so a lookup
// of a third party also exposes that person's notification/list-display
// settings, not just their public profile fields.
export const USER_FIELDS = `
  id
  name
  about(asHtml: false)
  avatar { large }
  bannerImage
  siteUrl
  donatorTier
  donatorBadge
  isFollowing
  isFollower
`;

/** Exposes what update_user actually changes (titleLanguage,
 *  displayAdultContent, scoreFormat, rowOrder, and the anime/manga list
 *  options below) — without this, there's no way to verify one of its calls
 *  actually took effect. animeList/mangaList's full shape (not just
 *  advancedScoring*) is included so a caller changing one sub-field can read
 *  back the rest for reference, even though MediaListOptionsInput is
 *  confirmed live to be a partial merge server-side (unlike
 *  SaveMediaListEntry's advancedScores, which zeros omitted categories).
 *  `theme`'s read side (`MediaListTypeOptions.theme`) is a deprecated `Json`
 *  scalar (confirmed via introspection: "not yet fully implemented and may
 *  change without warning"), NOT the plain `String` the write side
 *  (`MediaListOptionsInput.theme`) takes — model it loosely, not as a string. */
export const USER_DETAIL_FIELDS = `
  options {
    titleLanguage displayAdultContent airingNotifications profileColor timezone
    activityMergeTime staffNameLanguage restrictMessagesToFollowing
    notificationOptions { type enabled }
    disabledListActivity { type disabled }
  }
  mediaListOptions {
    scoreFormat
    rowOrder
    animeList { sectionOrder splitCompletedSectionByFormat customLists advancedScoring advancedScoringEnabled theme }
    mangaList { sectionOrder splitCompletedSectionByFormat customLists advancedScoring advancedScoringEnabled theme }
  }
`;

export const ACTIVITY_FRAGMENT = `
  ... on TextActivity { id type text(asHtml: false) siteUrl createdAt replyCount likeCount isLiked user { id name } }
  ... on ListActivity { id type status progress createdAt siteUrl replyCount likeCount isLiked user { id name } media { id title { romaji english } } }
  ... on MessageActivity { id type message(asHtml: false) createdAt siteUrl replyCount likeCount isLiked recipient { id name } messenger { id name } }
`;

// NotificationUnion has 20 possible concrete types (verified live against
// graphql.anilist.co's own introspection — AniList's hosted docs don't list
// them). Every branch shares id/type/createdAt/context(s); each fragment below
// additionally selects that type's one distinguishing reference (media/user/
// thread/staff/character) so a caller doesn't have to make a follow-up call
// just to know *what* the notification is about. Deliberately shallow beyond
// that — e.g. `activity`/`comment` are exposed only as their bare id
// (activityId/commentId), not the full nested object, matching this file's
// token-efficiency convention (see MEDIA_FIELDS's comment above). Exception:
// ActivityMessageNotification.message isn't the message text itself — despite
// the name, it's a nested MessageActivity object (AniList's own schema, not
// this project's choice) — so it has to be selected one level deeper to
// actually surface the DM text instead of coming back empty.
export const NOTIFICATION_FIELDS = `
  ... on AiringNotification { id type createdAt animeId episode contexts media { id title { romaji english } } }
  ... on FollowingNotification { id type createdAt userId context user { id name } }
  ... on ActivityMessageNotification { id type createdAt userId activityId context user { id name } message { id message(asHtml: false) siteUrl } }
  ... on ActivityMentionNotification { id type createdAt userId activityId context user { id name } }
  ... on ActivityReplyNotification { id type createdAt userId activityId context user { id name } }
  ... on ActivityReplySubscribedNotification { id type createdAt userId activityId context user { id name } }
  ... on ActivityLikeNotification { id type createdAt userId activityId context user { id name } }
  ... on ActivityReplyLikeNotification { id type createdAt userId activityId context user { id name } }
  ... on ThreadCommentMentionNotification { id type createdAt userId commentId context user { id name } thread { id title } }
  ... on ThreadCommentReplyNotification { id type createdAt userId commentId context user { id name } thread { id title } }
  ... on ThreadCommentSubscribedNotification { id type createdAt userId commentId context user { id name } thread { id title } }
  ... on ThreadCommentLikeNotification { id type createdAt userId commentId context user { id name } thread { id title } }
  ... on ThreadLikeNotification { id type createdAt userId threadId context user { id name } thread { id title } }
  ... on RelatedMediaAdditionNotification { id type createdAt mediaId context media { id title { romaji english } } }
  ... on MediaDataChangeNotification { id type createdAt mediaId context reason media { id title { romaji english } } }
  ... on MediaMergeNotification { id type createdAt mediaId context reason deletedMediaTitles media { id title { romaji english } } }
  ... on MediaDeletionNotification { id type createdAt context reason deletedMediaTitle }
  ... on MediaSubmissionUpdateNotification { id type createdAt contexts status notes submittedTitle media { id title { romaji english } } }
  ... on StaffSubmissionUpdateNotification { id type createdAt contexts status notes staff { id name { full } } }
  ... on CharacterSubmissionUpdateNotification { id type createdAt contexts status notes character { id name { full } } }
`;
