import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { toolRegistrar, type RegisterTool } from "../tools/register.ts";
import { callSignal } from "../lib/cancel.ts";
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

test("the handler runs with the call's cancellation signal in callSignal", async (t) => {
  let seen: AbortSignal | undefined;
  const client = await connect((tool) =>
    tool("t", config, async () => {
      seen = callSignal.getStore();
      return jsonResult({ n: 1 });
    }),
  );
  t.after(() => client.close());
  const res = await client.callTool({ name: "t", arguments: {} });
  assert.notEqual(res.isError, true);
  assert.ok(seen instanceof AbortSignal);
});
