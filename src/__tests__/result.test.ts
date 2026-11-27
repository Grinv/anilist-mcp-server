import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, ToolError } from "../lib/errors.ts";
import {
  jsonResult,
  problemResult,
  toProblem,
  PROBLEM_CODES,
  PROBLEM_META_KEY,
  type Problem,
} from "../lib/result.ts";
import type { Logger } from "../lib/logger.ts";
import { silentLogger } from "./helpers.ts";

const TYPE_BASE = "https://github.com/Grinv/anilist-mcp-server/blob/main/docs/errors.md#";

/** A logger that records each call as [level, joined text]. */
function recordingLogger(): Logger & { lines: [string, string][] } {
  const lines: [string, string][] = [];
  const rec =
    (level: string) =>
    (msg: string, ...args: unknown[]) =>
      lines.push([
        level,
        [msg, ...args.map((a) => (a instanceof Error ? a.message : String(a)))].join(" "),
      ]);
  return { lines, debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") };
}

const problem = (err: unknown) => toProblem(err, silentLogger());

test("jsonResult carries both text and structuredContent", () => {
  const r = jsonResult({ a: 1 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, { a: 1 });
  assert.match(r.content[0]!.text, /"a":1/); // compact, no pretty-print whitespace
});

test("problemResult: the text is the detail, the problem rides in _meta, no structuredContent", () => {
  const p = problem(new ApiError({ code: "not_found", status: 404, message: "x" }));
  const r = problemResult(p);
  assert.equal(r.isError, true);
  assert.equal(r.content[0]!.text, p.detail);
  assert.deepEqual(r._meta, { [PROBLEM_META_KEY]: p });
  assert.equal("structuredContent" in r, false);
  assert.equal(PROBLEM_META_KEY, "io.github.Grinv.anilist-mcp-server/problem");
});

test("an upstream 404 with AniList's reason: exact text and fields", () => {
  const err = new ApiError({
    code: "not_found",
    status: 404,
    detail: "Not Found.",
    message: "HTTP 404: raw",
  });
  assert.deepEqual(problem(err), {
    type: TYPE_BASE + "not_found",
    title: "No matching resource was found",
    detail: 'No matching resource was found (404). AniList said: "Not Found."',
    retryable: false,
    upstream_status: 404,
  } satisfies Problem);
});

test("a 429 with Retry-After: retryable, retry_after_seconds, and the text says when", () => {
  const p = problem(
    new ApiError({ code: "rate_limited", status: 429, retryAfterMs: 56_200, message: "x" }),
  );
  assert.equal(p.retryable, true);
  assert.equal(p.retry_after_seconds, 57);
  assert.equal(p.detail, "AniList is rate-limiting requests (429). Please retry in 57 s.");
});

test("a transient failure without a hint says to retry later; the raw message never shows", () => {
  const p = problem(
    new ApiError({ code: "server_error", status: 502, message: "<html>secret body</html>" }),
  );
  assert.equal(p.detail, "AniList returned a server error (502). Please retry later.");
  assert.equal(p.retryable, true);
});

test("a validation error keeps AniList's own wording (tool descriptions quote it)", () => {
  const p = problem(
    new ApiError({
      code: "bad_request",
      status: 400,
      detail: "validation (rowOrder: The selected row order is invalid.)",
      message: "x",
    }),
  );
  assert.equal(
    p.detail,
    'AniList rejected the request as invalid (400). AniList said: "validation (rowOrder: The ' +
      'selected row order is invalid.)"',
  );
});

test("a possibly-applied write says to re-read, not to retry, and is not retryable", () => {
  const p = problem(new ApiError({ code: "timeout", message: "x", writeMayHaveApplied: true }));
  assert.equal(p.retryable, false);
  assert.match(p.detail, /outcome is unknown/);
  assert.match(p.detail, /repeating a toggle undoes it/);
  assert.doesNotMatch(p.detail, /retry later/);
});

test("a 401 with a token sent may be invalid/expired or just not permitted", () => {
  const p = problem(
    new ApiError({
      code: "unauthorized",
      status: 401,
      authenticated: true,
      detail: "Invalid token",
      message: "x",
    }),
  );
  assert.match(p.detail, /invalid or expired/);
  assert.match(p.detail, /not permitted/);
  assert.match(p.detail, /AniList said: "Invalid token"/);
});

test("a 401 with no token sent asks the caller to log in", () => {
  const p = problem(
    new ApiError({ code: "unauthorized", status: 401, authenticated: false, message: "x" }),
  );
  assert.match(p.detail, /run login_anilist/);
  assert.doesNotMatch(p.detail, /invalid or expired/);
});

test("the three kinds of 403 get their own type and advice", () => {
  const outage = problem(new ApiError({ code: "unavailable", status: 403, message: "x" }));
  assert.equal(outage.type, TYPE_BASE + "unavailable");
  assert.match(outage.detail, /outage on AniList's side/);
  const waf = problem(new ApiError({ code: "blocked", status: 403, message: "x" }));
  assert.equal(waf.type, TYPE_BASE + "blocked");
  assert.match(waf.detail, /Cloudflare/);
  assert.match(waf.detail, /Simplify the request/);
  const denied = problem(new ApiError({ code: "forbidden", status: 403, message: "x" }));
  assert.equal(denied.type, TYPE_BASE + "forbidden");
  for (const p of [outage, waf, denied]) assert.equal(p.upstream_status, 403);
});

test("a ToolError's sentence is the detail", () => {
  const p = problem(new ToolError("login_required", "No token: run login_anilist first."));
  assert.deepEqual(p, {
    type: TYPE_BASE + "login_required",
    title: "This tool needs an AniList login",
    detail: "No token: run login_anilist first.",
    retryable: false,
  });
});

test("AniList's reason is redacted before it reaches the text", () => {
  const p = problem(
    new ApiError({ code: "bad_request", detail: "bad header Bearer abc.def.ghi", message: "x" }),
  );
  assert.doesNotMatch(p.detail, /abc\.def\.ghi/);
});

test("anything else is internal: stable text, logged at error with the error", () => {
  const logger = recordingLogger();
  const p = toProblem(new TypeError("cannot read x of undefined"), logger);
  assert.equal(p.type, TYPE_BASE + "internal");
  assert.equal(
    p.detail,
    "Internal error in anilist-mcp-server. Details are in the server log (stderr); please report it.",
  );
  assert.deepEqual(
    logger.lines.map(([level]) => level),
    ["error"],
  );
  assert.match(logger.lines[0]![1], /cannot read x of undefined/);
});

test("unknown and bad_response log their raw message at warn; other upstream codes at debug", () => {
  const logger = recordingLogger();
  toProblem(new ApiError({ code: "unknown", status: 418, message: "HTTP 418: teapot" }), logger);
  toProblem(new ApiError({ code: "bad_response", message: "invalid JSON: <html>" }), logger);
  toProblem(new ApiError({ code: "not_found", message: "HTTP 404" }), logger);
  toProblem(new ApiError({ code: "cancelled", message: "cancelled" }), logger);
  assert.deepEqual(
    logger.lines.map(([level]) => level),
    ["warn", "warn", "debug", "debug"],
  );
  assert.match(logger.lines[0]![1], /teapot/);
});

// Each problem's `type` URI points at docs/errors.md#<code>; a code without a
// section would be a dead link. `cancelled` is never sent (the SDK drops the
// result of a cancelled request), so it has no section.
test("docs/errors.md has a section for exactly every problem type but cancelled", () => {
  const doc = readFileSync(join(import.meta.dirname, "../../docs/errors.md"), "utf8");
  const sections = [...doc.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(sections.sort(), PROBLEM_CODES.filter((c) => c !== "cancelled").sort());
});

test("a ToolError resting on AniList's answer quotes it like an ApiError does, redacted", () => {
  const p = toProblem(
    new ToolError("not_configured", "AniList rejected this app's credentials.", {
      detail: "Client authentication failed (client_secret=abc123)",
    }),
    silentLogger(),
  );
  assert.equal(p.type.split("#")[1], "not_configured");
  assert.match(p.detail, /^AniList rejected this app's credentials\. AniList said: "Client/);
  assert.doesNotMatch(p.detail, /abc123/);
});

test("retry_after_seconds appears only beside retryable: true", () => {
  const write = toProblem(
    new ApiError({
      code: "server_error",
      status: 503,
      retryAfterMs: 30_000,
      writeMayHaveApplied: true,
    }),
    silentLogger(),
  );
  assert.equal(write.retryable, false);
  assert.equal(write.retry_after_seconds, undefined);
  assert.doesNotMatch(write.detail, /retry in/i);
  const read = toProblem(
    new ApiError({ code: "rate_limited", status: 429, retryAfterMs: 30_000 }),
    silentLogger(),
  );
  assert.equal(read.retry_after_seconds, 30);
});

test("an anonymous 403 isn't blamed on the account", () => {
  const anon = toProblem(
    new ApiError({ code: "forbidden", status: 403, authenticated: false }),
    silentLogger(),
  );
  assert.match(anon.detail, /isn't an account permission problem/);
  const withToken = toProblem(
    new ApiError({ code: "forbidden", status: 403, authenticated: true }),
    silentLogger(),
  );
  assert.doesNotMatch(withToken.detail, /isn't an account permission problem/);
});

test("Retry-After: 0 adds no retry_after_seconds and no 'retry in 0 s'", () => {
  const p = toProblem(
    new ApiError({ code: "rate_limited", status: 429, retryAfterMs: 0 }),
    silentLogger(),
  );
  assert.equal(p.retryable, true);
  assert.equal(p.retry_after_seconds, undefined);
  assert.match(p.detail, /Please retry later\./);
});
