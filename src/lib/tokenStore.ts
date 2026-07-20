// Persists the AniList access token so login_anilist survives restarts.
// Unlike MAL, AniList issues no refresh token — access tokens are long-lived
// JWTs (~1 year); once one expires, re-authentication via login_anilist is
// the only way to renew it. The file is created 0600 inside the user's OS
// config directory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./logger.js";

export interface TokenState {
  accessToken: string;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
}

export class TokenStore {
  readonly #path: string;
  readonly #logger: Logger;

  constructor(path: string, logger: Logger) {
    this.#path = path;
    this.#logger = logger;
  }

  get path(): string {
    return this.#path;
  }

  /** Returns persisted state, or undefined if absent/unreadable/corrupt. */
  load(): TokenState | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch {
      return undefined; // not created yet
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TokenState>;
      if (typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number") {
        return parsed as TokenState;
      }
      this.#logger.warn(`token store at ${this.#path} is malformed; ignoring it`);
      return undefined;
    } catch {
      this.#logger.warn(`token store at ${this.#path} is not valid JSON; ignoring it`);
      return undefined;
    }
  }

  save(state: TokenState): void {
    // POSIX modes restrict access on macOS/Linux. Windows ignores them (the
    // file inherits directory ACLs) — best effort, no error there.
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    writeFileSync(this.#path, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}

/** Default token store path, honoring ANILIST_TOKEN_STORE then OS conventions. */
export function defaultTokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANILIST_TOKEN_STORE) return env.ANILIST_TOKEN_STORE;
  const base =
    platform() === "win32"
      ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "anilist-mcp-server", "tokens.json");
}
