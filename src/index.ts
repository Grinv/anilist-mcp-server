// Bin entry point. tsup prepends the `#!/usr/bin/env node` shebang.
import { start } from "./server.js";
import { redact } from "./lib/errors.js";

start().catch((err: unknown) => {
  // Fatal startup error: report on stderr and exit non-zero. Routed through
  // redact() so a credential in the message can't leak, keeping every stderr
  // path uniformly scrubbed even though today's startup errors carry none.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[anilist-mcp-server] fatal: ${redact(message)}\n`);
  process.exit(1);
});
