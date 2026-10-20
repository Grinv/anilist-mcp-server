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
 *  builds the query fragment, not the check itself. `extraArgs` adds
 *  literal (non-variable) GraphQL args, e.g. `"type:ANIME"` — needed when
 *  the real query's Page connection has no type filter of its own, so an id
 *  of the WRONG AniList type would otherwise pass this existence check and
 *  the connection would just silently return empty results (confirmed live:
 *  `get_anime_schedule` given a real manga id, before this parameter
 *  existed). */
export function existsFragment(typeName: string, idVar: string, extraArgs?: string): string {
  const args = extraArgs ? `id:$${idVar},${extraArgs}` : `id:$${idVar}`;
  return `exists:${typeName}(${args}){id}`;
}

// `status(version:2)`, not bare `status`: unversioned, AniList still answers
// with its v1 enum, which has no HIATUS — confirmed live, Hunter×Hunter's
// manga (30026) reads back RELEASING bare but HIATUS at version 2, even
// though search_media's own `status_in: [HIATUS]` filter matches it. The
// response key stays `status` either way (an argument, not an alias).
export const MEDIA_STATUS_FIELD = `status(version:2)`;

// Kept lean on purpose: search.ts/recommendation.ts return many media items
// per call, so MEDIA_FIELDS excludes variable-length/rarely-needed fields
// (tags can run 20-30 entries per title). get_media (single or few items)
// additionally appends MEDIA_DETAIL_FIELDS — see media.ts's getMedia().
// `description` is deliberately excluded here too — it can run to several
// hundred/thousand characters, and search_media returns up to 50 media
// items per call — see MEDIA_DESCRIPTION_FIELD below.
export const MEDIA_FIELDS = `
  id
  idMal
  type
  format
  ${MEDIA_STATUS_FIELD}
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

/** Just enough to identify a title and tell two similar ones apart — what a
 *  caller mapping ids onto titles actually needs. Measured live through the
 *  tool: 169 bytes per title against 4,182 for the full selection, i.e. a
 *  30-title batch is 5,083 bytes instead of 125,469.
 *  Deliberately excludes cover images and siteUrl
 *  too: both are derivable from `id` and neither helps identification. */
export const MEDIA_COMPACT_FIELDS = `
  id
  idMal
  type
  format
  ${MEDIA_STATUS_FIELD}
  episodes
  chapters
  title { romaji english }
`;

/** Synopsis text — always appended for get_media (a single/few-item lookup,
 *  where the description is usually the point), but only on request
 *  (`includeDescription`) for search_media, whose results can run to 50
 *  media items per call. */
export const MEDIA_DESCRIPTION_FIELD = `description(asHtml: false)`;

/** Extra fields only worth the token cost on a direct get_media lookup, not
 *  on every row of a multi-item search/list result. mediaListEntry is
 *  viewer-relative — it resolves to null when no token is sent, rather than
 *  erroring, so it's safe to always request. Its `score` is pinned to
 *  `POINT_10_DECIMAL` for the same reason getUserList() pins it (see
 *  list.ts): unformatted, AniList returns a list entry's score in the
 *  account's own display `scoreFormat`, so the SAME personal score would
 *  read back as 94 here and 9.4 from get_user_list on a POINT_100 account
 *  (confirmed live against a public POINT_100 list: `score` 94 vs
 *  `score(format:POINT_10_DECIMAL)` 9.4). Pinning keeps every personal score
 *  this server emits on the 0-10 scale its write side already documents.
 *  `streamingEpisodes` is deliberately excluded — AniList's field takes no
 *  pagination args at all, so a long-running title can return hundreds of
 *  entries; it's appended separately, only on request (see getMedia()'s
 *  includeStreamingEpisodes). */
export const MEDIA_DETAIL_FIELDS = `
  tags { name rank isMediaSpoiler }
  rankings { rank type format year season allTime context }
  nextAiringEpisode { id airingAt timeUntilAiring episode }
  externalLinks { id url site type language icon notes isDisabled }
  mediaListEntry {
    id status score(format:POINT_10_DECIMAL) progress progressVolumes repeat priority private notes
    hiddenFromStatusLists customLists(asArray: true) advancedScores
    startedAt { year month day } completedAt { year month day } updatedAt createdAt
  }
