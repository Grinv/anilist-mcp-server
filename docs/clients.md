# Client configuration

This is a standard stdio MCP server. After `npm ci && npm run build`, point any
MCP client at `node /ABS/PATH/anilist-mcp-server/dist/index.js`. Replace
`/ABS/PATH/anilist-mcp-server` with the absolute path to your clone. The `env`
block is optional — omit it to use only the credential-free read tools.

> Once published to npm, the command becomes `npx -y anilist-mcp-server` with no path.

## Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "anilist": {
      "command": "node",
      "args": ["/ABS/PATH/anilist-mcp-server/dist/index.js"],
      "env": {
        "ANILIST_CLIENT_ID": "...",
        "ANILIST_CLIENT_SECRET": "..."
      }
    }
  }
}
```

## Cursor / VS Code / Cline / others

Use the same stdio pattern:

- command: `node`
- args: `["/ABS/PATH/anilist-mcp-server/dist/index.js"]`
- env (optional): `ANILIST_CLIENT_ID` + `ANILIST_CLIENT_SECRET` (see [auth.md](auth.md)).
