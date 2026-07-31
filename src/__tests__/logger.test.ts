import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../lib/logger.js";

function captureStderr<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

test("emits every level to stderr with its label", () => {
  const { lines } = captureStderr(() => {
    const log = createLogger("debug");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  });
  assert.deepEqual(lines, [
    "[anilist-mcp-server] debug: d",
    "[anilist-mcp-server] info: i",
    "[anilist-mcp-server] warn: w",
    "[anilist-mcp-server] error: e",
  ]);
});

test("stderr output is gated by the configured threshold", () => {
  const { lines } = captureStderr(() => {
    const log = createLogger("warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  });
  assert.deepEqual(lines, ["[anilist-mcp-server] warn: w", "[anilist-mcp-server] error: e"]);
});

test("silent level emits nothing", () => {
  const { lines } = captureStderr(() => {
    const log = createLogger("silent");
    log.error("e");
  });
  assert.equal(lines.length, 0);
});

test("credentials are redacted before reaching stderr", () => {
  const { lines } = captureStderr(() => {
    const log = createLogger("info");
    log.info("calling https://api.example.test/x?access_token=supersecret&v=1");
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /access_token=\*\*\*/);
  assert.doesNotMatch(lines[0]!, /supersecret/);
});

test("extra args are stringified and redacted", () => {
  const { lines } = captureStderr(() => {
    const log = createLogger("info");
    log.info("headers", { Authorization: "Bearer supersecret" });
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Bearer \*\*\*/);
  assert.doesNotMatch(lines[0]!, /supersecret/);
});