`;

/** Unbounded field (see MEDIA_DETAIL_FIELDS's comment above) — appended only
 *  when the caller opts in. */
export const MEDIA_STREAMING_EPISODES_FIELD = `streamingEpisodes { title thumbnail url site }`;

// Kept lean on purpose, same reasoning as MEDIA_FIELDS above:
// search_character/search_staff return up to 50 entries per call and
// get_todays_birthdays up to 50 per page, so `description` is excluded here and
// appended separately — see PERSON_DESCRIPTION_FIELD below.
export const CHARACTER_FIELDS = `
  id
  name { full native }
  image { large }
  favourites
  isFavourite
  siteUrl
`;

export const STAFF_FIELDS = `
  id
  name { full native }
  image { large }
  primaryOccupations
  favourites
  isFavourite
  siteUrl
`;

/** A character's or staff member's bio text — always appended for
 *  get_character/get_staff (a single-item lookup, where the bio is usually
 *  the point), but only on request (`includeDescription`) for
 *  search_character/search_staff/get_todays_birthdays. Same reasoning as
 *  MEDIA_DESCRIPTION_FIELD above, and measured live on those three: the bio
 *  ran to 57-85% of the whole response payload (e.g. 22KB of a 29KB
 *  25-result character search, 23KB of a 35KB 44-entry birthday list). */
export const PERSON_DESCRIPTION_FIELD = `description(asHtml: false)`;

// The filmography connections below (Character.media, Staff.staffMedia,
// Studio.media) are paginated through query variables rather than a fixed
// `perPage: 25` with no pageInfo: a fixed page silently dropped everything
// past the 25th title with no signal (confirmed live: Luffy's `media` and
// Kana Hanazawa's `staffMedia` both report `hasNextPage: true` at 25). Their
// `perPage` is clamped to 25 server-side like every other nested connection
// (confirmed live: all three report `pageInfo.perPage: 25` when asked for 50)
// — see NESTED_MAX_PER_PAGE in tools/outputSchemas.ts. The filter variables
// ($type/$isMain/$onList) are left unset when the caller doesn't pass one
// (GraphQLClient strips undefined variables), and an unset variable is the
// same as omitting the argument, so the default stays "every title".

/** Variable declarations CHARACTER_DETAIL_FIELDS/STAFF_DETAIL_FIELDS need —
 *  the enclosing query must declare these alongside its own `$id`. */
export const PERSON_FILMOGRAPHY_VARS = `$page:Int,$perPage:Int,$type:MediaType,$onList:Boolean`;

/** Extra field only worth the token cost on a direct get_character lookup,
 *  not on every row of a search_character result (same reasoning as
 *  MEDIA_DETAIL_FIELDS above). */
export const CHARACTER_DETAIL_FIELDS = `
  media(page: $page, perPage: $perPage, sort: POPULARITY_DESC, type: $type, onList: $onList) {
    pageInfo { hasNextPage }
    edges { characterRole node { id title { romaji english } type format } }
  }
`;

/** Extra field only worth the token cost on a direct get_staff lookup, not
 *  on every row of a search_staff result. staffMedia covers production/
 *  credit roles (director, writer, theme song performance, ...) but NOT
 *  voice-acting roles — confirmed live: Kana Hanazawa's staffMedia lists only
 *  her theme/insert song credits, while her voice roles live under the
 *  separate `characterMedia`/`characters` connections, which this fragment
 *  doesn't select. */
export const STAFF_DETAIL_FIELDS = `
  staffMedia(page: $page, perPage: $perPage, sort: POPULARITY_DESC, type: $type, onList: $onList) {
    pageInfo { hasNextPage }
    edges { staffRole node { id title { romaji english } type format } }
  }
