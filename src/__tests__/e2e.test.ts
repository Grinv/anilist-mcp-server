import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// The unit suite exercises the code via an in-memory transport against src. This
// e2e instead drives the REAL built bundle the way Claude Desktop does: a spawned
// `node dist/index.js` over stdio, run from an isolated dir with NO node_modules.
// It guards the integration boundary that earlier shipped bugs hid in — the bundle
// must start, complete the initialize handshake, register every tool, and run
// self-contained (a non-inlined dep would crash the child with ERR_MODULE_NOT_FOUND).
const distPath = join(process.cwd(), "..", "dist", "index.js");

// The server's registered tools. Keep in sync with src/tools/* — the count
// assertion below fails loudly if a tool is added/removed without updating it.
const EXPECTED_TOOLS = [
  "get_genres",
  "get_media_tags",
  "get_site_statistics",
  "get_studio",
  "toggle_favourite",
  "get_activity",
  "get_user_activity",
  "post_text_activity",
  "post_message_activity",
  "delete_activity",
  "get_user_list",
  "add_list_entry",
  "update_list_entry",
  "remove_list_entry",
  "get_media",
  "get_media_statistics",
  "get_media_characters",
  "get_media_staff",
  "get_media_reviews",
  "get_media_relations",
  "get_anime_schedule",
  "get_character",
  "get_staff",
  "get_todays_birthdays",
  "get_recommendation",
  "get_recommendations_for_media",
  "search_media",
  "search_character",
  "search_staff",
  "search_studio",
  "search_user",
  "search_activity",
  "search_thread",
  "get_thread",
  "get_thread_comments",
  "post_thread",
  "post_thread_comment",
  "delete_thread",
  "delete_thread_comment",
  "get_user_profile",
  "get_user_stats",
  "get_full_user_info",
  "get_user_recent_activity",
  "get_authorized_user",
  "toggle_follow_user",
  "update_user",
  "get_notifications",
  "login_anilist",
  "submit_anilist_redirect",
];

// Inherit the real env but force the optional AniList credentials unset, so a
// spawned server always starts unauthenticated regardless of what's
// configured on the machine actually running the tests (e.g. a dev machine
// with a real token wired into its own MCP client config).
//
// This alone is NOT sufficient to guarantee an unauthenticated spawned
// process: AniListClient falls back to the on-disk token store
// (defaultTokenStorePath(), e.g. ~/.config/anilist-mcp-server/tokens.json)
// whenever ANILIST_ACCESS_TOKEN isn't set, independent of the vars cleaned
// here. This whole `npm test` process only stays unauthenticated because
// scripts/run-tests.mjs separately points ANILIST_TOKEN_STORE at a tmp noop
// path before any test file runs — a detail invisible from this file alone.
// A standalone script that copies just this cleanEnv() (e.g. a throwaway
// live-audit protocol-diff script run outside `npm test`) must set
// ANILIST_TOKEN_STORE itself too, or it will silently authenticate as
// whatever real account is configured on the machine.
const ANILIST_ENV_VARS = new Set([
  "ANILIST_ACCESS_TOKEN",
  "ANILIST_CLIENT_ID",
  "ANILIST_CLIENT_SECRET",
]);
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !ANILIST_ENV_VARS.has(k)) env[k] = v;
  return env;
}

