// Loads and validates configuration from environment variables. Every secret
// is optional: the server always starts (so clients can list tools); reads
// need no credentials at all, and personal/mutation tools report a clear
// error at call time when unconfigured.
import { z } from "zod";

const EnvSchema = z.object({
  ANILIST_ACCESS_TOKEN: z.string().min(1).optional(),
  ANILIST_CLIENT_ID: z.string().min(1).optional(),
  ANILIST_CLIENT_SECRET: z.string().min(1).optional(),
  /** Override the on-disk token store path (defaults under the OS config dir). */
  ANILIST_TOKEN_STORE: z.string().min(1).optional(),

  ANILIST_GRAPHQL_URL: z.string().url().default("https://graphql.anilist.co"),
  ANILIST_OAUTH_BASE_URL: z.string().url().default("https://anilist.co/api/v2/oauth"),

  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  HTTP_RETRIES: z.coerce.number().int().nonnegative().default(2),
  // Minimum spacing between AniList calls. AniList's normal limit is 90
  // req/min, but as of 2026-07 the API is in a documented degraded state
  // capped at 30 req/min — default conservatively to that (~2100ms) and
  // widen once AniList lifts the degradation (see docs/api-references.md).
  ANILIST_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2100),
  CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300_000),
  // Localhost port for the `login_anilist` OAuth callback. Must match the
  // port in the Redirect URI registered for the AniList app
  // (http://localhost:<port>/callback).
  ANILIST_OAUTH_PORT: z.coerce.number().int().positive().default(8082),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

// Shapes validated env vars into the nested/renamed Config the rest of the
// codebase consumes, in the same Zod pipeline that validates them — so
// `Config`/`AniListAuth` (below, `z.infer` of this) can't drift from what
// loadConfig() actually builds; there's no separate hand-kept-in-sync interface.
const ConfigSchema = EnvSchema.transform((env) => ({
  graphqlUrl: env.ANILIST_GRAPHQL_URL,
  oauthBaseUrl: env.ANILIST_OAUTH_BASE_URL,
  httpTimeoutMs: env.HTTP_TIMEOUT_MS,
  httpRetries: env.HTTP_RETRIES,
  minIntervalMs: env.ANILIST_MIN_INTERVAL_MS,
  cacheTtlMs: env.CACHE_TTL_MS,
  logLevel: env.LOG_LEVEL,
  /** Localhost port for the login_anilist OAuth callback (matches the app's Redirect URI). */
  oauthPort: env.ANILIST_OAUTH_PORT,
  auth: {
    accessToken: env.ANILIST_ACCESS_TOKEN,
    clientId: env.ANILIST_CLIENT_ID,
    clientSecret: env.ANILIST_CLIENT_SECRET,
    tokenStorePath: env.ANILIST_TOKEN_STORE,
    /** Has a client id + secret → login_anilist can start a login. AniList
     *  issues both together for every app; there is no MAL-style "public vs
     *  confidential app type" pitfall here. */
    canLogin: Boolean(env.ANILIST_CLIENT_ID && env.ANILIST_CLIENT_SECRET),
    /** Has an env-provided access token → personal/mutation tools are usable.
     *  This is a startup snapshot from env only — it does NOT see a token
     *  obtained later via login_anilist (that lives in the on-disk token
     *  store). Nothing in this codebase currently reads this field; use
     *  `AniListClient.isConfigured()` for the live answer, which does account
     *  for a token store loaded after startup. */
    configured: Boolean(env.ANILIST_ACCESS_TOKEN),
  },
}));

export type Config = z.infer<typeof ConfigSchema>;
export type AniListAuth = Config["auth"];

// An optional .mcpb user_config field left blank arrives not as "" but as the
// literal, unsubstituted placeholder "${user_config.<name>}". Taken as a real
// value it would make the server think it holds an AniList token/client id
// and try to authenticate with garbage; treat it as unset, like "".
const UNSUBSTITUTED_PLACEHOLDER = /^\$\{[^}]*\}$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Drop empty-string values and unsubstituted ${...} placeholders so defaults
  // apply and optional secrets stay unset. .mcpb passes unconfigured
  // user_config fields as "" (or the raw placeholder), which would otherwise
  // fail the min(1) validation and crash startup, or be mistaken for a secret.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(
      ([, v]) => v !== undefined && v !== "" && !UNSUBSTITUTED_PLACEHOLDER.test(v),
    ),
  );
  return ConfigSchema.parse(cleaned);
}
