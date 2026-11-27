import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, classifyStatus, redact } from "../lib/errors.ts";

test("classifyStatus maps HTTP codes to error codes, and ApiError defaults retryable per code", () => {
  assert.equal(classifyStatus(401), "unauthorized");
  assert.equal(classifyStatus(403), "forbidden");
  assert.equal(classifyStatus(404), "not_found");
  assert.equal(classifyStatus(304), "unknown");
  assert.equal(classifyStatus(405), "bad_request");
  assert.equal(classifyStatus(422), "bad_request");
  assert.equal(classifyStatus(429), "rate_limited");
  assert.equal(classifyStatus(503), "server_error");
  assert.equal(new ApiError({ code: "unauthorized", message: "" }).retryable, false);
  assert.equal(new ApiError({ code: "rate_limited", message: "" }).retryable, true);
  assert.equal(new ApiError({ code: "server_error", message: "" }).retryable, true);
  assert.equal(new ApiError({ code: "unavailable", message: "" }).retryable, false);
  assert.equal(new ApiError({ code: "cancelled", message: "" }).retryable, false);
  assert.equal(
    new ApiError({ code: "server_error", message: "", retryable: false }).retryable,
    false,
  );
});

test("classifyStatus tells AniList's three kinds of 403 apart by body", () => {
  // AniList's outage notice (docs/api-references.md, verbatim shape).
  const outage = JSON.stringify({
    errors: [
      {
        message:
          "The AniList API has been temporarily disabled due to severe stability issues. " +
          "Please check the official AniList Discord for updates.",
        status: 403,
      },
    ],
    data: null,
  });
  assert.equal(classifyStatus(403, outage), "unavailable");
  // Cloudflare's WAF page (confirmed live for the search term `"OR 1=1 --`).
  const waf =
    '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n' +
    "<head>\n<title>Attention Required! | Cloudflare</title>\n</head><body>…</body></html>";
  assert.equal(classifyStatus(403, waf), "blocked");
  const denied = JSON.stringify({ errors: [{ message: "Forbidden.", status: 403 }], data: null });
  assert.equal(classifyStatus(403, denied), "forbidden");
});

test("redact removes bearer tokens and credential params", () => {
  assert.equal(redact("Authorization: Bearer abc.def-123=="), "Authorization: Bearer ***");
  assert.match(redact("grant&refresh_token=SECRET&x=1"), /refresh_token=\*\*\*/);
  assert.ok(!redact("client_secret=zzz999").includes("zzz999"));
  assert.ok(!redact("access_token=TOK").includes("TOK"));
});

test("redact removes JSON-style credentials (the OAuth token exchange body's shape)", () => {
  const body = '{"client_secret":"SUPERSECRET","client_id":"abc123"}';
  const result = redact(body);
  assert.ok(!result.includes("SUPERSECRET"));
  assert.ok(!result.includes("abc123"));
  assert.match(result, /"client_secret":"\*\*\*"/);
  assert.match(result, /"client_id":"\*\*\*"/);
});

test("redact masks a bare JWT (AniList's token format) and inspect-style credential fields", () => {
  // Header {"alg":"RS256","typ":"JWT"}, a payload and a signature, base64url.
  const jwt =
    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiIxMjM0NSIsImV4cCI6MTc5MDAwMDAwMH0." +
    "c2lnbmF0dXJlX2J5dGVzLV9oZXJl";
  assert.equal(redact(`token ${jwt} stored`), "token *** stored");
  assert.equal(redact("{ access_token: 'TOK' }"), "{ access_token: '***' }");
  assert.equal(redact("eyJ alone is fine"), "eyJ alone is fine");
});

test("AniList's 400 'Invalid token' is a credentials problem, not a bad request", () => {
  // The body AniList returns for a bad or expired token (captured live 2026-11-27).
  const body = '{"data":null,"errors":[{"message":"Invalid token","status":400}]}';
  assert.equal(classifyStatus(400, body), "unauthorized");
  assert.equal(classifyStatus(400, "Invalid token"), "unauthorized"); // a 200's embedded errors[]
  assert.equal(classifyStatus(400, '{"errors":[{"message":"validation"}]}'), "bad_request");
});
