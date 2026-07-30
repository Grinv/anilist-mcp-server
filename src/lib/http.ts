// Thin fetch wrapper shared by both API clients: timeouts, bounded retries
// with exponential backoff (honoring Retry-After), a default User-Agent, and
// uniform mapping of failures to ApiError.
import { ApiError, classifyStatus } from "./errors.js";
import type { Logger } from "./logger.js";
import { USER_AGENT } from "../version.js";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Already-serialized request body (e.g. URLSearchParams string or JSON). */
  body?: string;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  /** Max retry attempts for retryable failures (network/timeout/5xx/429). */
  retries?: number;
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

  async getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestJson<T>(path, { ...options, method: options.method ?? "GET" });
  }

  async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.#buildUrl(path, options.query);
    const retries = options.retries ?? this.#opts.retries ?? 2;
    const timeoutMs = options.timeoutMs ?? this.#opts.timeoutMs ?? 15000;

    let attempt = 0;
    for (;;) {
      if (this.#opts.beforeRequest) await this.#opts.beforeRequest();
      try {
        return await this.#once<T>(url, options, timeoutMs);
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : toNetworkError(err);
        if (!apiErr.retryable || attempt >= retries) throw apiErr;
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

    let res: Response;
    try {
      res = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal,
      });
    } catch (err) {
      if (options.signal?.aborted) {
        // Caller cancelled — propagate as a non-retryable abort.
        throw new ApiError({ code: "network", message: "Request aborted by caller", cause: err });
      }
      if (timeoutSignal.aborted) {
        throw new ApiError({
          code: "timeout",
          message: `Request timed out after ${timeoutMs}ms`,
          retryable: true,
          cause: err,
        });
      }
      throw toNetworkError(err);
    }

    if (!res.ok) throw await toHttpError(res, "Authorization" in headers);

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ApiError({
        code: "unknown",
        message: "Upstream returned invalid JSON",
        cause: err,
      });
    }
  }

  #buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.replace(/^\//, ""), ensureTrailingSlash(this.#opts.baseUrl));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

async function toHttpError(res: Response, authenticated: boolean): Promise<ApiError> {
  const { code, retryable } = classifyStatus(res.status);
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    /* ignore body read errors */
  }
  // Prefer a structured `message`/`error` field; fall back to the raw body.
  const detail = parseErrorMessage(raw) ?? raw.slice(0, 500);
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
  return new ApiError({
    code,
    status: res.status,
    retryable,
    authenticated,
    message: `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
    ...(retryAfter === undefined ? {} : { cause: { retryAfterMs: retryAfter } }),
  });
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
    retryable: true,
    cause: err,
  });
}

function backoffMs(attempt: number, err: ApiError): number {
  const hinted = (err.cause as { retryAfterMs?: number } | undefined)?.retryAfterMs;
  if (typeof hinted === "number" && hinted > 0) return Math.min(hinted, MAX_BACKOFF_MS);
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
  if (Number.isFinite(seconds)) return seconds * 1000;
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