`;

/** get_staff's `credits: "voice"` alternative to STAFF_DETAIL_FIELDS: the
 *  voice-acting roles staffMedia leaves out, one edge per title with the
 *  character(s) voiced in it. `characterMedia` takes no `type` argument (live
 *  schema), hence its own, narrower variable list. */
export const STAFF_VOICE_FIELDS = `
  characterMedia(page: $page, perPage: $perPage, sort: POPULARITY_DESC, onList: $onList) {
    pageInfo { hasNextPage }
    edges { characterRole characters { id name { full } } node { id title { romaji english } type format } }
  }
`;

export const STAFF_VOICE_VARS = `$page:Int,$perPage:Int,$onList:Boolean`;

export const STUDIO_FIELDS = `
  id
  name
  isAnimationStudio
  isFavourite
  siteUrl
`;

/** Variable declarations STUDIO_DETAIL_FIELDS needs (see
 *  PERSON_FILMOGRAPHY_VARS). Studio.media takes `isMain` instead of `type` —
 *  confirmed live: `isMain: true` keeps only titles where the studio was the
 *  primary animation studio (Aniplex: 1 title), `false` only the merely
 *  credited ones (Studio Ghibli: 19 titles, every edge `isMainStudio:
 *  false`), and omitted returns both. */
export const STUDIO_FILMOGRAPHY_VARS = `$page:Int,$perPage:Int,$isMain:Boolean,$onList:Boolean`;

/** get_studio's filmography, split out of STUDIO_FIELDS so the studio's own
 *  fields stay reusable without dragging a paginated connection (and its
 *  required variables) along. */
export const STUDIO_DETAIL_FIELDS = `
  media(page: $page, perPage: $perPage, sort: POPULARITY_DESC, isMain: $isMain, onList: $onList) {
    pageInfo { hasNextPage }
    nodes { id title { romaji english } }
  }
`;

// Kept lean on purpose (same reasoning as MEDIA_FIELDS above): search.ts's
// searchUser returns many users per call. get_user_profile/get_full_user_info/
// get_authorized_user (single-user fetches) additionally append
// USER_DESCRIPTION_FIELD (below) and USER_DETAIL_FIELDS — confirmed live that
// options/mediaListOptions are NOT viewer-gated: they resolve for any user,
// not just the caller, so a lookup of a third party also exposes that person's
// notification/list-display settings, not just their public profile fields.
export const USER_FIELDS = `
  id
  name
  avatar { large }
  bannerImage
  siteUrl
  donatorTier
  donatorBadge
  isFollowing
  isFollower
`;

/** A user's bio text — always appended for get_user_profile/get_full_user_info/
 *  get_authorized_user (single-user fetches, where the bio is usually the
 *  point), but only on request (`includeDescription`) for search_user, whose
 *  results can run to 50 users per call. Same reasoning as
 *  MEDIA_DESCRIPTION_FIELD/PERSON_DESCRIPTION_FIELD above. */
export const USER_DESCRIPTION_FIELD = `about(asHtml: false)`;

/** Exposes what update_user actually changes (titleLanguage,
 *  displayAdultContent, scoreFormat, rowOrder, and the anime/manga list
 *  options below) — without this, there's no way to verify one of its calls
 *  actually took effect. animeList/mangaList's full shape (not just
 *  advancedScoring*) is included so a caller changing one sub-field can read
 *  back the rest for reference, even though MediaListOptionsInput is
 *  confirmed live to be a partial merge server-side (unlike
 *  SaveMediaListEntry's advancedScores, which zeros omitted categories).
 *  `theme` is deliberately NOT selected: its read side
 *  (`MediaListTypeOptions.theme`) is `@deprecated` in the live schema ("not
 *  yet fully implemented and may change without warning") and an untyped
 *  `Json` scalar rather than the `String` the write side takes, so echoing it
 *  would only advertise a value AniList itself doesn't stand behind. */
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
    animeList { sectionOrder splitCompletedSectionByFormat customLists advancedScoring advancedScoringEnabled }
    mangaList { sectionOrder splitCompletedSectionByFormat customLists advancedScoring advancedScoringEnabled }
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
