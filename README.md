# AniList MCP Server

An [MCP](https://modelcontextprotocol.io) server for **[AniList](https://anilist.co)**.
It works with any MCP-compatible client or agent (Claude Desktop/Code, Cursor,
VS Code, Cline, Continue, and others) — the server speaks the standard MCP
stdio protocol.

## What it does

Talks directly to AniList's public GraphQL API (`https://graphql.anilist.co`):

- **Reads — no credentials needed.** Search and browse anime/manga,
  characters, staff, studios; genres/tags; recommendations; forum threads;
  activity feeds; public/unlisted user profiles and lists.
- **Your own AniList account — requires a one-time login.** Manage your own
  anime/manga list (add/update/remove entries), favourites, follows, your
  notifications, and post/delete your own activity and threads.

## What you need (and what it gets you)

Nothing is required to get started — you can skip straight to
[Install](#install). Everything below is optional:

| You set...                                                                                                                       | You get...                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| _(nothing)_                                                                                                                      | Search, details, genres/tags, recommendations, threads, activity, public profiles/lists — works immediately.       |
| An AniList **Client ID + Client Secret** ([2 minutes, free →](#connect-your-anilist-account)), plus running `login_anilist` once | Everything above, plus your **own AniList account**: manage your list, favourites, follows, activity, and threads. |

Without a login, the personal/mutation tools reply with a clear message
telling you how to get one — everything else keeps working regardless.

## Example queries

Once it's connected, just ask your agent in natural language.

**No credentials needed:**

```
"Search for the anime Frieren and show its score, genres and synopsis."
"What recommendations does AniList have for fans of Steins;Gate?"
"Show me today's birthday characters."
"What genres and tags does AniList use for anime?"
"Show the public profile and stats for user <username>."
"What's in <username>'s AniList anime list marked as watching?"
```

**With your AniList account** (after a one-time `login_anilist`; see
[Connect your AniList account](#connect-your-anilist-account)):

```
"Add Frieren to my AniList plan-to-watch list."
"Set Cowboy Bebop to completed on my AniList with a score of 9."
"Follow user <username> for me."
"Post a text update to my AniList activity feed."
"What are my unread AniList notifications?"
```

## Tools

| Tool                                                                                                  | Auth  |
| ----------------------------------------------------------------------------------------------------- | ----- |
| `get_genres`, `get_media_tags`, `get_site_statistics`, `get_studio`                                   | none  |
| `get_media`, `get_media_statistics`, `get_media_characters`, `get_media_staff`                        | none  |
| `get_media_reviews`, `get_media_relations`, `get_anime_schedule`                                      | none  |
| `get_character`, `get_staff`, `get_todays_birthdays`                                                  | none  |
| `get_recommendation`, `get_recommendations_for_media`                                                 | none  |
| `search_media`, `search_character`, `search_staff`, `search_studio`, `search_user`, `search_activity` | none  |
| `get_thread`, `get_thread_comments`                                                                   | none  |
| `get_user_profile`, `get_user_stats`, `get_full_user_info`, `get_user_recent_activity`                | none  |
| `get_activity`, `get_user_activity`                                                                   | none  |
| `get_user_list`                                                                                       | none  |
| `favourite`                                                                                           | token |
| `add_list_entry`, `update_list_entry`, `remove_list_entry`                                            | token |
| `post_text_activity`, `post_message_activity`, `delete_activity`                                      | token |
| `delete_thread`                                                                                       | token |
| `get_authorized_user`, `follow_user`, `update_user`                                                   | token |
| `get_notifications`                                                                                   | token |
| `login_anilist`, `submit_anilist_redirect`                                                            | login |

`token` = needs an AniList login (run `login_anilist` once).

## Prompts

Reusable multi-step plans your client can offer as one-click flows:
`recommend_similar`, `seasonal_overview`, `hidden_gems`, `catch_up_activity`,
`check_notifications`.

## Install

### As an `.mcpb` bundle (one-click, e.g. Claude Desktop)

Download [**`anilist-mcp-server.mcpb`**](https://github.com/Grinv/anilist-mcp-server/releases/latest/download/anilist-mcp-server.mcpb)
(always the latest release) and open it with your MCP client. It prompts for an optional
AniList **Client ID** and **Client Secret** — set them and run the `login_anilist` tool to
enable the personal-list/social tools (see
[Connect your AniList account](#connect-your-anilist-account)). Leave them
blank to use just the credential-free read tools.

### From source

```sh
git clone https://github.com/Grinv/anilist-mcp-server
cd anilist-mcp-server
npm ci
npm run build
```

This produces a self-contained `dist/index.js`. Point your client at it (see below).

## Connect it to an MCP client

Add the server to your client's MCP config (Claude Desktop/Code, Cursor, VS Code,
Cline, …):

```json
{
  "mcpServers": {
    "anilist": {
      "command": "node",
      "args": ["/absolute/path/to/anilist-mcp-server/dist/index.js"],
      "env": {
        "ANILIST_CLIENT_ID": "...",
        "ANILIST_CLIENT_SECRET": "..."
      }
    }
  }
}
```

Or with the Claude Code CLI:

```sh
claude mcp add anilist -e ANILIST_CLIENT_ID=... -e ANILIST_CLIENT_SECRET=... -- node /absolute/path/to/anilist-mcp-server/dist/index.js
```

The `env` block is **optional** — omit it to use only the credential-free read
tools; the personal/mutation tools will return a clear error until you log in.
To enable them, set `ANILIST_CLIENT_ID` + `ANILIST_CLIENT_SECRET` and run the
**`login_anilist`** tool once (a one-time browser authorization; the token is
then stored and reused). The server does not read a `.env` file, so pass
config via this `env` block (or your shell environment). See
[docs/auth.md](docs/auth.md) for the full login walkthrough and
[docs/clients.md](docs/clients.md) for more clients.

## Connect your AniList account

The search/browse tools work with **no setup**. To use the personal/mutation
tools, authorize your account once. It takes about two minutes.

**Step 1 — Register an AniList app (one minute).**

1. Go to <https://anilist.co/settings/developer> and click **Create New Client**.
2. **Name:** anything.
3. **Redirect URL:** enter exactly
   ```
   http://localhost:8082/callback
   ```
   _(If port 8082 is already used on your machine, pick another port here and set
   `ANILIST_OAUTH_PORT` to the same number — see [Configuration](#configuration).)_
4. Save. Copy the **Client ID** and **Client Secret**.

**Step 2 — Give the credentials to the server.**

```json
"env": { "ANILIST_CLIENT_ID": "...", "ANILIST_CLIENT_SECRET": "..." }
```

Restart the server/client so it picks up the values.

**Step 3 — Log in (one click).**

In your assistant, run the **`login_anilist`** tool (or just say _"log in to
AniList"_). It replies with a link. Open the link, sign in to AniList, and
click **Approve**.

- **Running locally** (Claude Desktop, or Claude Code on your own machine):
  login finishes **automatically** the moment you click Approve. Confirm with
  _"show my AniList profile"_ (`get_authorized_user`).
- **Running on a remote/SSH/headless host:** after clicking Approve your
  browser lands on a page that won't load — that's expected. **Copy the full
  address from the browser's address bar** (it contains `?code=…`) and give it
  to the **`submit_anilist_redirect`** tool to finish.

That's it. The token is saved locally (`~/.config/anilist-mcp-server/tokens.json`,
`0600`). AniList access tokens don't expire for about a year and there's no
refresh mechanism — you'll need to run `login_anilist` again once it does.

> **Prefer no interactive step?** Pre-set a standalone `ANILIST_ACCESS_TOKEN`
> instead. See [docs/auth.md](docs/auth.md).

## Configuration

All configuration is via environment variables, all optional — without
credentials the read tools still work.

| Variable                | Purpose                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ANILIST_CLIENT_ID`     | Your AniList app's Client ID — see [Connect your AniList account](#connect-your-anilist-account).                      |
| `ANILIST_CLIENT_SECRET` | Your AniList app's Client Secret, paired with the Client ID above.                                                     |
| `ANILIST_ACCESS_TOKEN`  | _Advanced, optional._ Pre-supply a token instead of running `login_anilist`. See [docs/auth.md](docs/auth.md).         |
| `ANILIST_TOKEN_STORE`   | Override where the login token is saved on disk (default: your OS's config folder).                                    |
| `ANILIST_OAUTH_PORT`    | Only needed if port `8082` is already in use — see step 1 of the [account walkthrough](#connect-your-anilist-account). |
| `LOG_LEVEL`             | How much the server logs: `debug` \| `info` \| `warn` \| `error` \| `silent` (default `info`).                         |

### Tuning (rarely needed)

| Variable                                        | Purpose                                                                                                                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANILIST_MIN_INTERVAL_MS`                       | Min spacing between AniList calls (default `2100`, i.e. ~30/min — AniList's API is currently in a documented degraded state; see [docs/api-references.md](docs/api-references.md)). Set to `0` to disable client-side throttling. |
| `CACHE_TTL_MS`                                  | TTL for the in-memory read cache (default `300000` = 5 min).                                                                                                                                                                      |
| `HTTP_TIMEOUT_MS`, `HTTP_RETRIES`               | Per-request timeout (default `15000`) and retry attempts for transient failures (default `2`).                                                                                                                                    |
| `ANILIST_GRAPHQL_URL`, `ANILIST_OAUTH_BASE_URL` | Override upstream base URLs.                                                                                                                                                                                                      |

Provide these in your MCP client config's `env` block (the server does **not**
read a `.env` file). See [docs/auth.md](docs/auth.md) for how to obtain the
credentials, and [docs/clients.md](docs/clients.md) for client configuration
snippets.

## NSFW content

NSFW (adult) results are **not** filtered by default — the server returns
whatever AniList provides. `search_media` accepts an optional `sfw`
parameter; set `sfw: true` to exclude adult entries.

## Development

```sh
npm run build        # type-check + bundle to dist/
npm test             # node:test suite (mocked, offline)
npm run test:coverage
npm run lint
npm run format
npm run check:api    # live health-check of the AniList GraphQL endpoint
npm run inspector    # run under the MCP Inspector
```

Runtime requires Node ≥ 20. See [AGENTS.md](AGENTS.md) for contributor/agent
guidance, including why this server exists and how it avoids the upstream bug
that motivated building it.

## Updating

To be notified of new versions, click **Watch → Releases** on GitHub.

- **`.mcpb` bundle:** download the new `anilist-mcp-server.mcpb` from the
  [releases page](https://github.com/Grinv/anilist-mcp-server/releases) and
  reinstall it in your client (it replaces the old version).
- **From source:** `git pull && npm ci && npm run build`.

See the [CHANGELOG](CHANGELOG.md) for what changed in each release.

## Attribution and terms

This is an **unofficial** project and is not affiliated with or endorsed by
AniList. All data comes from the public [AniList GraphQL API](https://docs.anilist.co);
personal-account operations use your own AniList account and token. Use is
subject to [AniList's Terms of Service](https://anilist.co/terms).

## License

[MIT](LICENSE) © Grinv
