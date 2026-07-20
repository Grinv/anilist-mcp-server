// Shared test helpers. Not a test file (no *.test suffix) so the runner skips it.
import type { TestContext } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createLogger, type Logger } from "../lib/logger.js";
import { buildServer } from "../server.js";
import { loadConfig, type Config } from "../config.js";

// A path that's guaranteed not to exist on disk, so a test that doesn't care
// about token persistence never silently reads (or races on) whatever real
// token happens to be sitting at the OS-default store path on the machine
// running the tests — e.g. a token a live login_anilist run just wrote there.
const NOOP_TOKEN_STORE = join(tmpdir(), "anilist-mcp-server-test-noop-token-store.json");

/** Like `loadConfig`, but defaults `ANILIST_TOKEN_STORE` to a path that never
 *  exists — tests that specifically exercise token-store persistence should
 *  keep passing their own `ANILIST_TOKEN_STORE` (it takes precedence here). */
export function testConfig(env: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({ ANILIST_TOKEN_STORE: NOOP_TOKEN_STORE, ...env });
}

export function silentLogger(): Logger {
  return createLogger("silent");
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

type FetchArgs = Parameters<typeof fetch>;

export interface FetchMock {
  fn: typeof fetch;
  calls: { url: string; init: FetchArgs[1] }[];
}

/** Build a fetch mock from a handler, recording every call. */
export function mockFetch(
  handler: (url: string, init: FetchArgs[1]) => Response | Promise<Response>,
): FetchMock {
  const calls: FetchMock["calls"] = [];
  const fn = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** Install a fetch mock for the duration of the current test. Scoped to `t.mock`
 * (Node 20's stable node:test mocking), which auto-restores the original
 * `globalThis.fetch` when the test finishes — callers don't call anything to
 * undo it themselves. */
export function installFetch(t: TestContext, mock: FetchMock): void {
  t.mock.method(globalThis, "fetch", mock.fn);
}

/** Build the server and connect an in-memory client for end-to-end tool tests. */
export async function connectServer(
  env: NodeJS.ProcessEnv = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer(testConfig(env), silentLogger());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
