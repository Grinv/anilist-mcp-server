# Tool errors

A failed tool call follows the MCP spec: an `isError: true` result whose text
content explains the failure to the model, so it can correct itself. The same
failure is also attached for the client application as an
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details object in
the result's `_meta["io.github.Grinv.anilist-mcp-server/problem"]`, never in
`structuredContent`, which MCP reserves for data matching the tool's
`outputSchema`.

```json
{
  "type": "https://github.com/Grinv/anilist-mcp-server/blob/main/docs/errors.md#rate_limited",
  "title": "AniList is rate-limiting requests",
  "detail": "AniList is rate-limiting requests (429). Please retry in 57 s. AniList said: \"Too Many Requests.\"",
  "retryable": true,
  "upstream_status": 429,
  "retry_after_seconds": 57
}
```

- `type`: stable URI of the problem type, one of the sections below.
- `title`: fixed summary of the type.
- `detail`: this occurrence, as the model reads it (the result's text). When
  AniList gave a reason (a GraphQL `errors[].message` with its validation
  details, or an HTML page's title), it is quoted as `AniList said: "…"`.
- `retryable`: whether the failure is transient, so the same call may succeed
  later. The server first retries a transient upstream failure itself, up to
  `HTTP_RETRIES` times, except a mutation (only a 429 is retried
  there) and a 429 whose `Retry-After` is longer than 8 seconds.
- `upstream_status`: AniList's HTTP status (or the status embedded in a
  GraphQL error), when there was one. RFC 9457's own `status` member (the
  status of _this_ HTTP response) is not used, because MCP results have none.
- `retry_after_seconds`: AniList's `Retry-After`, when it sent one.

The text never includes a raw upstream body or an internal error message.

Scope: every failure raised while a tool runs carries a problem. Arguments
that fail a tool's input schema are rejected by the MCP SDK before the tool
runs; that `isError` result carries the SDK's own text, which lists what is
wrong so the model can fix the call, and no problem object. A call the
client cancels gets no result at all (the SDK sends nothing after a
cancellation, as the spec requires).

## unauthorized

AniList answered 401. With no token sent, the tool needs a login: run
`login_anilist` or set `ANILIST_ACCESS_TOKEN`. With a token sent, the token
may be invalid or expired, but AniList also answers 401 when the account
isn't allowed to change the resource (e.g. it doesn't own it).

## forbidden

AniList answered a JSON 403 that isn't its outage notice. With a token, the
account isn't allowed this action; without one, no permission was checked, so
`detail` says it is more likely a block or a temporary problem on AniList's side.

## unavailable

AniList answered 403 with its outage notice ("The AniList API has been
temporarily disabled due to severe stability issues…"). Nothing is wrong
with the request or the account; the outage usually lasts hours, so
`retryable` is false. See [api-references.md](api-references.md#api-stability--outage-behavior).

## blocked

AniList's edge (Cloudflare) answered 403 with an HTML page instead of the
API's JSON: its "Attention Required!" block page, typically for unusual
characters in a search term (quotes, SQL-like text), or a challenge page. The
same request is blocked again; simplify it.

## not_found

No such anime, manga, character, staff member, studio, user, thread,
activity or list entry, or a delete found nothing to delete. `detail` says
which lookup failed, separate from AniList's own quoted reason.

## rate_limited

AniList is throttling requests (HTTP 429). `retry_after_seconds` says when to
try again.

## server_error

AniList failed (HTTP 5xx). For a mutation, `detail` says the outcome is
unknown and `retryable` is false: re-read the affected data before retrying.

## network

AniList could not be reached. Check connectivity. Same mutation caveat as
[server_error](#server_error).

## timeout

AniList did not answer within `HTTP_TIMEOUT_MS`. Same mutation caveat
as [server_error](#server_error).

## bad_request

AniList rejected the request as invalid (HTTP 400/405/422, or a GraphQL
validation error in a 200 response); `detail` quotes AniList's per-field
reasons, e.g. `validation (rowOrder: The selected row order is invalid.)`.

## bad_response

AniList answered with a success status but an unusable body: invalid JSON,
no body at all, `data: null` without errors, or a token response without an
access token. This is a complete reply (such as a proxy's page), so
`retryable` is false.

## unknown

Any other upstream status; `detail` carries AniList's reason when it sent one.

## internal

A bug in anilist-mcp-server, including a result that doesn't match the
tool's own output schema. The full error (stack and cause chain) is in the
server log on stderr; please report it.

It is returned as a tool result with `isError`, not as a JSON-RPC error. The
spec lists "server errors" among protocol errors, but also says errors that
originate from the tool SHOULD be reported inside the result so the model sees
the call failed, and a bug while running a tool is the latter.

## invalid_arguments

The arguments passed the tool's schema but not its own check: a
contradictory combination (e.g. `search_media` with `sfw: true` and
`isAdult: true`), an update with no values to apply, advanced scores that
don't match the account's categories, or a pasted login redirect that is
empty, denied, from another login attempt or carries a rejected code.

## login_required

The tool acts on the user's own AniList account and no token is configured.
Run `login_anilist` (or set `ANILIST_ACCESS_TOKEN`).

## not_configured

`login_anilist` needs `ANILIST_CLIENT_ID` and `ANILIST_CLIENT_SECRET` in the
server's environment, matching an app registered at
anilist.co/settings/developer; see [auth.md](auth.md). Also returned when AniList
rejects them during the code exchange (`invalid_client`).
