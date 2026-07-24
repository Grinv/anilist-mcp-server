import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, type ApiErrorCode } from "../lib/errors.js";
import { apiErrorToResult, errorResult, jsonResult } from "../lib/result.js";

test("jsonResult carries both text and structuredContent", () => {
  const r = jsonResult({ a: 1 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, { a: 1 });
  assert.match(r.content[0]!.text, /"a":1/); // compact, no pretty-print whitespace
});

test("errorResult sets content and isError flag", () => {
  const e = errorResult("bad");
  assert.equal(e.isError, true);
  assert.equal(e.content[0]!.text, "bad");
});

test("apiErrorToResult produces an actionable message per error code", () => {
  // `expectDetail` tracks whether this code's branch must surface the
  // caller's actual `err.message` verbatim, not just a generic templated
  // string — regression test for not_modified/rate_limited/server_error/
  // network/timeout, which used to silently discard it (unlike not_found/
  // bad_request/unknown, which already did). `forbidden` deliberately stays
  // generic (see the two dedicated tests below) since its whole point is
  // explaining that the real cause is ambiguous, not echoing upstream detail.
  const cases: [ApiErrorCode, RegExp, boolean][] = [
    // A real upstream 401 (status set) gets the generic templated text.
    ["forbidden", /denied access/i, false],
    ["not_found", /no matching resource|404/i, true],
    ["not_modified", /not changed|304/i, true],
    ["rate_limited", /rate limit/i, true],
    ["server_error", /5xx|retry later/i, true],
    ["network", /network/i, true],
    ["timeout", /timed out/i, true],
    ["bad_request", /invalid/i, true],
    ["unknown", /unexpected/i, true],
  ];
  for (const [code, re, expectDetail] of cases) {
    const r = apiErrorToResult(new ApiError({ code, message: "detail" }));
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, re);
    if (expectDetail) {
      assert.match(
        r.content[0]!.text,
        /detail/,
        `${code} must surface the caller's actual err.message ("detail"), not just a generic string`,
      );
    }
  }
});

test("apiErrorToResult: a real upstream 401 with a token sent may be invalid/expired or just not permitted", () => {
  const r = apiErrorToResult(
    new ApiError({ code: "unauthorized", message: "detail", status: 401, authenticated: true }),
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /invalid or expired/i);
});

test("apiErrorToResult: a real upstream 401 with no token sent asks the caller to log in", () => {
  const r = apiErrorToResult(
    new ApiError({ code: "unauthorized", message: "detail", status: 401, authenticated: false }),
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /login_anilist/i);
});

test("apiErrorToResult: a 403 with a token sent doesn't blame account permission alone", () => {
  const r = apiErrorToResult(
    new ApiError({ code: "forbidden", message: "detail", status: 403, authenticated: true }),
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /account may lack permission/i);
  assert.match(r.content[0]!.text, /security block/i);
});

test("apiErrorToResult: a 403 with no token sent doesn't blame credentials", () => {
  const r = apiErrorToResult(new ApiError({ code: "forbidden", message: "detail", status: 403 }));
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /anonymous request/i);
});

test("apiErrorToResult: a client-side pre-flight unauthorized (no status) keeps its own specific message", () => {
  const r = apiErrorToResult(
    new ApiError({ code: "unauthorized", message: "Run login_anilist first." }),
  );
  assert.equal(r.isError, true);
  assert.equal(r.content[0]!.text, "Run login_anilist first.");
});
