// Helpers for the interactive AniList login (login_anilist tool). AniList
// uses a plain OAuth2 Authorization Code grant — no PKCE, and a client_secret
// is exchanged server-side (see docs/api-references.md). Unlike MAL, AniList
// issues no refresh token: access tokens are long-lived JWTs (~1 year) and
// re-authentication is the only way to renew one.
//
// Two ways to receive the redirect `code`:
//   - a best-effort localhost listener (works when the browser is on the same
//     machine as the server — local Claude Desktop / Claude Code), and
//   - manual paste of the redirected URL (works everywhere, incl. SSH/remote/
//     headless where localhost isn't reachable from the user's browser).
// Both paths converge on the same code→token exchange.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { ApiError } from "./errors.js";

/** A random CSRF `state` value for one login attempt. */
export function generateState(): string {
  return randomBytes(16).toString("hex");
}

/** Build the AniList authorize URL for the Authorization Code grant. */
export function buildAuthorizeUrl(opts: {
  oauthBaseUrl: string;
  clientId: string;
  redirectUri: string;
  state?: string;
}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
  });
  if (opts.state) q.set("state", opts.state);
  return `${opts.oauthBaseUrl.replace(/\/$/, "")}/authorize?${q.toString()}`;
}

/** Extract the `code` from a redirected URL, a bare `?code=…` query, or a raw
 *  code string. Throws an `ApiError` (code: "bad_request") with the OAuth
 *  `error` when the redirect denied access — these are anticipated user
 *  outcomes (e.g. clicking "Deny"), not unexpected failures, so they get the
 *  same clean "request was rejected as invalid" message as any other
 *  validation error rather than guard()'s generic "Unexpected error" catch-all
 *  (which is what a plain `Error` thrown here would fall into instead). */
export function extractCode(redirect: string): string {
  const text = redirect.trim();
  let params: URLSearchParams | undefined;
  try {
    params = new URL(text).searchParams;
  } catch {
    // Not a full URL — maybe "?code=…&state=…" or just the code.
    if (text.includes("=")) params = new URLSearchParams(text.replace(/^\?/, ""));
  }
  if (params) {
    const err = params.get("error");
    if (err) {
      throw new ApiError({ code: "bad_request", message: `authorization denied: ${err}` });
    }
    const code = params.get("code");
    if (code) return code;
    throw new ApiError({
      code: "bad_request",
      message: "no `code` found in the pasted redirect URL",
    });
  }
  if (!text) throw new ApiError({ code: "bad_request", message: "empty redirect/code" });
  return text; // treat the whole string as the bare code
}

/** Extract the `state` from a redirected URL or a bare `?code=…&state=…`
 *  query. Returns null for a bare code string (no query params at all) — the
 *  caller decides whether a missing state is acceptable. */
export function extractState(redirect: string): string | null {
  const text = redirect.trim();
  try {
    return new URL(text).searchParams.get("state");
  } catch {
    if (text.includes("=")) return new URLSearchParams(text.replace(/^\?/, "")).get("state");
    return null;
  }
}

/** Open a URL in the OS default browser. Best-effort — never throws (headless/
 *  remote hosts simply won't have a browser, and that's fine). */
export function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no browser available — the caller falls back to manual paste */
  }
}

/** Start a localhost HTTP listener that resolves with the first `code` it
 *  receives on `path`. Best-effort: rejects if the port can't be bound. The
 *  returned `close()` stops the server (call it once the flow is done, whichever
 *  path completed). */
export function listenForCode(opts: {
  port: number;
  path: string;
  onCode: (code: string, state: string | null) => void;
}): Promise<{ server: Server; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let code: string | null = null;
      let state: string | null = null;
      let denied: string | null = null;
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);
        if (!url.pathname.startsWith(opts.path)) {
          res.writeHead(404).end();
          return;
        }
        code = url.searchParams.get("code");
        state = url.searchParams.get("state");
        denied = url.searchParams.get("error");
      } catch {
        /* fall through to the generic reply */
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        denied
          ? "<h2>AniList login was denied. You can close this tab.</h2>"
          : code
            ? "<h2>Logged in to AniList — you can close this tab and return to your client.</h2>"
            : "<h2>Waiting for the AniList redirect…</h2>",
      );
      if (code) opts.onCode(code, state);
    });
    server.on("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      resolve({ server, close: () => server.close() });
    });
  });
}

/** Decode a JWT's payload without verifying its signature — safe here because
 *  the token only ever arrives directly from AniList's own token endpoint
 *  over HTTPS; we only need the `exp` claim for local expiry bookkeeping, not
 *  to authenticate the token itself. Returns undefined if the token isn't a
 *  well-formed JWT or carries no `exp`. */
export function decodeJwtExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