test("e2e: built bundle runs standalone, handshakes, and lists all tools", async (t) => {
  if (!existsSync(distPath)) {
    t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
    return;
  }

  // Copy the bundle to a dir with no node_modules: if it weren't self-contained,
  // the child would die with ERR_MODULE_NOT_FOUND and connect() would reject.
  const sandbox = join(tmpdir(), `anilist-mcp-server-e2e-${process.pid}`);
  mkdirSync(sandbox, { recursive: true });
  copyFileSync(distPath, join(sandbox, "index.js"));
  // The bundle is ESM; ship the package.json that flags it as such, exactly as
  // the real npm/.mcpb artifact does. Without it a bare `.js` is parsed as CJS
  // on Node < 20.19 (which lacks ESM syntax auto-detection) and the child dies
  // with "Cannot use import statement outside a module".
  writeFileSync(join(sandbox, "package.json"), JSON.stringify({ type: "module" }));

  const client = new Client({ name: "e2e", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(sandbox, "index.js")],
    env: cleanEnv(),
  });

  try {
    await client.connect(transport); // real initialize handshake over a spawned process

    const { tools } = await client.listTools();
    assert.equal(tools.length, EXPECTED_TOOLS.length, "every tool should register in the bundle");
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort(), "the registered tools should match");

    // manifest.json (the .mcpb bundle's own tool list, shown to users before
    // install) is hand-maintained and easy to let go stale on a rename — the
    // tool consolidation that introduced this check caught exactly that.
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "..", "manifest.json"), "utf8"),
    ) as {
      tools: { name: string }[];
    };
    const manifestNames = manifest.tools.map((t) => t.name).sort();
    assert.deepEqual(manifestNames, [...EXPECTED_TOOLS].sort(), "manifest.json tools should match");
  } finally {
    await client.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("e2e: negotiates the modern (2026-07-28) protocol era and still lists every tool", async (t) => {
  if (!existsSync(distPath)) {
    t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
    return;
  }

  // Every other e2e/unit test connects with default (legacy-only) client
  // options, so nothing here exercises serveStdio()'s modern-era path at
  // all — this test is the one place that opts a client into it, to catch a
  // regression where the server only actually works under the legacy wire
  // format it happens to be tested with everywhere else. The unit suite
  // (helpers.ts's connectServer) can't cover this itself: modern era needs a
  // transport that implements the probe-then-pin handshake (serveStdio's
  // real stdio transport), which InMemoryTransport doesn't — confirmed live
  // by connecting a bare McpServer over InMemoryTransport with
  // supportedProtocolVersions explicitly including 2026-07-28, which still
  // negotiated legacy. So this one process-spawning e2e test is the only
  // place any of this is reachable at all, and the cases below are picked
  // for where the modern-era wire codec could plausibly diverge from
  // legacy, not for tool coverage (that's the unit suite's job).
  const client = new Client(
    { name: "e2e-modern-era", version: "0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distPath],
    env: cleanEnv(),
  });

  try {
    await client.connect(transport);
    assert.equal(
      client.getProtocolEra(),
      "modern",
      "client opted into 'auto' negotiation against a serveStdio() server — it should negotiate " +
        "the modern era, not silently fall back to legacy",
    );

    // tools/list is one of the operations serveStdio()'s modern-era codec
    // fills cache fields (ttlMs/cacheScope) on — this call exercises that
    // encode path, not just the handshake. The TS result type omits these
    // (wire-only, stripped from ListToolsResult), but they're still present
    // on the actual runtime object the transport delivers.
    const listResult = await client.listTools();
    assert.equal(
      listResult.tools.length,
      EXPECTED_TOOLS.length,
      "tool list should be unaffected by era",
    );
    const rawListResult = listResult as unknown as { ttlMs?: number; cacheScope?: string };
    assert.equal(
      rawListResult.ttlMs,
      3_600_000,
      "src/server.ts's tools/list cache hint should reach the wire under the modern era",
    );
    assert.equal(rawListResult.cacheScope, "public");

    // Auth-gated tools reject in requireAuth() before any network call, with
    // no fetch mock available to a spawned real process — a case the modern
    // wire codec must still encode as a genuine tool error, not silently
    // drop or reshape.
    const noTokenResult = await client.callTool({ name: "get_notifications", arguments: {} });
    assert.equal(
      noTokenResult.isError,
      true,
      "an auth-gated tool without a token should still surface isError: true under the modern era",
    );

    // A Zod input-validation error (get_studio's id/name are each optional,
    // but the object schema's own .refine() requires at least one) is another
    // network-free, deterministic error path — same question: does the
    // modern codec still encode it as isError: true, not something the SDK's
    // 2026-era result vocabulary (e.g. input_required) could get confused with.
    const validationResult = await client.callTool({ name: "get_studio", arguments: {} });
    assert.equal(
      validationResult.isError,
      true,
      "a Zod validation error (get_studio with neither id nor name) should still be isError: " +
        "true under the modern era",
    );
  } finally {
    await client.close();
  }
});

// start()'s shutdown path (serveStdio's handle.close() on SIGINT/SIGTERM) has
// no MCP-protocol surface to exercise through a Client — it's process
// lifecycle, only observable by actually sending the signal to a real spawned
// process and watching it exit. Spawned directly with child_process (no MCP
// client/handshake needed — this only cares whether the process starts,
// logs to stderr, and exits cleanly).
function spawnServer(): {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  stderr: () => string;
} {
  // stdin must stay open ("pipe", never ended) rather than "ignore": "ignore"
  // connects it to /dev/null, which is immediately at EOF — serveStdio() then
  // reads that as the client having disconnected and shuts the process down
  // on its own within milliseconds, before this test ever gets to send a
  // signal. A real MCP host keeps the child's stdin open for the connection's
  // whole lifetime, so this only closes an artifact of the test's own spawn
  // config, not a real one.
  const child = spawn(process.execPath, [distPath], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server never printed 'ready'")), 5000);
    child.stderr!.on("data", () => {
      if (stderr.includes("ready")) {
        clearTimeout(timeout);
        // A real MCP host never signals a server within microseconds of
        // spawning it (there's at least a protocol handshake first). Under
        // heavy CPU contention a signal sent that fast can occasionally hit
        // Node's default disposition before its handler is actually
        // scheduled, independent of the stdin fix above — reproduced with a
        // signal-only repro under artificial load. A short, realistic grace
        // period avoids that race without weakening what this test verifies.
        setTimeout(resolve, 100);
      }
    });
  });
  return { child, ready, stderr: () => stderr };
}

