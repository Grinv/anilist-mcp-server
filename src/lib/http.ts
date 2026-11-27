// Thin fetch wrapper shared by both API clients: timeouts, bounded retries
// with exponential backoff, a default User-Agent, and uniform mapping of
// failures to ApiError. A Retry-After longer than MAX_BACKOFF_MS is not waited
// out: the error surfaces with retryAfterMs, so the caller learns when to retry.
import { ApiError, classifyStatus, describeAniListErrors } from "./errors.ts";
import { cancelledError, sleep } from "./cancel.ts";
import type { Logger } from "./logger.ts";
import { USER_AGENT } from "../version.ts";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Already-serialized request body (e.g. URLSearchParams string or JSON). */
  body?: string;
  timeoutMs?: number;
  /** Max retry attempts for retryable failures (network/timeout/5xx/429). */
  retries?: number;
  /** For a request that changes state: retry only a 429, which the server
   *  rejected before acting. A timeout, network error or 5xx may have been
   *  applied, so replaying one could apply it twice. */
  nonIdempotent?: boolean;
  /** The caller's cancellation: aborts the fetch, the backoff and the
   *  beforeRequest wait, and fails with `cancelled` (never retried). */
  signal?: AbortSignal;
}

export interface HttpClientOptions {
  baseUrl: string;
  logger: Logger;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Called before each request; lets callers throttle (rate limiting). */
  beforeRequest?: (signal?: AbortSignal) => Promise<void> | void;
}

const MAX_BACKOFF_MS = 8000;

export class HttpClient {
  readonly #opts: HttpClientOptions;

  constructor(opts: HttpClientOptions) {
    this.#opts = opts;
  }

  async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(
      path.replace(/^\//, ""),
      ensureTrailingSlash(this.#opts.baseUrl),
    ).toString();
    const retries = options.retries ?? this.#opts.retries ?? 2;
    const timeoutMs = options.timeoutMs ?? this.#opts.timeoutMs ?? 15000;

    let attempt = 0;
    for (;;) {
      if (this.#opts.beforeRequest) await this.#opts.beforeRequest(options.signal);
      try {
        return await this.#once<T>(url, options, timeoutMs);
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : toNetworkError(err);
        const retryable =
          apiErr.retryable &&
          (!options.nonIdempotent || apiErr.code === "rate_limited") &&
          (apiErr.retryAfterMs ?? 0) <= MAX_BACKOFF_MS;
        if (!retryable || attempt >= retries) throw apiErr;
        const backoff = backoffMs(attempt, apiErr);
        this.#opts.logger.debug(
          `retrying ${url} after ${backoff}ms (attempt ${attempt + 1}/${retries}, ${apiErr.code})`,
        );
        await sleep(backoff, options.signal);
        attempt += 1;
      }
    }
  }

  async #once<T>(url: string, options: RequestOptions, timeoutMs: number): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([timeoutSignal, options.signal])
      : timeoutSignal;

    const headers = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...this.#opts.defaultHeaders,
      ...options.headers,
    };

    // Which abort won, as an ApiError. fetch settles once the headers arrive,
    // so a stalled body aborts later, through the res.text() await.
    const abortError = (err: unknown): ApiError => {
      // fetch had started, so for a write the request may have reached AniList.
      if (options.signal?.aborted) return cancelledError(err, true, options.nonIdempotent === true);
      if (timeoutSignal.aborted) {
        return new ApiError({
          code: "timeout",
          message: `Request timed out after ${timeoutMs}ms`,
          cause: err,
        });
      }
      return toNetworkError(err);
    };

    let res: Response;
    let text: string;
    try {
      // Aborted before sending (e.g. right after the limiter): nothing left the process.
      if (options.signal?.aborted) throw cancelledError(undefined, false);
      res = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal,
      });
      if (!res.ok) throw await toHttpError(res, "Authorization" in headers);
      text = await res.text();
    } catch (err) {
      throw err instanceof ApiError ? err : abortError(err);
    }

    // A success status must carry JSON: an empty or non-JSON body (a proxy's
    // page) is unusable, and only the caller knows the expected shape.
    if (text.length === 0) {
      throw new ApiError({ code: "bad_response", message: "Upstream returned an empty body" });
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ApiError({
        code: "bad_response",
        message: `Upstream returned invalid JSON: ${text.slice(0, 500)}`,
        cause: err,
      });
    }
  }
}

async function toHttpError(res: Response, authenticated: boolean): Promise<ApiError> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    /* ignore body read errors */
  }
  // AniList's API always answers in JSON. Anything else (an HTML page, a
  // proxy's plain text) came from in front of it: its text isn't AniList's
  // reason, except a page's <title>, which names who blocked the request.
  // Either way the raw body stays in the log message only.
  const json = parseJson(raw);
  const detail = json ? parseErrorMessage(json.value) : htmlTitle(raw);
  // The edge's (Cloudflare's) block or challenge page: HTML, or its plain
  // "error code: 1020". Any other non-JSON 403 (empty, a proxy's text) is
  // classified like a JSON one, whose advice doesn't claim a firewall.
  const edgeBlock = !json && (/^\s*</.test(raw) || /^error code: \d+/i.test(raw.trim()));
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
  // `statusText` is only appended when it's actually there: it comes back
  // empty over HTTP/2 (and through some proxies), which would otherwise
  // leave a stray space before the colon — confirmed live via an MCP client
  // whose server process saw an empty statusText: "HTTP 404 : Not Found."
  const statusLabel = res.statusText
    ? `HTTP ${res.status} ${res.statusText}`
    : `HTTP ${res.status}`;
  return new ApiError({
    code: res.status === 403 && edgeBlock ? "blocked" : classifyStatus(res.status, detail),
    status: res.status,
    authenticated,
    detail,
    retryAfterMs: retryAfter,
    message: raw ? `${statusLabel}: ${detail ?? raw.slice(0, 500)}` : statusLabel,
  });
}

function parseJson(raw: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return undefined; // not JSON, empty included
  }
}

function htmlTitle(raw: string): string | undefined {
  if (!/^\s*</.test(raw)) return undefined;
  return /<title>([^<]*)<\/title>/i.exec(raw)?.[1]?.trim() || undefined;
}

// Many JSON APIs return an error envelope like { message } or { error }; GraphQL
// APIs (e.g. AniList) instead use { errors: [{ message, validation? }] } — the
// first error's `message` alone can be a generic label like "validation", with
// the actual per-field reasons nested under `validation` (e.g. AniList's
// `{message:"validation", validation:{score:["must be <= 100"]}}`), so surface
// both when present rather than just the unhelpful top-level label.
function parseErrorMessage(obj: unknown): string | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.message === "string") return rec.message;
  if (typeof rec.error === "string") return rec.error;
  return describeAniListErrors(rec.errors);
}

function toNetworkError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError({
    code: "network",
    message: err instanceof Error ? `Network error: ${err.message}` : "Network error",
    cause: err,
  });
}

function backoffMs(attempt: number, err: ApiError): number {
  // Only a hint within MAX_BACKOFF_MS gets here (requestJson doesn't retry a longer one).
  if (err.retryAfterMs !== undefined && err.retryAfterMs > 0) return err.retryAfterMs;
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
  return base + Math.floor(base * 0.25 * deterministicJitter(attempt));
}

// Jitter without Math.random: small deterministic spread by attempt index.
function deterministicJitter(attempt: number): number {
  return ((attempt * 2654435761) % 1000) / 1000;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : s + "/";
}
