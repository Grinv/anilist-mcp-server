// The one way tools are registered: every registerXTools() gets this
// `tool(name, config, handler)` instead of the McpServer, so no handler can
// skip the wrapper. It runs the handler with the call's cancellation signal
// (lib/cancel.ts), checks a successful result against the tool's own
// outputSchema, and turns any throw into an isError problem result.
import type { z } from "zod";
import type { McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import type { Logger } from "../lib/logger.ts";
import { callContext, type CallContext } from "../lib/cancel.ts";
import { ApiError, ToolError } from "../lib/errors.ts";
import { problemResult, toProblem, type ToolResult } from "../lib/result.ts";

interface ToolConfig<In extends z.ZodType, Out extends z.ZodType> {
  title: string;
  description: string;
  inputSchema: In;
  outputSchema: Out;
  annotations: ToolAnnotations;
}

export type RegisterTool = <In extends z.ZodType, Out extends z.ZodType>(
  name: string,
  config: ToolConfig<In, Out>,
  handler: (args: z.infer<In>) => Promise<ToolResult>,
) => void;

const WRITE_APPLIED =
  "AniList did apply this write; only reading its answer failed. Re-read the affected data " +
  "instead of repeating the call.";

export function toolRegistrar(server: McpServer, logger: Logger): RegisterTool {
  return <In extends z.ZodType, Out extends z.ZodType>(
    name: string,
    config: ToolConfig<In, Out>,
    handler: (args: z.infer<In>) => Promise<ToolResult>,
  ) => {
    // Widened to concrete schema types, so the SDK's conditional callback type resolves.
    const sdkConfig: ToolConfig<z.ZodType, z.ZodType> = config;
    server.registerTool(name, sdkConfig, async (args: unknown, ctx: ServerContext) => {
      const call: CallContext = { signal: ctx.mcpReq.signal, wrote: false };
      // This server's own bug after AniList applied a write in this call
      // (lib/graphql.ts sets `wrote`): say the write landed, or the model may
      // repeat it. An ApiError/ToolError is AniList's or the domain's verdict
      // on the write itself (e.g. "not deleted"), so it gets no such note.
      const fail = (err: unknown) => {
        const problem = toProblem(err, logger);
        const internal = !(err instanceof ApiError || err instanceof ToolError);
        if (call.wrote && internal) problem.detail += ` ${WRITE_APPLIED}`;
        return problemResult(problem);
      };
      try {
        // The SDK has already parsed `args` against inputSchema.
        const result = await callContext.run(call, () => handler(args as z.infer<In>));
        // The SDK would also check this, but answer a mismatch with its raw
        // zod dump; a result this server built wrong is an internal error.
        const checked = result.isError
          ? undefined
          : config.outputSchema.safeParse(result.structuredContent);
        if (checked && !checked.success) {
          return fail(
            new Error(`${name} built a result its outputSchema rejects`, { cause: checked.error }),
          );
        }
        return result;
      } catch (err) {
        return fail(err);
      }
    });
  };
}
