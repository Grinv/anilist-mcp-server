// Owns the one genuinely deep, cross-cutting concern: config/auth/token/login
// state. Each domain's query/mutation building lives in ./anilist/*.ts (one
// file per area, matching src/tools/*) as plain exported functions operating
// on the shared AniListContext this class hands out via ctx() — tools call
// those functions directly (e.g. `media.getMedia(client.ctx(), type, ids)`)
// instead of this class re-exposing every domain method as a same-named
// pass-through; that pass-through layer added a hop with no logic of its own.
import { GraphQLClient } from "../lib/graphql.js";
import { RateLimiter } from "../lib/rateLimit.js";
import { TtlCache } from "../lib/cache.js";
import { ApiError } from "../lib/errors.js";
import {
  TokenStore,
  TokenStateSchema,
  defaultTokenStorePath,
  type TokenState,
} from "../lib/tokenStore.js";
import {
  buildAuthorizeUrl,
  extractCode,
  extractState,
  generateState,
  listenForCode,
  openBrowser,
  decodeJwtExpiry,
} from "../lib/oauthLogin.js";
import { HttpClient } from "../lib/http.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";
import type { AniListContext } from "./anilist/context.js";

// A generous default: AniList tokens carry no refresh mechanism, so if the
// JWT's `exp` claim is ever unreadable, assume the conventional ~1-year
// lifetime rather than treating the token as immediately expired.
const FALLBACK_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export class AniListClient {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #gql: GraphQLClient;
  readonly #oauthHttp: HttpClient;
  readonly #tokenStore: TokenStore | undefined;
  #token: TokenState | undefined;
  // Serializes the localhost OAuth callback listener so a second login_anilist
  // call doesn't try to bind the same port twice while one is pending.
  #pendingLogin: { close: () => void } | undefined;
  // The CSRF `state` generated for the in-flight login attempt, checked
  // against whatever the redirect (local callback or pasted URL) reports.
  #pendingState: string | undefined;

  constructor(config: Config, logger: Logger) {
    this.#config = config;
    this.#logger = logger;

    const limiter = new RateLimiter(config.minIntervalMs);
    // TtlCache itself no-ops (never caches) when cacheTtlMs is 0, so this is
    // safe to construct unconditionally.
    const cache = new TtlCache<unknown>(config.cacheTtlMs);
    this.#gql = new GraphQLClient({
      endpoint: config.graphqlUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      beforeRequest: () => limiter.acquire(),
      cache,
    });
    // Shared HttpClient for the OAuth token exchange, so it gets the same
    // timeout/retry/error-classification behavior as every GraphQL call
    // instead of a hand-rolled fetch().
    this.#oauthHttp = new HttpClient({
      baseUrl: config.oauthBaseUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
    });

    this.#tokenStore = new TokenStore(
      config.auth.tokenStorePath ?? defaultTokenStorePath(),
      logger,
    );
    this.#token = config.auth.accessToken
      ? { accessToken: config.auth.accessToken, expiresAt: Infinity }
      : this.#tokenStore.load();
  }

  // ---- Auth ----------------------------------------------------------

  /** Whether a usable (non-expired) access token is available. */
  isConfigured(): boolean {
    return Boolean(this.#token && this.#token.expiresAt > Date.now());
  }

  /** Whether login_anilist can be started (a client id + secret is configured). */
  canLogin(): boolean {
    return this.#config.auth.canLogin;
  }

  #authHeader(): Record<string, string> | undefined {
    return this.isConfigured()
      ? { Authorization: `Bearer ${this.#token!.accessToken}` }
      : undefined;
  }

  #requireAuth(): Record<string, string> {
    const header = this.#authHeader();
    if (!header) {
      throw new ApiError({
        code: "unauthorized",
        message: "Run login_anilist (or set ANILIST_ACCESS_TOKEN) before using this tool.",
      });
    }
    return header;
  }

  /** The one real interface this class exposes to domain functions and tool
   *  handlers alike — built fresh per call so it always sees the current
   *  token. `src/tools/*.ts` calls domain functions directly with this
   *  (e.g. `media.getMedia(client.ctx(), type, ids)`) rather than going
   *  through a same-named method on this class. */
  ctx(): AniListContext {
    return {
      gql: this.#gql,
      authHeader: () => this.#authHeader(),
      requireAuth: () => this.#requireAuth(),
    };
  }

  /** Start the Authorization Code login flow: builds the authorize URL and,
   *  best-effort, opens the browser and listens on localhost for the redirect.
   *  `options.open` overrides the real browser launch — tests must pass a
   *  no-op here, since the default `openBrowser` really spawns the OS's
   *  browser opener. */
  async startLogin(
    options: { open?: (url: string) => void } = {},
  ): Promise<{ authorizeUrl: string; redirectUri: string; listening: boolean }> {
    if (!this.#config.auth.clientId || !this.#config.auth.clientSecret) {
      throw new ApiError({
        code: "bad_request",
        message: "ANILIST_CLIENT_ID and ANILIST_CLIENT_SECRET must both be set to log in.",
      });
    }
    const redirectUri = `http://localhost:${this.#config.oauthPort}/callback`;
    const state = generateState();
    this.#pendingState = state;
    const authorizeUrl = buildAuthorizeUrl({
      oauthBaseUrl: this.#config.oauthBaseUrl,
      clientId: this.#config.auth.clientId,
      redirectUri,
      state,
    });

    this.#pendingLogin?.close();
    this.#pendingLogin = undefined;
    let listening = false;
    try {
      const { close } = await listenForCode({
        port: this.#config.oauthPort,
        path: "/callback",
        onCode: (code, redirectState) => {
          void this.#completeWithCode(code, redirectState).finally(() => {
            this.#pendingLogin?.close();
            this.#pendingLogin = undefined;
          });
        },
      });
      this.#pendingLogin = { close };
      listening = true;
    } catch (err) {
      this.#logger.warn(
        `could not bind localhost:${this.#config.oauthPort}, use manual paste`,
        err,
      );
    }

    (options.open ?? openBrowser)(authorizeUrl);
    return { authorizeUrl, redirectUri, listening };
  }

  /** Manual fallback for headless setups: submit the redirected URL directly. */
  async submitRedirect(redirect: string): Promise<void> {
    const code = extractCode(redirect);
    try {
      await this.#completeWithCode(code, extractState(redirect));
    } finally {
      // Always torn down, even on a state mismatch or a failed token
      // exchange — otherwise a failed submit_anilist_redirect leaks the
      // localhost listener from the startLogin() call that preceded it.
      this.#pendingLogin?.close();
      this.#pendingLogin = undefined;
    }
  }

  async #completeWithCode(code: string, state: string | null): Promise<void> {
    // Only checked when we actually started a login in this process — a
    // submit_anilist_redirect call with no matching startLogin has nothing to
    // compare against, so it proceeds (best-effort CSRF protection, not a
    // hard requirement of the grant itself).
    if (this.#pendingState && state !== this.#pendingState) {
      throw new ApiError({
        code: "unauthorized",
        message:
          "OAuth state mismatch — this redirect doesn't match the login attempt that started " +
          "it. Run login_anilist again.",
      });
    }
    const redirectUri = `http://localhost:${this.#config.oauthPort}/callback`;
    let json: { access_token?: string };
    try {
      // Routed through the shared HttpClient (not a hand-rolled fetch()) so
      // the token exchange gets the same timeout/error-classification
      // behavior as every other AniList call — but with retries disabled:
      // an authorization_code grant is single-use, so replaying it after a
      // slow-but-successful exchange would fail as a reused/invalid code.
      json = await this.#oauthHttp.requestJson<{ access_token?: string }>("token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: this.#config.auth.clientId,
          client_secret: this.#config.auth.clientSecret,
          redirect_uri: redirectUri,
          code,
        }),
        retries: 0,
      });
    } catch (err) {
      // A 400 here is almost always an expired/already-used/invalid
      // authorization code — surface that directly rather than the generic
      // classifyStatus() "bad_request" wording, which doesn't point at the
      // actual fix (a fresh code via login_anilist).
      if (err instanceof ApiError && err.code === "bad_request") {
        throw new ApiError({
          code: "bad_request",
          message:
            "AniList rejected the authorization code (it may be expired, already used, or " +
            `invalid) — run login_anilist again for a fresh one. (${err.message})`,
        });
      }
      throw err;
    }
    // Only cleared once the exchange actually succeeds — clearing it
    // unconditionally right after the state check would let a second
    // /callback hit (a retry after a failed exchange, or a race, since the
    // localhost listener stays open until this whole call settles) bypass
    // the CSRF check entirely.
    this.#pendingState = undefined;
    if (!json.access_token) {
      throw new ApiError({
        code: "unknown",
        message: "AniList's token response had no access_token",
      });
    }
    const expiresAt = decodeJwtExpiry(json.access_token) ?? Date.now() + FALLBACK_TOKEN_LIFETIME_MS;
    // safeParse, not parse: `json` is only type-asserted, not runtime-validated, so a
    // truthy-but-non-string access_token (a misbehaving/future AniList response) must
    // surface as the same actionable ApiError this function uses for every other
    // malformed-response case above, not a raw ZodError.
    const tokenResult = TokenStateSchema.safeParse({ accessToken: json.access_token, expiresAt });
    if (!tokenResult.success) {
      throw new ApiError({
        code: "unknown",
        message: "AniList's token response had a malformed access_token",
      });
    }
    this.#token = tokenResult.data;
    this.#tokenStore?.save(this.#token);
  }
}
