# Logging in to AniList

anilist-mcp-server has three credential tiers, each unlocking more than the last:

| Tier                                 | What you set                                                               | What it unlocks                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Nothing                           | —                                                                          | All read tools (search, details, genres/tags, recommendations, threads, activity, public/unlisted user profiles and lists, …). Personal/mutation tools return an actionable "log in first" error.            |
| 2. Client ID + Client Secret         | `ANILIST_CLIENT_ID` + `ANILIST_CLIENT_SECRET`                              | Everything in tier 1, **plus**: `login_anilist` becomes usable. Login itself is still tier 3.                                                                                                                |
| 3. Client ID + Secret + a user token | Tier 2 + running `login_anilist` (or pre-supplying `ANILIST_ACCESS_TOKEN`) | Everything above, **plus** the personal/mutation tools (list entries, favourites, follow, posting/deleting activity or threads, `update_user`, `get_notifications`) — these act on your own AniList account. |

Unlike MyAnimeList, AniList's reads need **zero** credentials at any tier — there is
no Client-ID-only "resilience" tier here, because there's no unofficial/official
API split to fall back between. The rest of this doc covers reaching **tier 3**.

> AniList issues both a **Client ID and a Client Secret** for every registered
> app — there is no MAL-style "public vs confidential app type" pitfall to get
> wrong. It also does **not** support refresh tokens: access tokens are
> long-lived JWTs valid for about a year, and once one expires the only way to
> renew it is to run `login_anilist` again.

## 1. Register an API application (one minute)

1. Go to <https://anilist.co/settings/developer> → **Create New Client**.
2. **Name:** anything.
3. **Redirect URL:** `http://localhost:8082/callback`
   - It must match exactly. If port 8082 is taken on your machine, pick another
     port here and set `ANILIST_OAUTH_PORT` to the same value in the server env.
   - Nothing needs to be reachable there for remote setups — see step 3b below.
4. Save. Copy the **Client ID** and **Client Secret**.

## 2. Configure the credentials

Set `ANILIST_CLIENT_ID` and `ANILIST_CLIENT_SECRET` in your MCP client config's
`env` block (see [clients.md](clients.md)). The server does **not** read a
`.env` file.

```json
"env": { "ANILIST_CLIENT_ID": "...", "ANILIST_CLIENT_SECRET": "..." }
```

At this point you're at **tier 2** — `login_anilist` is now usable. Continue
below to actually complete a login (tier 3).

## 3. Run `login_anilist`

Ask your assistant to run the **`login_anilist`** tool (or just "log in to
AniList"). It returns an authorization URL. Open it, log in, click **Approve**.

**a. Local (server and browser on the same machine — Claude Desktop, local
Claude Code):** login completes automatically — the server catches the redirect
on `http://localhost:8082/callback`. Then call `get_authorized_user` to confirm.

**b. Remote/headless (server over SSH, in a container, or on another host):**
`localhost:8082` on the server isn't reachable from your browser, so after
clicking Approve you'll land on a page that fails to load. **Copy the full URL
from your browser's address bar** (it contains `?code=...`) and pass it to the
**`submit_anilist_redirect`** tool. That completes the login.

The token is stored at `~/.config/anilist-mcp-server/tokens.json`
(`%APPDATA%\anilist-mcp-server\tokens.json` on Windows; override with
`ANILIST_TOKEN_STORE`), with `0600` permissions. There is no refresh step —
the stored token is simply reused until it expires (~1 year from issuance,
read from the JWT's own `exp` claim).

## Advanced: skip `login_anilist`

You can pre-supply a token instead of running `login_anilist`:

- **`ANILIST_ACCESS_TOKEN`** — a standalone access token.

To obtain one by hand (the Authorization Code grant, same flow `login_anilist`
automates):

```sh
CLIENT_ID="<your client id>"
CLIENT_SECRET="<your client secret>"
REDIRECT_URI="http://localhost:8082/callback"

# Open this, click Approve, then copy the `code` from the redirected URL:
echo "https://anilist.co/api/v2/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}"

CODE="<code from the redirect>"
curl -s -X POST https://anilist.co/api/v2/oauth/token \
  -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"authorization_code\",\"client_id\":\"${CLIENT_ID}\",\"client_secret\":\"${CLIENT_SECRET}\",\"redirect_uri\":\"${REDIRECT_URI}\",\"code\":\"${CODE}\"}"
```

The response contains `access_token` (a JWT — decode it at [jwt.io](https://jwt.io)
to inspect its `exp` claim).

Alternatively, AniList also supports an **Implicit Grant + Auth Pin** flow
(`response_type=token` redirected to `https://anilist.co/api/v2/oauth/pin`,
where you copy the token shown on the page) if you'd rather avoid the client
secret entirely — this server doesn't automate that path, but any resulting
token works fine as `ANILIST_ACCESS_TOKEN`.
