# Security

`anilist-mcp-server` talks to **AniList's own GraphQL API only** — but unlike
its read-only sibling servers in this project family, it has the broadest
write/social tool surface of the four: it can post and delete public content,
and change settings, on the real AniList account it's configured with.

## Public reads vs. authenticated writes

- **No credential needed** for search/details, characters/staff/studios,
  genres/tags, reviews/recommendations, forum threads, activity feeds, and
  public/unlisted user profiles and lists — these call AniList's public
  GraphQL endpoint directly.
- **Personal-list and social tools require the user's own OAuth access
  token** (`ANILIST_ACCESS_TOKEN`, or one obtained via `login_anilist`).
  Without one, every tool in that category returns an actionable error
  instead of a doomed request — see [docs/auth.md](docs/auth.md) for the
  three credential tiers.

## The mutating tool surface

These 13 tools all perform a real, live mutation against
`graphql.anilist.co` the moment they're called, with no separate
confirmation step of the server's own, and every one of them requires the
caller's own valid access token — there is no cross-user write capability
anywhere in this server:

- **List entries**: `add_list_entry`, `update_list_entry`, `remove_list_entry`
- **Favourites and follows**: `toggle_favourite`, `toggle_follow_user`
- **Posting**: `post_text_activity`, `post_message_activity`, `post_thread`,
  `post_thread_comment`
- **Deleting**: `delete_activity`, `delete_thread`, `delete_thread_comment`
- **Account settings**: `update_user`

**Posting and deleting activity, threads, and comments happens on the real
user's real AniList account**, publicly visible to other AniList users and
attributed to that account, exactly as if they'd been posted directly on
anilist.co. There is no tool-level allow/deny list beyond "is a token
configured" — if the calling AI model decides to invoke one of these tools,
the mutation happens. Review what an AI agent intends to do before
authorizing it to act with a write-capable token, the same way you would
before granting any other tool access to a real account.

## Token storage

- A token obtained via `login_anilist` is written to a single local file —
  `~/.config/anilist-mcp-server/tokens.json` on macOS/Linux,
  `%APPDATA%\anilist-mcp-server\tokens.json` on Windows, or the path in
  `ANILIST_TOKEN_STORE` — created with `0600` permissions (owner-read/write
  only). Pre-supplying `ANILIST_ACCESS_TOKEN` directly instead keeps the
  token in memory only for that run; it is never written to this file.
- **Caveat**: `writeFileSync(..., { mode: 0o600 })` (`src/lib/tokenStore.ts`)
  only applies that mode when the file is _created_. If the file already
  exists with looser permissions (e.g. copied in from elsewhere, or created
  by a different process/user), overwriting it does not retroactively
  tighten those permissions. Verify the file's mode yourself if you have any
  reason to suspect it wasn't created by this server.
- AniList issues no refresh token — access tokens are long-lived JWTs
  (~1 year, read from the token's own `exp` claim). Re-running
  `login_anilist` is the only way to renew one.
- `login_anilist` never sees your AniList password: it opens AniList's own
  authorize page in your browser, where you sign in and approve directly
  with AniList, which then redirects back with a one-time code. The server
  exchanges that code (plus your `ANILIST_CLIENT_ID`/`ANILIST_CLIENT_SECRET`)
  for an access token at AniList's token endpoint — never a password.

## Env-configurable endpoints

`ANILIST_GRAPHQL_URL` (default `https://graphql.anilist.co`) and
`ANILIST_OAUTH_BASE_URL` (default `https://anilist.co/api/v2/oauth`) are
fixed once at server startup from the environment — there is no tool
parameter that lets a caller redirect a request to a different host at call
time. That said, there is also no host allowlist: if you (or whatever
deploys this server) point either of these at something other than AniList's
real infrastructure, every GraphQL request — including the bearer token on
every authenticated call, and the `client_id`/`client_secret` sent during the
OAuth token exchange — goes to that host instead. Only set these to a host
you trust with those credentials.

## Credential redaction

Log lines (stderr only, never a file or a remote endpoint) are passed
through `redact()` (`src/lib/errors.ts`) before being written, which strips
`Authorization: Bearer ...` headers and `access_token`/`refresh_token`/
`client_secret`/`client_id` values in both `key=value` and JSON
(`"key":"value"`) shapes — the latter matches the actual shape of this
server's own OAuth token exchange request body
(`src/clients/anilist.ts`'s `#completeWithCode`), even though no current
logging call site logs that body directly.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/Grinv/anilist-mcp-server/issues) or,
for anything sensitive, email the address on the maintainer's GitHub profile
(<https://github.com/Grinv>). Please don't file public issues for
vulnerabilities that could affect other users' AniList accounts before
there's a fix available.

Not affiliated with AniList. "AniList" is a trademark of its respective
owner.
