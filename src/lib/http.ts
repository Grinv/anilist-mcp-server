// Thin fetch wrapper shared by both API clients: timeouts, bounded retries
// with exponential backoff, a default User-Agent, and uniform mapping of
// failures to ApiError. A Retry-After longer than MAX_BACKOFF_MS is not waited
// out: the error surfaces with retryAfterMs, so the caller learns when to retry.
import { ApiError, classifyStatus } from "./errors.ts";
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
  signal?: AbortSignal;
}

export interface HttpClientOptions {
  baseUrl: string;
  logger: Logger;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Called before each request; lets callers throttle (rate limiting). */
  beforeRequest?: () => Promise<void> | void;
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
      if (this.#opts.beforeRequest) await this.#opts.beforeRequest();
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
        await delay(backoff);
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
      if (options.signal?.aborted) {
        return new ApiError({
          code: "cancelled",
          message: "Request cancelled by the caller",
          cause: err,
        });
      }
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
  // Prefer a structured `message`/`error` field; for an HTML page (e.g.
  // Cloudflare's WAF block on AniList) just its <title>, not the markup; a
  // short plain-text body as is. Anything else stays in the log message only.
  const detail =
    parseErrorMessage(raw) ??
    htmlTitle(raw) ??
    (raw && !/^\s*</.test(raw) && raw.length <= 200 ? raw.trim() : undefined);
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
  // `statusText` is only appended when it's actually there: it comes back
  // empty over HTTP/2 (and through some proxies), which would otherwise
  // leave a stray space before the colon — confirmed live via an MCP client
  // whose server process saw an empty statusText: "HTTP 404 : Not Found."
  const statusLabel = res.statusText
    ? `HTTP ${res.status} ${res.statusText}`
    : `HTTP ${res.status}`;
  return new ApiError({
    code: classifyStatus(res.status, raw),
    status: res.status,
    authenticated,
    detail,
    retryAfterMs: retryAfter,
    message: raw ? `${statusLabel}: ${detail ?? raw.slice(0, 500)}` : statusLabel,
  });
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
function parseErrorMessage(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const obj: unknown = JSON.parse(raw);
    if (obj === null || typeof obj !== "object") return undefined;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.message === "string") return rec.message;
    if (typeof rec.error === "string") return rec.error;
    if (Array.isArray(rec.errors) && rec.errors.length > 0) {
      const first = rec.errors[0] as Record<string, unknown>;
      const message = typeof first.message === "string" ? first.message : undefined;
      const validation =
        first.validation !== null && typeof first.validation === "object"
          ? Object.entries(first.validation as Record<string, unknown>)
              .map(
                ([field, msgs]) =>
                  `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : String(msgs)}`,
              )
              .join("; ")
          : undefined;
      if (message && validation) return `${message} (${validation})`;
      return message ?? validation;
    }
    return undefined;
  } catch {
    return undefined; // not JSON — caller falls back to the raw body
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
