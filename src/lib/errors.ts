// Typed errors. Clients throw `ApiError` for an upstream failure (facts only:
// code, status, AniList's own reason) and `ToolError` for a decision this
// server makes itself (an argument check, a missing login). Tool-facing text
// is written in one place, lib/result.ts; `message` is for logs only and may
// hold a raw response body.

export type ApiErrorCode =
  | "unauthorized" // 401, token missing/expired/invalid
  | "forbidden" // 403, a real permission denial
  | "unavailable" // 403, AniList's "API temporarily disabled" outage notice
  | "blocked" // 403, Cloudflare's WAF page (e.g. an injection-shaped search term)
  | "not_found" // 404, or a lookup that resolved to null
  | "rate_limited" // 429
  | "server_error" // 5xx
  | "network" // connection failed
  | "timeout" // request aborted by our timeout
  | "cancelled" // request aborted by the caller (MCP notifications/cancelled); never sent
  | "bad_request" // 400/405/422, malformed or unsupported request
  | "bad_response" // a success status with a body we can't use (invalid JSON, empty, data:null)
  | "unknown"; // any other upstream status

export interface ApiErrorOptions {
  code: ApiErrorCode;
  /** For logs only; may hold a raw response body. Defaults to `note`. */
  message?: string;
  /** AniList's own (short) reason, e.g. a GraphQL errors[].message with its
   *  validation details or an HTML page's <title>, for the tool-facing text. */
  detail?: string;
  /** This server's own sentence about the occurrence (e.g. which id wasn't
   *  found), shown as is — never attributed to AniList like `detail`. */
  note?: string;
  status?: number;
  /** Override KIND[code].transient for one occurrence. */
  retryable?: boolean;
  /** Retry-After hint, in ms. */
  retryAfterMs?: number;
  cause?: unknown;
  /** Whether the request carried an Authorization header: a 401 with no
   *  token sent ("log in") needs different advice than one with a token. */
  authenticated?: boolean;
  /** Set on a mutation that failed with a timeout, network error or 5xx:
   *  AniList may still have applied it. */
  writeMayHaveApplied?: boolean;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly detail: string | undefined;
  readonly note: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly authenticated: boolean | undefined;
  readonly writeMayHaveApplied: boolean;

  // Kept whole, so a copy can't silently drop a field added later.
  readonly #opts: ApiErrorOptions;

  constructor(opts: ApiErrorOptions) {
    super(
      opts.message ?? opts.note ?? opts.code,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = "ApiError";
    this.#opts = opts;
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? KIND[opts.code].transient;
    this.detail = opts.detail;
    this.note = opts.note;
    this.retryAfterMs = opts.retryAfterMs;
    this.authenticated = opts.authenticated;
    this.writeMayHaveApplied = opts.writeMayHaveApplied ?? false;
  }
  /** This error as `code` (default: its own), with this server's `note`. */
  withNote(note: string, code: ApiErrorCode = this.code): ApiError {
    // `message` (the log's diagnostics: status label, raw body) is kept.
    return new ApiError({ ...this.#opts, code, note, cause: this });
  }

  /** This error, marked as a write that AniList may still have applied. */
  withWriteOutcomeUnknown(): ApiError {
    return new ApiError({ ...this.#opts, writeMayHaveApplied: true, cause: this });
  }
}

/** `transient`: retrying soon can help, so HttpClient retries it and the
 *  tool's problem says so. A Record, so a new code can't lack an entry. */
const KIND: Record<ApiErrorCode, { transient: boolean }> = {
  unauthorized: { transient: false },
  forbidden: { transient: false },
  // AniList switches its API off for hours during an outage; a retry within
  // seconds can't help (docs/api-references.md).
  unavailable: { transient: false },
  blocked: { transient: false }, // the same request content is blocked again
  not_found: { transient: false },
  rate_limited: { transient: true },
  server_error: { transient: true },
  network: { transient: true },
  timeout: { transient: true },
  cancelled: { transient: false }, // the caller's own decision
  bad_request: { transient: false },
  bad_response: { transient: false },
  unknown: { transient: false },
};

/** A failure this server decides on itself, with its own tool-facing sentence. */
export type ToolErrorCode = "invalid_arguments" | "login_required" | "not_configured";

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  /** AniList's own reason, when this server's decision rests on an AniList
   *  answer; quoted like ApiError.detail. */
  readonly detail: string | undefined;

  constructor(
    code: ToolErrorCode,
    sentence: string,
    options?: { cause?: unknown; detail?: string },
  ) {
    super(sentence, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolError";
    this.code = code;
    this.detail = options?.detail;
  }
}

/** Map an HTTP status and AniList's parsed reason to an ApiErrorCode. A
 *  non-JSON body (the edge's block page) is `blocked`, decided by lib/http.ts
 *  before this runs, since only it sees the raw body. */
export function classifyStatus(status: number, reason = ""): ApiErrorCode {
  // `reason` is AniList's parsed reason (errors[].message, or an HTML page's
  // <title>), never the raw body, so a value echoed back in it can't reclassify.
  if (status === 401) return "unauthorized";
  if (status === 403) {
    // Anchored to AniList's exact wording, so a value echoed in validation
    // details further along the reason can't match.
    if (/^The AniList API has been temporarily disabled/i.test(reason)) return "unavailable";
    return "forbidden";
  }
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  // AniList answers a bad or expired token with 400 "Invalid token", not 401
  // (confirmed live 2026-11-27): it is a credentials problem, not a bad request.
  if (status === 400 && /^Invalid token\b/.test(reason)) return "unauthorized";
  if (status === 400 || status === 405 || status === 422) return "bad_request";
  if (status >= 500) return "server_error";
  return "unknown";
}

/** For a create/update mutation whose result should be the saved object:
 *  AniList answering null instead is its answer, not a result, so whether it
 *  saved is unknown (bad_response, outcome unknown) — never "applied", never
 *  this server's bug. Mutations where null means something (an empty batch, a
 *  toggle's "can't tell") handle it themselves. */
export function assertWritten<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new ApiError({
      code: "bad_response",
      message: `AniList answered ${what} with a null result`,
      writeMayHaveApplied: true,
    });
  }
  return value;
}

/** Throw a standard not-found ApiError if an upstream single-resource lookup
 *  resolved to `null` instead of the resource — AniList's GraphQL layer does
 *  this for some singular fields (e.g. a nested `Media(id){ recommendations }`
 *  lookup) even where a sibling top-level query for the same ID reliably
 *  errors with a real HTTP 404 instead. */
export function assertFound<T>(value: T | null | undefined, sentence: string): T {
  if (value === null || value === undefined) {
    throw new ApiError({ code: "not_found", note: sentence });
  }
  return value;
}

/** Strip anything that looks like a credential before logging. */
export function redact(input: string): string {
  return (
    input
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
      .replace(/\b(access_token|refresh_token|client_secret|client_id)=([^&\s"]+)/gi, "$1=***")
      .replace(
        /"(access_token|refresh_token|client_secret|client_id)"\s*:\s*"[^"]*"/gi,
        '"$1":"***"',
      )
      // The same field as util.inspect prints it (the logger's object form).
      .replace(/\b(access_token|refresh_token|client_secret|client_id): '[^']*'/gi, "$1: '***'")
      // A bare JWT (AniList access tokens are JWTs): three base64url segments.
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "***")
  );
}
