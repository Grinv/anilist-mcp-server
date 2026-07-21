// Shared GraphQL field-selection fragments, reused across multiple domain
// modules (e.g. MEDIA_FIELDS in both media.ts and search.ts).

// Kept lean on purpose: search.ts/recommendation.ts return many media items
// per call, so MEDIA_FIELDS excludes variable-length/rarely-needed fields
// (tags can run 20-30 entries per title). get_media (single or few items)
// additionally appends MEDIA_DETAIL_FIELDS — see media.ts's getMedia().
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
  description(asHtml: false)
  trailer { id site thumbnail }
`;

/** Extra fields only worth the token cost on a direct get_media lookup, not
 *  on every row of a multi-item search/list result. */
export const MEDIA_DETAIL_FIELDS = `
  tags { name rank isMediaSpoiler }
  rankings { rank type format year season allTime context }
`;

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

export const ACTIVITY_FRAGMENT = `
  ... on TextActivity { id type text(asHtml: false) siteUrl createdAt user { id name } }
  ... on ListActivity { id type status progress createdAt siteUrl user { id name } media { id title { romaji english } } }
  ... on MessageActivity { id type message(asHtml: false) createdAt siteUrl recipient { id name } messenger { id name } }
`;

// NotificationUnion has 20 possible concrete types (verified live against
// graphql.anilist.co's own introspection — AniList's hosted docs don't list
// them). Every branch shares id/type/createdAt/context(s); each fragment below
// additionally selects that type's one distinguishing reference (media/user/
// thread/staff/character) so a caller doesn't have to make a follow-up call
// just to know *what* the notification is about. Deliberately shallow beyond
// that — e.g. `activity`/`comment` are exposed only as their bare id
// (activityId/commentId), not the full nested object, matching this file's
// token-efficiency convention (see MEDIA_FIELDS's comment above).
export const NOTIFICATION_FIELDS = `
  ... on AiringNotification { id type createdAt animeId episode contexts media { id title { romaji english } } }
  ... on FollowingNotification { id type createdAt userId context user { id name } }
  ... on ActivityMessageNotification { id type createdAt userId activityId context user { id name } }
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
