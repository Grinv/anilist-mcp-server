// Test runner: runs `node --test` straight on src/**/*.test.ts — Node's native
// type stripping loads the TypeScript sources (and their relative ".ts"
// imports) directly, so there's no compile step. A Node script rather than an
// inline npm command so the env default below works on Windows cmd.exe too.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep this in sync with the CI "Coverage gate" step (.github/workflows/ci.yml).
const COVERAGE_LINES_THRESHOLD = 80;

// Structural (not just convention-based) isolation from the real on-disk
// OAuth token store: `??=` so an explicit override still wins, but any test
// that forgets to route through helpers.ts's testConfig() (or is added later
// and calls loadConfig()/AniListClient directly) still falls back to this
// safe path via AniListClient's `config.auth.tokenStorePath ?? defaultTokenStorePath()`,
// which reads process.env when called with no explicit argument — instead of
// silently reading/writing whatever real token happens to be on this machine.
// Keep this path in sync with helpers.ts's NOOP_TOKEN_STORE.
process.env.ANILIST_TOKEN_STORE ??= join(tmpdir(), "anilist-mcp-server-test-noop-token-store.json");

// Anything besides --coverage is forwarded to `node --test`, e.g.
// `npm test -- --test-name-pattern=foo` to run a subset locally, or
// `npm test -- src/__tests__/foo.test.ts` to run one file.
const rawArgs = process.argv.slice(2);
const coverage = rawArgs.includes("--coverage");
const passthrough = rawArgs.filter((a) => a !== "--coverage");
// A test-file path, as opposed to a flag or a flag's space-separated value
// (`--test-name-pattern foo`): it names a .ts file or is a glob.
const isTestFile = (a: string) => !a.startsWith("-") && /\.ts$|\*/.test(a);

// Default timeout — a safety net so a hanging test
// (e.g. an unref'd timer with nothing else keeping the event loop alive, the
// exact bug found and fixed in http.test.ts) fails fast with a clear timeout
// instead of hanging indefinitely or reporting a vague "cancelledByParent".
// --test-timeout applies per FILE, not per individual test() call, when
// running multiple files (confirmed: several anilist.test.ts cases each take
// several real seconds testing retry/backoff delays, and their file-level
// total tripped a naive 20s value). The slowest file, anilist.test.ts, takes
// ~90s on its own (measured 2026-10); the limit stays about 2x that so a
// slower CI runner doesn't trip it, and it only catches a genuine hang, not
// slow but legitimate tests. `passthrough` can still override it explicitly.
const hasExplicitTimeout = passthrough.some((a) => a.startsWith("--test-timeout"));

// Every node option must come before the first file path: node hands
// anything after it to the test files as their own argv instead.
const args = ["--test"];
if (!hasExplicitTimeout) args.push("--test-timeout=180000");
if (coverage) {
  args.push(
    "--experimental-test-coverage",
    `--test-coverage-lines=${COVERAGE_LINES_THRESHOLD}`,
    // Only src/ code counts: not the test files themselves (thousands of
    // always-run lines would mask a real drop), nor the e2e test's spawned
    // dist/index.js or the scripts/ that version.test.ts imports.
    "--test-coverage-include=src/**",
    "--test-coverage-exclude=src/__tests__/**",
  );
}
args.push(...passthrough);

// Explicit files from the caller replace the default glob. The glob is passed
// as one argument (no shell involved) and expanded by node --test itself, so it
// behaves the same on every platform.
if (!passthrough.some(isTestFile)) args.push("src/**/*.test.ts");

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
