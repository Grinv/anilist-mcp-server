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
  "favourite",
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
  "get_thread",
  "get_thread_comments",
  "delete_thread",
  "get_user_profile",
  "get_user_stats",
  "get_full_user_info",
  "get_user_recent_activity",
  "get_authorized_user",
  "follow_user",
  "update_user",
  "get_notifications",
  "login_anilist",
  "submit_anilist_redirect",
];

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

  // Inherit env but force the optional credentials unset, to test a clean start.
  const ANILIST_ENV_VARS = new Set([
    "ANILIST_ACCESS_TOKEN",
    "ANILIST_CLIENT_ID",
    "ANILIST_CLIENT_SECRET",
  ]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !ANILIST_ENV_VARS.has(k)) env[k] = v;

  const client = new Client({ name: "e2e", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(sandbox, "index.js")],
    env,
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
