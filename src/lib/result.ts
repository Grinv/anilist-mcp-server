// Builders for MCP tool results. Failures become { isError: true } results,
// never thrown, so the agent gets an actionable message instead of a protocol
// error.
import { ApiError, ToolError, redact, type ApiErrorCode, type ToolErrorCode } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { META_PREFIX, REPO_URL } from "../version.ts";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // Matches the SDK's CallToolResult index signature.
  [key: string]: unknown;
}

/** Success result carrying both a text mirror and structured data.
 *
 * The text is compact (no indentation): MCP clients that don't read
 * `structuredContent` fall back to this string and feed it to the model, so
 * pretty-print whitespace would be pure token overhead. */
export function jsonResult(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * A tool failure as an RFC 9457 problem details object. MCP has no HTTP
 * response, so RFC 9457's `status` is unused; AniList's status goes in the
 * `upstream_status` extension, `retryable` says whether trying again can help
 * and `retry_after_seconds` when. The model reads `detail` as the result
 * text; the whole object rides in `_meta`, since `structuredContent` is
 * reserved for data matching the tool's outputSchema.
 */
export interface Problem {
  type: string;
  title: string;
  detail: string;
  retryable: boolean;
  upstream_status?: number;
  retry_after_seconds?: number;
}

/** `_meta` key for the Problem on an error result, under this server's prefix. */
export const PROBLEM_META_KEY = `${META_PREFIX}problem`;

// Each problem type's URI points at its section in docs/errors.md.
const TYPE_BASE = `${REPO_URL}/blob/main/docs/errors.md#`;

type ProblemCode = ApiErrorCode | ToolErrorCode | "internal";

// One entry per problem type (a Record, so the compiler rejects a code
// without one). `title` is fixed per type, as RFC 9457 requires; no `advice`
// says "retry": that comes from the occurrence's `retryable`, so text and
// flag can't disagree.
const PROBLEMS: Record<ProblemCode, { title: string; advice?: string }> = {
  unauthorized: {
    title: "AniList rejected the request as unauthorized",
    // With a token sent. AniList also answers 401, not 403, for changing a
    // resource the account doesn't own, so don't blame the token outright.
    advice:
      "The token may be invalid or expired, but this can also mean the account isn't allowed " +
      "to perform this specific action (e.g. it doesn't own the resource being changed). Try " +
      "login_anilist for a fresh token; if the same request still fails, the action itself is " +
      "likely not permitted.",
  },
  forbidden: {
    title: "AniList denied access",
    advice: "The account (or an anonymous request) isn't permitted to do this.",
  },
  unavailable: {
    title: "AniList has temporarily disabled its API",
    advice:
      "This is an outage on AniList's side, not a problem with the request or the account. It " +
      "usually lasts hours, so try again much later; AniList posts updates on its Discord.",
  },
  blocked: {
    title: "AniList's firewall (Cloudflare) blocked the request",
    advice:
      "Something in the request, often unusual characters in a search term (quotes, SQL-like " +
      "text), triggered it; it isn't an account or token problem. Simplify the request.",
  },
  not_found: { title: "No matching resource was found" },
  rate_limited: { title: "AniList is rate-limiting requests" },
  server_error: { title: "AniList returned a server error" },
  network: { title: "Could not reach AniList (network error)", advice: "Check connectivity." },
  timeout: { title: "The AniList request timed out" },
  // Never reaches the client: the SDK sends nothing for a cancelled request.
  cancelled: { title: "The request was cancelled" },
  bad_request: { title: "AniList rejected the request as invalid" },
  bad_response: { title: "AniList returned an unreadable response" },
  unknown: { title: "Unexpected error talking to AniList" },
  internal: {
    title: "Internal error in anilist-mcp-server",
    advice: "Details are in the server log (stderr); please report it.",
  },
  invalid_arguments: { title: "Invalid arguments" },
  login_required: { title: "This tool needs an AniList login" },
  not_configured: { title: "AniList login is not configured" },
};

// A 401 to a request that carried no token at all.
const LOG_IN =
  "It requires an authenticated AniList account: run login_anilist (or set " +
  "ANILIST_ACCESS_TOKEN) first.";

// A timed-out or 5xx'd write may still have landed, and repeating it
// re-flips a Toggle* or posts a duplicate: no "please retry".
const OUTCOME_UNKNOWN =
  "The write's outcome is unknown: AniList may still have applied it. Re-read the affected " +
  "data before retrying — repeating a toggle undoes it, and repeating a post duplicates it.";

const RETRY = "Please retry later.";

/** Every problem type; each `type` URI's section (but cancelled's, which is
 *  never sent) must exist in docs/errors.md. */
export const PROBLEM_CODES = Object.keys(PROBLEMS) as ProblemCode[];

/**
 * The one place a failure becomes tool-facing text. An ApiError is described
 * by its code, status and AniList's own reason (`detail`), never by its
 * `message`, which may hold a raw response body. A ToolError carries its own
 * sentence. Anything else is a bug in this server: it is logged in full and
 * the caller gets a stable "internal error".
 */
export function toProblem(err: unknown, logger: Logger): Problem {
  if (err instanceof ToolError) return ownProblem(err.code, err.message);
  if (err instanceof ApiError) {
    logApiError(err, logger);
    const { title, advice } = PROBLEMS[err.code];
    // Retrying an outcome-unknown write is exactly what must not happen blindly.
    const retryable = err.retryable && !err.writeMayHaveApplied;
    const retryAfter =
      err.retryAfterMs === undefined ? undefined : Math.ceil(err.retryAfterMs / 1000);
    const status = err.status ? ` (${err.status})` : "";
    return {
      type: TYPE_BASE + err.code,
      title,
      detail: [
        `${title}${status}.`,
        err.code === "unauthorized" && !err.authenticated ? LOG_IN : advice,
        err.note,
        err.writeMayHaveApplied ? OUTCOME_UNKNOWN : undefined,
        retryable ? (retryAfter ? `Please retry in ${retryAfter} s.` : RETRY) : undefined,
        // One status can mean several things, so AniList's reason is always shown.
        err.detail ? `AniList said: "${redact(err.detail).slice(0, 500)}"` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      retryable,
      ...(err.status ? { upstream_status: err.status } : {}),
      ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
    };
  }
  // A tool error, not a JSON-RPC one: it arises while the tool runs, so the
  // model must see the call failed (MCP's isError rule). See docs/errors.md#internal.
  logger.error("internal error in a tool call:", err);
  return ownProblem("internal");
}

// The text no longer carries `message`, so the diagnostics that only it has
// (a raw body) go to the log: at warn for what nobody classified, else debug.
function logApiError(err: ApiError, logger: Logger): void {
  if (err.code === "unknown" || err.code === "bad_response") {
    logger.warn(`${err.code} from AniList: ${err.message}`);
  } else if (err.code === "cancelled") {
    logger.debug(`cancelled: ${err.message}`);
  } else {
    logger.debug(`${err.code} from AniList: ${err.message}`);
  }
}

/** A problem this server raises itself: its own sentence as `detail`, or the
 *  type's title and advice. */
function ownProblem(code: ToolErrorCode | "internal", detail?: string): Problem {
  const { title, advice } = PROBLEMS[code];
  return {
    type: TYPE_BASE + code,
    title,
    detail: detail ?? [`${title}.`, advice].filter(Boolean).join(" "),
    retryable: false,
  };
}

/** An isError tool result: the model reads `detail`; the Problem is `_meta`. */
export function problemResult(problem: Problem): ToolResult {
  return {
    content: [{ type: "text", text: problem.detail }],
    isError: true,
    _meta: { [PROBLEM_META_KEY]: problem },
  };
}