describe("e2e: process lifecycle (SIGINT/SIGTERM)", () => {
  test("shuts down cleanly on SIGTERM", async (t) => {
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }
    // Windows has no POSIX signals: subprocess.kill("SIGTERM") force-terminates the
    // child directly instead of delivering anything its `process.on("SIGTERM", ...)`
    // handler could catch, so this test would pass there without ever exercising
    // server.ts's shutdown()/handle.close() path — a false-positive pass, not real
    // coverage. Skip rather than claim graceful-shutdown coverage this platform can't give.
    if (process.platform === "win32") {
      t.skip("SIGTERM isn't delivered to a signal handler on Windows — see comment above");
      return;
    }
    const { child, ready, stderr } = spawnServer();
    await ready;
    child.kill("SIGTERM");
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.on("exit", (code, signal) => resolve([code, signal])),
    );
    assert.equal(code, 0);
    assert.equal(signal, null); // exited via process.exit(0), not killed by the signal itself
    assert.match(stderr(), /shutting down/);
  });

  test("shuts down cleanly on SIGINT", async (t) => {
    if (!existsSync(distPath)) {
      t.skip("dist/index.js not built — run `npm run build` first (CI builds before tests)");
      return;
    }
    // Same Windows caveat as the SIGTERM test above: subprocess.kill() force-terminates
    // unconditionally there regardless of which signal name is passed, never reaching
    // server.ts's shutdown() path — skip rather than claim coverage this platform can't give.
    if (process.platform === "win32") {
      t.skip("SIGINT isn't delivered to a signal handler on Windows — see comment above");
      return;
    }
    const { child, ready, stderr } = spawnServer();
    await ready;
    child.kill("SIGINT");
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.on("exit", (code, signal) => resolve([code, signal])),
    );
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.match(stderr(), /shutting down/);
  });
});
