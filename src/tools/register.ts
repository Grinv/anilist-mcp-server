// The one way tools are registered: every registerXTools() gets this
// `tool(name, config, handler)` instead of the McpServer, so no handler can
// skip the wrapper. It runs the handler with the call's cancellation signal
// (lib/cancel.ts), checks a successful result against the tool's own
// outputSchema, and turns any throw into an isError problem result.
import type { z } from "zod";
import type { McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import type { Logger } from "../lib/logger.ts";
import { callSignal } from "../lib/cancel.ts";
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

export function toolRegistrar(server: McpServer, logger: Logger): RegisterTool {
  return <In extends z.ZodType, Out extends z.ZodType>(
    name: string,
    config: ToolConfig<In, Out>,
    handler: (args: z.infer<In>) => Promise<ToolResult>,
  ) => {
    // Widened to concrete schema types, so the SDK's conditional callback type resolves.
    const sdkConfig: ToolConfig<z.ZodType, z.ZodType> = config;
    server.registerTool(name, sdkConfig, async (args: unknown, ctx: ServerContext) => {
      try {
        // The SDK has already parsed `args` against inputSchema.
        const result = await callSignal.run(ctx.mcpReq.signal, () => handler(args as z.infer<In>));
        // The SDK would also check this, but answer a mismatch with its raw
        // zod dump; a result this server built wrong is an internal error.
        const checked = result.isError
          ? undefined
          : config.outputSchema.safeParse(result.structuredContent);
        if (checked && !checked.success) {
          throw new Error(`${name} built a result its outputSchema rejects`, {
            cause: checked.error,
          });
        }
        return result;
      } catch (err) {
        return problemResult(toProblem(err, logger));
      }
    });
  };
}
