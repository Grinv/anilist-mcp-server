// @ts-check
// Pre-deploy health check for AniList's GraphQL API.
//
// Distinguishes two failure classes:
//   - CONTRACT drift (unexpected status, missing `data`, malformed response) →
//     FAIL the release: the API changed and our integration is likely broken.
//   - TRANSIENT outage (429 rate-limited, 403 "temporarily disabled", 5xx,
//     network) → WARN only: the upstream is momentarily degraded/down, which
//     is no reason to block shipping our own code.
//
// Run: `npm run check:api`. Requests are spaced conservatively — AniList's API
// is, as of 2026-07, in a documented degraded state (30 req/min instead of the
// normal 90) — see docs/api-references.md.

/** @typedef {{ data?: Record<string, unknown> | null, errors?: { message: string }[] }} GraphQLResponse */
/** @typedef {{ name: string, run: () => Promise<void> }} Check */

const ENDPOINT = process.env.ANILIST_GRAPHQL_URL ?? "https://graphql.anilist.co";
const SPACING_MS = 2200;
/** @type {(ms: number) => Promise<void>} */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads a nested path out of an unknown GraphQL response body. Confines the
 * one indexing cast this requires to a single small helper instead of
 * scattering `any` across every assertion below.
 * @param {unknown} value
 * @param {...(string | number)} path
 * @returns {unknown}
 */
function dig(value, ...path) {
  let cur = value;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = /** @type {Record<string | number, unknown>} */ (cur)[key];
  }
  return cur;
}

class TransientError extends Error {}
class ContractError extends Error {}

/**
 * @param {string} gqlQuery
 * @param {Record<string, unknown>} [variables]
 * @returns {Promise<Response>}
 */
async function graphql(gqlQuery, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gqlQuery, variables }),
  });
  if (res.status === 429 || res.status === 403 || res.status >= 500) {
    throw new TransientError(`upstream ${res.status}`);
  }
  return res;
}

/** @type {Check[]} */
const checks = [];
/**
 * @param {string} name
 * @param {string} gql
 * @param {Record<string, unknown>} variables
 * @param {(data: Record<string, unknown> | null | undefined) => void} assertFn
 */
