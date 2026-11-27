// Kept in sync with package.json by a unit test (see __tests__/version.test.ts).
export const VERSION = "0.11.1";

export const REPO_URL = "https://github.com/Grinv/anilist-mcp-server";

export const USER_AGENT = `anilist-mcp-server/${VERSION} (+${REPO_URL})`;

// This server's MCP Registry identity: package.json's mcpName, already in
// reverse-DNS form (version.test.ts keeps them equal).
export const MCP_NAME = "io.github.Grinv/anilist-mcp-server";

// Prefix for this server's own _meta keys. The MCP spec reserves unprefixed
// and mcp/modelcontextprotocol names and asks vendors for a reverse-DNS
// prefix, so it is derived from MCP_NAME: io.github.Grinv.anilist-mcp-server/.
export const META_PREFIX = `${MCP_NAME.replace("/", ".")}/`;
