// Server construction and stdio startup. Kept separate from the bin entry
// (index.ts) so tests can import buildServer without triggering startup.
// Wire your clients, tools and prompts here.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { AniListClient } from "./clients/anilist.js";
import { registerMiscTools } from "./tools/misc.js";
import { registerActivityTools } from "./tools/activity.js";
import { registerListTools } from "./tools/list.js";
import { registerMediaTools } from "./tools/media.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerRecommendationTools } from "./tools/recommendation.js";
import { registerSearchTools } from "./tools/search.js";
import { registerThreadTools } from "./tools/thread.js";
import { registerUserTools } from "./tools/user.js";
import { registerNotificationTools } from "./tools/notification.js";
import { registerLoginTools } from "./tools/login.js";
import { registerPrompts } from "./prompts.js";
import { VERSION } from "./version.js";

const INSTRUCTIONS =
  "AniList tools for anime, manga, characters, staff and studios. Reads (search/details/" +
  "genres/tags/recommendations/threads/activity/public user data) call the public AniList " +
  "GraphQL API and need no credentials. Personal-list and social tools (get/add/update/" +
  "remove list entries, favourites, follow, posting/deleting activity or threads, " +
  "update_user, get_notifications) act on the authenticated user's own AniList account and " +
  "require a user token; without one they return an actionable error. Resolve a title to " +
  "its AniList id with search_media before calling id-based tools.";

/** Construct a fully-registered MCP server. Shared by start() and tests. */
export function buildServer(config: Config, logger: Logger): McpServer {
  const client = new AniListClient(config, logger);

  // No `logging` capability: notifications/message + logging/setLevel were
  // deprecated in protocol version 2026-07-28 (SEP-2577), in favor of
  // stderr/OpenTelemetry — which lib/logger.ts already does. Not worth
  // building on a path already marked for removal.
  const server = new McpServer(
    { name: "anilist-mcp-server", title: "AniList MCP Server", version: VERSION },
    {
      instructions: INSTRUCTIONS,
      // 2026-07-28's cacheable-result hints (only read by 2026-era clients;
      // 2025-era responses are untouched either way). Every tool/prompt here
      // is registered unconditionally in this same function, with no
      // runtime/auth-dependent branching — the list is identical for every
      // caller and never changes without a server restart, so `public` +
      // an hour-long ttl is safe. `resources/*` are omitted: this server
      // registers no MCP resources. Revisit if tool/prompt registration
      // ever becomes conditional (e.g. feature flags, account tier).
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "prompts/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
      },
    },
  );

  registerMiscTools(server, client);
  registerActivityTools(server, client);
  registerListTools(server, client);
  registerMediaTools(server, client);
  registerPeopleTools(server, client);
  registerRecommendationTools(server, client);
  registerSearchTools(server, client);
  registerThreadTools(server, client);
  registerUserTools(server, client);
  registerNotificationTools(server, client);
  registerLoginTools(server, client);
  registerPrompts(server);
  return server;
}

/** Load config, build the server, and serve over stdio until terminated. */
export async function start(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // Arm signal/error handlers before serveStdio()/the "ready" log below: under
  // CPU contention the process can be descheduled between two synchronous
  // statements, and a SIGINT/SIGTERM arriving in that gap would hit Node's
  // default disposition (killed immediately, no graceful close) instead of
  // this handler if it were registered any later.
  // Must stay `let` (assigned once, but only after serveStdio() below) so
  // shutdown()'s closure sees it.
  // eslint-disable-next-line prefer-const
  let handle: ReturnType<typeof serveStdio> | undefined;
  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down`);
    void (handle?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", reason));
  process.on("uncaughtException", (err) => {
    logger.error("uncaught exception", err);
    process.exit(1);
  });

  // v2's serveStdio() takes a server *factory* (not an instance) and owns the
  // transport + connect() lifecycle itself.
  handle = serveStdio(() => buildServer(config, logger), {
    onerror: (err) => logger.error("stdio transport error", err),
  });
  logger.info(`anilist-mcp-server ${VERSION} ready`);
}