const query = (name, gql, variables, assertFn) =>
  checks.push({
    name,
    run: async () => {
      const res = await graphql(gql, variables);
      if (res.status !== 200) throw new ContractError(`expected 200, got ${res.status}`);
      const body = /** @type {GraphQLResponse} */ (await res.json());
      if (body.errors?.length) {
        throw new ContractError(`GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
      }
      assertFn(body.data);
    },
  });

query(
  "media details (Frieren, id 154587)",
  "query($id:Int){Media(id:$id,type:ANIME){id title{romaji}}}",
  { id: 154587 },
  (d) => {
    if (!dig(d, "Media", "id")) throw new ContractError("missing Media.id");
  },
);

query(
  "media search",
  "query($search:String){Page(perPage:1){media(search:$search,type:ANIME){id}}}",
  { search: "frieren" },
  (d) => {
    if (!Array.isArray(dig(d, "Page", "media")))
      throw new ContractError("Page.media is not an array");
  },
);

query("genre collection", "query{GenreCollection}", {}, (d) => {
  if (!Array.isArray(dig(d, "GenreCollection")))
    throw new ContractError("GenreCollection is not an array");
});

query("media tag collection", "query{MediaTagCollection{name}}", {}, (d) => {
  if (!Array.isArray(dig(d, "MediaTagCollection")))
    throw new ContractError("MediaTagCollection is not an array");
});

query(
  "character details (Frieren, id 176754)",
  "query($id:Int){Character(id:$id){id name{full}}}",
  { id: 176754 },
  (d) => {
    if (!dig(d, "Character", "id")) throw new ContractError("missing Character.id");
  },
);

query(
  "staff details (Hayao Miyazaki, id 96870)",
  "query($id:Int){Staff(id:$id){id name{full}}}",
  { id: 96870 },
  (d) => {
    if (!dig(d, "Staff", "id")) throw new ContractError("missing Staff.id");
  },
);

query(
  "studio details (Madhouse, id 11)",
  "query($id:Int){Studio(id:$id){id name}}",
  { id: 11 },
  (d) => {
    if (!dig(d, "Studio", "id")) throw new ContractError("missing Studio.id");
  },
);

query(
  "user profile (public, matchai)",
  "query($name:String){User(name:$name){id name}}",
  { name: "matchai" },
  (d) => {
    if (!dig(d, "User", "id")) throw new ContractError("missing User.id");
  },
);

query("site statistics", "query{SiteStatistics{anime(perPage:1){nodes{date count}}}}", {}, (d) => {
  if (!Array.isArray(dig(d, "SiteStatistics", "anime", "nodes")))
    throw new ContractError("missing SiteStatistics.anime.nodes");
});

query(
  "media characters+staff+relations+stats (Frieren, id 154587)",
  `query($id:Int){Media(id:$id,type:ANIME){
    characters(perPage:1){edges{role node{id}}}
    staff(perPage:1){edges{role node{id}}}
    relations{edges{relationType node{id}}}
    stats{scoreDistribution{score amount}}
  }}`,
  { id: 154587 },
  (d) => {
    if (!Array.isArray(dig(d, "Media", "characters", "edges")))
      throw new ContractError("missing Media.characters.edges");
    if (!Array.isArray(dig(d, "Media", "staff", "edges")))
      throw new ContractError("missing Media.staff.edges");
    if (!Array.isArray(dig(d, "Media", "relations", "edges")))
      throw new ContractError("missing Media.relations.edges");
    if (!Array.isArray(dig(d, "Media", "stats", "scoreDistribution")))
      throw new ContractError("missing Media.stats.scoreDistribution");
  },
);

query(
  "airing schedule (upcoming, site-wide)",
  "query{Page(perPage:1){airingSchedules(notYetAired:true,sort:TIME){episode media{id}}}}",
  {},
  (d) => {
    if (!Array.isArray(dig(d, "Page", "airingSchedules")))
      throw new ContractError("missing Page.airingSchedules");
  },
);

query(
  "recommendation by id",
  "query($id:Int){Recommendation(id:$id){id media{id} mediaRecommendation{id}}}",
  { id: 231598 },
  (d) => {
    if (!dig(d, "Recommendation", "id")) throw new ContractError("missing Recommendation.id");
  },
);

query(
  "forum thread + comments",
  `query($id:Int,$threadId:Int){
    Thread(id:$id){id title}
    Page(perPage:1){threadComments(threadId:$threadId){id}}
  }`,
  { id: 1000, threadId: 1000 },
  (d) => {
    if (!dig(d, "Thread", "id")) throw new ContractError("missing Thread.id");
    if (!Array.isArray(dig(d, "Page", "threadComments")))
      throw new ContractError("missing Page.threadComments");
  },
);

// A single Page query may only request one data field (see
// docs/api-references.md's "Pagination and Page limitations") — so each of
// these is its own query, mirroring how src/clients/anilist/*.ts builds them.
query(
  "search characters",
  "query($term:String){Page(perPage:1){characters(search:$term){id}}}",
  { term: "a" },
  (d) => {
    if (!Array.isArray(dig(d, "Page", "characters")))
      throw new ContractError("missing Page.characters");
  },
);

query(
  "search staff",
  "query($term:String){Page(perPage:1){staff(search:$term){id}}}",
  { term: "a" },
  (d) => {
    if (!Array.isArray(dig(d, "Page", "staff"))) throw new ContractError("missing Page.staff");
  },
);

query(
  "search studios",
  "query($term:String){Page(perPage:1){studios(search:$term){id}}}",
  { term: "a" },
  (d) => {
    if (!Array.isArray(dig(d, "Page", "studios"))) throw new ContractError("missing Page.studios");
  },
);

query(
  "search users",
  "query($term:String){Page(perPage:1){users(search:$term){id}}}",
  { term: "a" },
  (d) => {
    if (!Array.isArray(dig(d, "Page", "users"))) throw new ContractError("missing Page.users");
  },
);

query(
  "today's birthday characters",
  "query{Page(perPage:1){characters(isBirthday:true){id}}}",
  {},
  (d) => {
    if (!Array.isArray(dig(d, "Page", "characters")))
      throw new ContractError("missing birthday characters");
  },
);

query("today's birthday staff", "query{Page(perPage:1){staff(isBirthday:true){id}}}", {}, (d) => {
  if (!Array.isArray(dig(d, "Page", "staff"))) throw new ContractError("missing birthday staff");
});

query(
  "user's anime/manga list (MediaListCollection, public profile)",
  "query($name:String){MediaListCollection(userName:$name,type:ANIME){lists{name entries{id}}}}",
  { name: "matchai" },
  (d) => {
    if (!Array.isArray(dig(d, "MediaListCollection", "lists")))
      throw new ContractError("missing MediaListCollection.lists");
  },
);

checks.push({
  name: "user activity feed via activities(userId:...) — guards against a userId/userName argument regression",
  run: async () => {
    // activities() takes only a numeric userId (confirmed live: it has no
    // userName argument, unlike most other user-scoped fields) — resolve a
    // username to an id first, exactly like getUserActivity does, so this
    // check fails loudly if that argument shape ever changes again.
    const userRes = await graphql("query($name:String){User(name:$name){id}}", { name: "matchai" });
    if (userRes.status !== 200) throw new ContractError(`expected 200, got ${userRes.status}`);
    const userBody = /** @type {GraphQLResponse} */ (await userRes.json());
    if (userBody.errors?.length) {
      throw new ContractError(
        `GraphQL errors: ${userBody.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const userId = dig(userBody.data, "User", "id");
    if (typeof userId !== "number") throw new ContractError("could not resolve matchai's id");

    const actRes = await graphql(
      "query($userId:Int,$perPage:Int){Page(perPage:$perPage){activities(userId:$userId,sort:ID_DESC){... on ListActivity{id}}}}",
      { userId, perPage: 1 },
    );
    if (actRes.status !== 200) throw new ContractError(`expected 200, got ${actRes.status}`);
    const actBody = /** @type {GraphQLResponse} */ (await actRes.json());
    if (actBody.errors?.length) {
      throw new ContractError(`GraphQL errors: ${actBody.errors.map((e) => e.message).join("; ")}`);
    }
    if (!Array.isArray(dig(actBody.data, "Page", "activities"))) {
      throw new ContractError("missing Page.activities");
    }
  },
});

checks.push({
  name: "notifications reachability + fragment field names (auth required without token)",
  run: async () => {
    // Deliberately bypasses graphql(): a 401/403 here means the query's field
    // names are valid and the viewer-only auth gate is working, not that the
    // API is degraded — the same reasoning as the mutation-reachability check
    // below. Uses the exact fragment set from src/clients/anilist/fields.ts's
    // NOTIFICATION_FIELDS (NotificationUnion has 20 concrete types, verified
    // live via introspection — not documented on AniList's hosted docs) so a
    // renamed/removed field on any branch fails this check with a GraphQL
    // validation error instead of only surfacing at runtime for a real user.
    const notificationFields = `
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
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($perPage:Int){Page(perPage:$perPage){notifications{${notificationFields}}}}`,
        variables: { perPage: 1 },
      }),
    });
    if (res.status === 401 || res.status === 403) return;
    if (res.status === 429 || res.status >= 500) throw new TransientError(`upstream ${res.status}`);
    const body = /** @type {GraphQLResponse} */ (await res.json());
    if (body.errors?.length) {
      throw new ContractError(
        `unexpected GraphQL error (likely a renamed/removed field): ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    throw new ContractError(`expected an auth-related error, got ${res.status}`);
  },
});

checks.push({
  name: "mutation reachability (auth required without token)",
  run: async () => {
    // Deliberately bypasses the shared graphql() helper: it treats 403 as a
    // TransientError (AniList's "temporarily disabled" outage signal), which
    // would swallow the exact status this check needs to inspect — a 401/403
    // here means the auth gate is working, not that the API is degraded.
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query:
          "mutation($mediaId:Int,$status:MediaListStatus){SaveMediaListEntry(mediaId:$mediaId,status:$status){id}}",
        variables: { mediaId: 1, status: "PLANNING" },
      }),
    });
    // Alive + auth gate working: an unauthenticated mutation must be rejected,
    // either at the transport level (401/403) or inside the GraphQL body.
    if (res.status === 401 || res.status === 403) return;
    if (res.status === 429 || res.status >= 500) throw new TransientError(`upstream ${res.status}`);
    const body = /** @type {GraphQLResponse} */ (await res.json());
    if (!body.errors?.length) {
      throw new ContractError("expected an auth-related error for an unauthenticated mutation");
    }
  },
});

const failures = [];
const warnings = [];
for (const check of checks) {
  try {
    await check.run();
    console.log(`  ok    ${check.name}`);
  } catch (err) {
    if (err instanceof TransientError) {
      warnings.push(check.name);
      console.warn(`  warn  ${check.name}: ${err.message} (transient — not blocking)`);
    } else {
      failures.push(check.name);
      console.error(`  FAIL  ${check.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await delay(SPACING_MS);
}

if (warnings.length) {
  console.warn(
    `\n${warnings.length}/${checks.length} checks had transient upstream issues (not blocking).`,
  );
}
if (failures.length) {
  console.error(`\n${failures.length}/${checks.length} API checks failed (contract drift).`);
  process.exit(1);
}
console.log(
  `\nContract checks passed (${checks.length - warnings.length}/${checks.length} reachable).`,
);
