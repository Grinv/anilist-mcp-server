// Shared helper: run a tool body and convert any failure into a tool result
// (never throw), so the agent receives an actionable message.
import { createLogger } from "../lib/logger.ts";
import { problemResult, toProblem, type ToolResult } from "../lib/result.ts";

// Transitional: the registration wrapper that replaces guard() passes the server's logger.
const logger = createLogger("warn");

export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return problemResult(toProblem(err, logger));
  }
}
