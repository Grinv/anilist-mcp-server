import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizeUrl,
  extractCode,
  decodeJwtExpiry,
  listenForCode,
} from "../lib/oauthLogin.js";
import { ApiError } from "../lib/errors.js";

test("buildAuthorizeUrl has no PKCE params (AniList's Authorization Code grant doesn't use it)", () => {
  const url = new URL(
    buildAuthorizeUrl({
      oauthBaseUrl: "https://anilist.co/api/v2/oauth",
      clientId: "abc",
      redirectUri: "http://localhost:8082/callback",
      state: "s",
    }),
  );
  assert.equal(url.pathname, "/api/v2/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "abc");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8082/callback");
  assert.equal(url.searchParams.get("state"), "s");
  assert.equal(url.searchParams.get("code_challenge"), null);
  assert.equal(url.searchParams.get("code_challenge_method"), null);
});

test("extractCode handles a full redirect URL, a bare query, and a bare code", () => {
  assert.equal(extractCode("http://localhost:8082/callback?code=XYZ&state=s"), "XYZ");
  assert.equal(extractCode("?code=XYZ&state=s"), "XYZ");
  assert.equal(extractCode("XYZ"), "XYZ");
});

test("extractCode throws on an error redirect or a missing code", () => {
  assert.throws(() => extractCode("http://localhost:8082/callback?error=access_denied"), /denied/i);
  assert.throws(() => extractCode("http://localhost:8082/callback?state=s"), /no `code`/i);
});

test("extractCode throws ApiError (bad_request), not a plain Error — so guard() gives a clean message instead of falling into its generic 'Unexpected error' catch-all", () => {
  const isBadRequest = (err: unknown) => err instanceof ApiError && err.code === "bad_request";
  assert.throws(
    () => extractCode("http://localhost:8082/callback?error=access_denied"),
    isBadRequest,
  );
  assert.throws(() => extractCode("http://localhost:8082/callback?state=s"), isBadRequest);
  assert.throws(() => extractCode(""), isBadRequest);
});

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

test("decodeJwtExpiry reads the exp claim and converts seconds to epoch ms", () => {
  const token = makeJwt({ exp: 1_800_000_000 });
  assert.equal(decodeJwtExpiry(token), 1_800_000_000 * 1000);
});

test("decodeJwtExpiry returns undefined for a malformed token or a missing exp", () => {
  assert.equal(decodeJwtExpiry("not-a-jwt"), undefined);
  assert.equal(decodeJwtExpiry(makeJwt({ sub: "1" })), undefined);
});

test("listenForCode resolves with the code posted to its callback path", async () => {
  const port = 41823;
  let received: string | undefined;
  const { close } = await listenForCode({
    port,
    path: "/callback",
    onCode: (code) => {
      received = code;
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=ABC123`);
    assert.equal(res.status, 200);
    assert.equal(received, "ABC123");
  } finally {
    close();
  }
});
