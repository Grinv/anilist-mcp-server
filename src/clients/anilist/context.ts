// The shared handle every domain module (media.ts, search.ts, list.ts, …)
// operates on: the GraphQL transport, plus the two ways a domain function
// can ask for an auth header. Constructed once per call by AniListClient
// (../anilist.ts), which owns the actual token/login state.
import type { GraphQLClient } from "../../lib/graphql.js";

export interface AniListContext {
  gql: GraphQLClient;
  /** Auth header if a usable token is available, else undefined — for
   *  operations that are still useful without one (e.g. toggling a
   *  favourite is always auth-required, but some reads vary). */
  authHeader(): Record<string, string> | undefined;
  /** Auth header for an operation that requires login; throws an
   *  `unauthorized` ApiError if no usable token is configured. */
  requireAuth(): Record<string, string>;
}
