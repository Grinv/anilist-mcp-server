// Thin GraphQL client for AniList's single-endpoint API. POSTs {query,
// variables} and recursively drops `undefined` values from variables before
// sending, so optional arguments (e.g. SaveMediaListEntry's startedAt/
// completedAt/customLists/advancedScores) are omitted entirely rather than
// forced into a placeholder shape. This is the fix for the exact bug class
// that made the previous third-party AniList MCP unable to write list
// entries — see docs/api-references.md.
import { HttpClient } from "./http.js";
import { ApiError, classifyStatus } from "./errors.js";
import type { TtlCache } from "./cache.js";
import type { Logger } from "./logger.js";

export interface GraphQLClientOptions {
  endpoint: string;
  logger: Logger;
  timeoutMs?: number;
  retries?: number;
  /** Called before each request; lets callers throttle (rate limiting). */
  beforeRequest?: () => Promise<void> | void;
  /** Caches successful `query` (never `mutation`) responses. Keyed by query +
   *  variables + the actual auth header value, since the same query can
   *  legitimately return different viewer-relative fields (isFavourite,
   *  isFollowing, …) per account, not just authenticated vs anonymous. */
  cache?: TtlCache<unknown>;
}

export interface GraphQLRequestOptions {
  /** Bypass the read cache for this call even though it's a `query` — for
   *  data whose staleness would cause a silent wrong-answer elsewhere (e.g.
   *  advanced-scoring category order, which a stale read could misapply to
   *  the wrong category with no error). */
  skipCache?: boolean;
}

interface GraphQLErrorEntry {
  message: string;
  status?: number;
  /** Present on validation errors — `message` is then just the generic label
   *  "validation"; the actual per-field reasons live here (see
   *  docs/api-references.md). */
  validation?: Record<string, string[]>;
}

interface GraphQLResponse<T> {
  data: T | null;
  errors?: GraphQLErrorEntry[];
}

export class GraphQLClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache<unknown> | undefined;

  constructor(opts: GraphQLClientOptions) {
    this.#http = new HttpClient({
      baseUrl: opts.endpoint,
      logger: opts.logger,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      beforeRequest: opts.beforeRequest,
      defaultHeaders: { "Content-Type": "application/json" },
    });
    this.#cache = opts.cache;
  }

  /** Run a query or mutation. `authHeader` (e.g. `{Authorization: "Bearer …"}`)
   *  is only needed for operations that touch private/personal data. `query`
   *  operations (never `mutation`) are cached when a cache was configured. */
  async request<T>(
    query: string,
    variables: Record<string, unknown> = {},
    authHeader?: Record<string, string>,
    options?: GraphQLRequestOptions,
  ): Promise<T> {
    if (this.#cache && !options?.skipCache && !/^\s*mutation\b/i.test(query)) {
      // Keyed by the actual auth header value (not just its presence) — two
      // different accounts' bearer tokens must never collide on one entry,
      // or switching accounts mid-process would serve the previous
      // account's cached private/viewer-relative data.
      const key = JSON.stringify({ query, variables, auth: authHeader?.Authorization ?? null });
      return this.#cache.wrap(key, () => this.#send<T>(query, variables, authHeader)) as Promise<T>;
    }
    const result = await this.#send<T>(query, variables, authHeader);
    // A successful mutation can change the answer to any previously-cached
    // read — not just of the resource it touched (e.g. toggling a favourite
    // also changes that entity's `isFavourite` on every query that embeds
    // it), so a targeted per-key invalidation can't be relied on to catch
    // every affected entry. Confirmed live: get_character right after
    // favourite still showed the pre-toggle `isFavourite` for the rest of
    // the TTL window. Clearing everything trades a little cache-warmth for
    // guaranteed-fresh reads after a write, which matters far more here.
    if (this.#cache) this.#cache.clear();
    return result;
  }

  async #send<T>(
    query: string,
    variables: Record<string, unknown>,
    authHeader?: Record<string, string>,
  ): Promise<T> {
    const body = JSON.stringify({ query, variables: stripUndefined(variables) });
    // AniList's rate-limit (429) and outage (403) responses carry a non-2xx
    // status, which lib/http.ts already turns into a retryable ApiError via
    // classifyStatus() before we ever see the body — no special-casing needed
    // here for those. This only has to handle 2xx responses that still carry
    // a GraphQL `errors[]` envelope (e.g. query/argument validation errors).
    const res = await this.#http.requestJson<GraphQLResponse<T>>("", {
      method: "POST",
      body,
      ...(authHeader ? { headers: authHeader } : {}),
    });
    if (res.errors?.length) {
      // Most inline errors[] entries carry no `status` (e.g. query/argument
      // validation) and stay classified as bad_request. Some do carry one
      // (e.g. a 404/401 embedded in a 200 response) — classify those the
      // same way a real HTTP status would be, so messageFor() (lib/result.ts)
      // gives its more specific not_found/unauthorized/etc. advice instead of
      // the generic "rejected as invalid" bad_request message. Only trust a
      // status when every entry that has one agrees — a response mixing an
      // unrelated statused error with a genuine unstatused validation error
      // shouldn't have the whole thing misclassified off the unrelated one.
      const statuses = new Set(
        res.errors.map((e) => e.status).filter((s): s is number => typeof s === "number"),
      );
      const status = statuses.size === 1 ? [...statuses][0] : undefined;
      const classified = status !== undefined ? classifyStatus(status) : undefined;
      throw new ApiError({
        code: classified?.code ?? "bad_request",
        status,
        retryable: classified?.retryable,
        message: res.errors.map(describeGraphQLError).join("; "),
      });
    }
    if (res.data === null || res.data === undefined) {
      throw new ApiError({ code: "unknown", message: "AniList returned no data for this query" });
    }
    return res.data;
  }
}

/** A validation error's `message` is just the generic label "validation" —
 *  append the actual per-field reasons from `validation` when present. */
function describeGraphQLError(err: GraphQLErrorEntry): string {
  if (!err.validation || Object.keys(err.validation).length === 0) return err.message;
  const detail = Object.entries(err.validation)
    .map(([field, msgs]) => `${field}: ${msgs.join(", ")}`)
    .join("; ");
  return `${err.message} (${detail})`;
}

/** Recursively drop `undefined` entries (one level of nesting is enough for
 *  AniList's variable shapes — plain objects like `startedAt`, arrays like
 *  `customLists`). Arrays are passed through as-is (their elements are
 *  scalars or already-clean objects, never `undefined` holes in practice). */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    out[key] =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? stripUndefined(value as Record<string, unknown>)
        : value;
  }
  return out;
}
