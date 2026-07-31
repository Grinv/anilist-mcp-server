import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore, defaultTokenStorePath } from "../lib/tokenStore.js";
import { silentLogger } from "./helpers.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "anilist-mcp-server-tokenstore-test-"));
}

test("load() returns undefined when the file doesn't exist yet", () => {
  const dir = tempDir();
  try {
    const store = new TokenStore(join(dir, "tokens.json"), silentLogger());
    assert.equal(store.load(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load() returns undefined and warns when the file isn't valid JSON", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "tokens.json");
    writeFileSync(path, "not json at all {{{", "utf8");
    const store = new TokenStore(path, silentLogger());
    assert.equal(store.load(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load() returns undefined and warns when the JSON is valid but missing required fields", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "tokens.json");
    writeFileSync(path, JSON.stringify({ accessToken: "tok" }), "utf8"); // missing expiresAt
    const store = new TokenStore(path, silentLogger());
    assert.equal(store.load(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load() tolerates extra unknown fields (forward-compat)", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "tokens.json");
    writeFileSync(
      path,
      JSON.stringify({ accessToken: "tok", expiresAt: 123, futureField: "x" }),
      "utf8",
    );
    const store = new TokenStore(path, silentLogger());
    assert.deepEqual(store.load(), { accessToken: "tok", expiresAt: 123, futureField: "x" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save() then load() round-trips the exact state, across a fresh TokenStore instance", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "tokens.json");
    const state = { accessToken: "abc123", expiresAt: 1999999999000 };
    new TokenStore(path, silentLogger()).save(state);
    // A fresh instance (simulating a process restart) must read back the same state.
    assert.deepEqual(new TokenStore(path, silentLogger()).load(), state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "save() creates the file with 0600 permissions (POSIX only)",
  { skip: process.platform === "win32" },
  () => {
    const dir = tempDir();
    try {
      const path = join(dir, "tokens.json");
      new TokenStore(path, silentLogger()).save({ accessToken: "tok", expiresAt: 1 });
      const mode = statSync(path).mode & 0o777;
      assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "save() re-tightens 0600 when overwriting a pre-existing looser file (POSIX only)",
  { skip: process.platform === "win32" },
  () => {
    const dir = tempDir();
    try {
      const path = join(dir, "tokens.json");
      // Simulate a tokens.json left world-readable by a backup/older tool.
      writeFileSync(path, JSON.stringify({ accessToken: "old", expiresAt: 1 }));
      chmodSync(path, 0o644);
      new TokenStore(path, silentLogger()).save({ accessToken: "new", expiresAt: 2 });
      const mode = statSync(path).mode & 0o777;
      assert.equal(mode, 0o600, `expected mode 0600 after overwrite, got ${mode.toString(8)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("save() creates missing parent directories", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "nested", "deep", "tokens.json");
    new TokenStore(path, silentLogger()).save({ accessToken: "tok", expiresAt: 1 });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { accessToken: "tok", expiresAt: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultTokenStorePath honors ANILIST_TOKEN_STORE above any OS convention", () => {
  const custom = "/custom/path/tokens.json";
  assert.equal(defaultTokenStorePath({ ANILIST_TOKEN_STORE: custom }), custom);
});

test("defaultTokenStorePath falls back to XDG_CONFIG_HOME (or APPDATA on Windows) when no override is set", () => {
  const path =
    process.platform === "win32"
      ? defaultTokenStorePath({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" })
      : defaultTokenStorePath({ XDG_CONFIG_HOME: "/home/test/.config" });
  assert.match(path, /anilist-mcp-server[/\\]tokens\.json$/);
});
