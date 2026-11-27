import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { toolRegistrar, type RegisterTool } from "../tools/register.ts";
import { callContext } from "../lib/cancel.ts";
import { ApiError } from "../lib/errors.ts";
import { jsonResult } from "../lib/result.ts";
import type { Logger } from "../lib/logger.ts";
import { problemCode, problemOf, silentLogger } from "./helpers.ts";

async function connect(
  register: (tool: RegisterTool) => void,
  logger: Logger = silentLogger(),
): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" });
  register(toolRegistrar(server, logger));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const config = {
  title: "T",
  description: "d",
  inputSchema: z.strictObject({}),
  outputSchema: z.object({ n: z.number() }),
  annotations: { readOnlyHint: true },
};

test("a thrown ApiError becomes a problem result without structuredContent", async (t) => {
  const client = await connect((tool) =>
    tool("t", config, async () => {
      throw new ApiError({ code: "not_found", status: 404, detail: "Not Found.", message: "x" });
    }),
  );
  t.after(() => client.close());
  const res = await client.callTool({ name: "t", arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(problemCode(res), "not_found");
  assert.equal(problemOf(res)?.upstream_status, 404);
});

test("a result off the tool's own outputSchema is internal, logged with its cause", async (t) => {
  const errors: unknown[][] = [];
  const logger = { ...silentLogger(), error: (...a: unknown[]) => errors.push(a) };
  const client = await connect(
    (tool) => tool("t", config, async () => jsonResult({ n: "not a number" })),
    logger,
  );
  t.after(() => client.close());
  const res = await client.callTool({ name: "t", arguments: {} });
  assert.equal(problemCode(res), "internal");
  assert.doesNotMatch((res.content as { text: string }[])[0]!.text, /Output validation/);
  assert.equal(errors.length, 1);
  const err = errors[0]![1] as Error;
  assert.match(err.message, /t built a result its outputSchema rejects/);
  assert.ok(err.cause instanceof z.ZodError);
});

test("a write tool whose result fails its outputSchema says the write already applied", async (t) => {
  const client = await connect((tool) =>
    tool("w", { ...config, annotations: { readOnlyHint: false } }, async () => {
      callContext.getStore()!.wrote = true; // as lib/graphql.ts does after a mutation succeeds
      return jsonResult({ n: "not a number" });
    }),
  );
  t.after(() => client.close());
  const res = await client.callTool({ name: "w", arguments: {} });
  assert.equal(problemCode(res), "internal");
  assert.match((res.content as { text: string }[])[0]!.text, /AniList did apply this write/);
  // A call that made no write (even on a tool that can write) says nothing about one.
  const read = await connect((tool) =>
    tool("r", { ...config, annotations: { readOnlyHint: false } }, async () =>
      jsonResult({ n: "x" }),
    ),
  );
  t.after(() => read.close());
  const r = await read.callTool({ name: "r", arguments: {} });
  assert.doesNotMatch((r.content as { text: string }[])[0]!.text, /write/);
});

test("the handler runs with the call's cancellation signal in callContext", async (t) => {
  let seen: AbortSignal | undefined;
  const client = await connect((tool) =>
    tool("t", config, async () => {
      seen = callContext.getStore()?.signal;
      return jsonResult({ n: 1 });
    }),
  );
  t.after(() => client.close());
  const res = await client.callTool({ name: "t", arguments: {} });
  assert.notEqual(res.isError, true);
  assert.ok(seen instanceof AbortSignal);
});
