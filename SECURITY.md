# Security

`anilist-mcp-server` only talks to AniList's own GraphQL API. But of this
project's four sibling servers, it has the widest write/social surface: it can
post and delete public content, and change account settings, on the AniList
account it's configured with.

## Public reads vs. authenticated writes

- **No credential needed** for search/details, characters/staff/studios,
  genres/tags, reviews/recommendations, forum threads, activity feeds, and
  public/unlisted user profiles and lists. These call AniList's public
  GraphQL endpoint directly.
- **Personal-list and social tools require the user's own OAuth access
  token** (`ANILIST_ACCESS_TOKEN`, or one obtained via `login_anilist`).
  Without one, every tool in that category returns an actionable error
  instead of trying the request anyway. See [docs/auth.md](docs/auth.md) for
  the three credential tiers.

## The mutating tool surface

These 13 tools each write to `graphql.anilist.co` when called, with no
confirmation step of the server's own. Each one needs the caller's own access
token; the server can't write to anyone else's account:

- **List entries**: `add_list_entry`, `update_list_entry`, `remove_list_entry`
- **Favourites and follows**: `toggle_favourite`, `toggle_follow_user`
- **Posting**: `post_text_activity`, `post_message_activity`, `post_thread`,
  `post_thread_comment`
- **Deleting**: `delete_activity`, `delete_thread`, `delete_thread_comment`
- **Account settings**: `update_user`

**Posts and deletions go to your own AniList account**, public and attributed
to you just like anything you post on anilist.co directly. The server has no
per-tool allow/deny list; the only gate is whether a token is configured, so
if the model calls one of these tools, the write goes through. Treat a
write-capable token like any other access to a real account, and check what
the agent means to do before letting it act.

## Token storage

- A token obtained via `login_anilist` is written to a single local file
  (`~/.config/anilist-mcp-server/tokens.json` on macOS/Linux,
  `%APPDATA%\anilist-mcp-server\tokens.json` on Windows, or the path in
  `ANILIST_TOKEN_STORE`), created with `0600` permissions (owner-read/write
  only). Pre-supplying `ANILIST_ACCESS_TOKEN` directly instead keeps the
  token in memory for that run only; it is never written to this file.
- On POSIX, every save also re-applies `0600` to the file after writing
  (`chmodSync`, `src/lib/tokenStore.ts`). `writeFileSync`'s `mode` argument
  only takes effect when the file is _created_, so a `tokens.json` copied in
  from elsewhere, or left with looser permissions by another process, gets
  tightened back to owner-only on the next save instead of keeping its old
  mode. Windows has no POSIX-mode equivalent; there the file inherits the
  directory's ACLs.
- AniList issues no refresh token. Access tokens are long-lived JWTs
  (about a year, read from the token's own `exp` claim), and re-running
  `login_anilist` is the only way to renew one.
- `login_anilist` never sees your AniList password. It opens AniList's own
  authorize page in your browser, where you sign in and approve with AniList
  directly; AniList then redirects back with a one-time code. The server
  trades that code (plus your `ANILIST_CLIENT_ID`/`ANILIST_CLIENT_SECRET`) for
  an access token at AniList's token endpoint. Your password never reaches
  the server.

## Env-configurable endpoints

`ANILIST_GRAPHQL_URL` (default `https://graphql.anilist.co`) and
`ANILIST_OAUTH_BASE_URL` (default `https://anilist.co/api/v2/oauth`) are set
once at server startup from the environment; no tool parameter can redirect a
request to a different host at call time. There is no host allowlist either,
though: if you (or whatever deploys this server) point either variable at
something other than AniList's real infrastructure, every GraphQL request goes
there instead, bearer token and all, along with the
`client_id`/`client_secret` sent during the OAuth token exchange. Only point
these at a host you trust with those credentials.

## Credential redaction

Log lines (stderr only, never a file or a remote endpoint) pass through
`redact()` (`src/lib/errors.ts`) before they're written. It strips
`Authorization: Bearer ...` headers and `access_token`/`refresh_token`/
`client_secret`/`client_id` values in both `key=value` and JSON
(`"key":"value"`) form. The JSON form matches this server's own OAuth
token-exchange request body (`src/clients/anilist.ts`'s `#completeWithCode`),
even though no logging call site currently logs that body.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/Grinv/anilist-mcp-server/issues) or,
for anything sensitive, email the address on the maintainer's GitHub profile
(<https://github.com/Grinv>). Please don't file public issues for
vulnerabilities that could affect other users' AniList accounts before a fix
is available.

Not affiliated with AniList. "AniList" is a trademark of its respective
owner.
