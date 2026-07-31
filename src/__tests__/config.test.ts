import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

test("no credentials → cannot log in, defaults apply", () => {
  const c = loadConfig({});
  assert.equal(c.auth.canLogin, false);
  assert.equal(c.auth.accessToken, undefined);
  assert.equal(c.graphqlUrl, "https://graphql.anilist.co");
});

test("access token only → token is read, but cannot start a login", () => {
  const c = loadConfig({ ANILIST_ACCESS_TOKEN: "tok" });
  assert.equal(c.auth.accessToken, "tok");
  assert.equal(c.auth.canLogin, false);
});

test("client id + secret → can log in", () => {
  const c = loadConfig({ ANILIST_CLIENT_ID: "id", ANILIST_CLIENT_SECRET: "secret" });
  assert.equal(c.auth.canLogin, true);
  assert.equal(c.auth.accessToken, undefined);
});

test("client id alone (no secret) → cannot log in", () => {
  const c = loadConfig({ ANILIST_CLIENT_ID: "id" });
  assert.equal(c.auth.canLogin, false);
});

test("empty-string values are treated as unset (mcpb passes unset config as '')", () => {
  const c = loadConfig({ ANILIST_ACCESS_TOKEN: "", ANILIST_CLIENT_ID: "", LOG_LEVEL: "" });
  assert.equal(c.auth.accessToken, undefined);
  assert.equal(c.logLevel, "info"); // default still applies
});

test("unsubstituted .mcpb placeholders are treated as unset", () => {
  // An unfilled optional field arrives as the literal "${user_config.X}".
  const c = loadConfig({
    ANILIST_ACCESS_TOKEN: "${user_config.anilist_access_token}",
    ANILIST_CLIENT_ID: "${user_config.anilist_client_id}",
  });
  // Must NOT be taken as real credentials, or tools would try to authenticate
  // with garbage.
  assert.equal(c.auth.accessToken, undefined);
  assert.equal(c.auth.clientId, undefined);
});

test("numeric env vars are coerced", () => {
  const c = loadConfig({ HTTP_TIMEOUT_MS: "5000", ANILIST_MIN_INTERVAL_MS: "0" });
  assert.equal(c.httpTimeoutMs, 5000);
  assert.equal(c.minIntervalMs, 0);
});

test("oauth callback port defaults to 8082 and is overridable", () => {
  assert.equal(loadConfig({}).oauthPort, 8082);
  assert.equal(loadConfig({ ANILIST_OAUTH_PORT: "9123" }).oauthPort, 9123);
});
