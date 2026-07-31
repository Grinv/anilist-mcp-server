// Persists the AniList access token so login_anilist survives restarts.
// Unlike MAL, AniList issues no refresh token — access tokens are long-lived
// JWTs (~1 year); once one expires, re-authentication via login_anilist is
// the only way to renew it. The file is created 0600 inside the user's OS
// config directory.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Logger } from "./logger.js";

export const TokenStateSchema = z
  .object({
    accessToken: z.string(),
    /** Epoch milliseconds at which the access token expires. */
    expiresAt: z.number().positive(),
  })
  .loose();

export type TokenState = z.infer<typeof TokenStateSchema>;

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
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.#logger.warn(`token store at ${this.#path} is not valid JSON; ignoring it`);
      return undefined;
    }
    const result = TokenStateSchema.safeParse(json);
    if (!result.success) {
      this.#logger.warn(`token store at ${this.#path} is malformed; ignoring it`);
      return undefined;
    }
    return result.data;
  }

  save(state: TokenState): void {
    // POSIX modes restrict access on macOS/Linux. Windows ignores them (the
    // file inherits directory ACLs) — best effort, no error there.
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    writeFileSync(this.#path, JSON.stringify(state, null, 2), { mode: 0o600 });
    // `mode` above only applies when the file is newly created; overwriting a
    // pre-existing (possibly looser) tokens.json — from a backup, an older
    // tool, or an operator-supplied ANILIST_TOKEN_STORE path — leaves its old
    // perms untouched. Re-assert 0600 so a save always tightens a stored
    // ~1-year JWT. POSIX only; Windows has no equivalent and inherits dir ACLs.
    if (platform() !== "win32") chmodSync(this.#path, 0o600);
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
