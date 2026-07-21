// Helpers that build MCP tool results. Tool handlers return these objects;
// failures become { isError: true } results (never thrown) so the agent
// receives an actionable message instead of a protocol error.
import type { ApiError } from "./errors.js";

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

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Translate an upstream ApiError into a friendly, actionable tool error. */
export function apiErrorToResult(err: ApiError): ToolResult {
  return errorResult(messageFor(err));
}

function messageFor(err: ApiError): string {
  switch (err.code) {
    case "unauthorized":
      // A real upstream 401 (err.status is set by toHttpError()) gets one of
      // the two templated messages below, chosen by whether the request
      // actually carried a token — a 401 with no Authorization header sent
      // means "you need to log in", while a 401 with one sent means the
      // token itself may be bad OR the account simply isn't allowed to do
      // this specific thing (e.g. AniList returns 401, not 403, for
      // mutating a resource you don't own) — don't confidently blame the
      // token for that second case. A client-side pre-flight auth check (no
      // network round trip, so no status) instead carries its own specific,
      // actionable message (e.g. "run login_anilist") — use that verbatim
      // rather than discarding it for either template.
      if (err.status === undefined) return err.message;
      return err.authenticated
        ? "The upstream service rejected this request (401) even though a token was sent. " +
            "This can mean the token is invalid or expired, but it can also mean the " +
            "authenticated account isn't allowed to perform this specific action (e.g. it " +
            "doesn't own the resource being changed). Try login_anilist for a fresh token; if " +
            "the same request still fails, the action itself is likely not permitted here."
        : "The upstream service rejected this request (401): it requires an authenticated " +
            "AniList account. Run login_anilist (or set ANILIST_ACCESS_TOKEN) first.";
    case "forbidden":
      // Same reasoning as above: a 403 with no token sent isn't a
      // "credentials" problem at all (there were none) — it's more likely a
      // security block (e.g. a WAF rejecting an unusual query string) or a
      // transient upstream outage, so don't tell the caller to check an API
      // key that was never in play.
      return err.authenticated
        ? "The upstream service denied access (403). The authenticated account may lack " +
            "permission for this specific action."
        : "The upstream service denied access (403) to this anonymous request. Since no " +
            "credentials were involved, this isn't a permissions issue — it's more likely a " +
            "security block or a temporary upstream outage. Try simplifying the request or " +
            "retrying shortly.";
    case "not_found":
      return "No matching resource was found (404).";
    case "not_modified":
      return "The content has not changed since the last request (304).";
    case "rate_limited":
      return "Upstream rate limit hit (429). Please retry in a few seconds.";
    case "server_error":
      return "The upstream service returned an error (5xx). Please retry later.";
    case "network":
      return "Could not reach the upstream service (network error). Check connectivity and retry.";
    case "timeout":
      return "The upstream request timed out. Please retry.";
    case "bad_request":
      return `The request was rejected as invalid: ${err.message}`;
    default:
      return `Unexpected error talking to the upstream service: ${err.message}`;
  }
}
