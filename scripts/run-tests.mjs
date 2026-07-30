// Cross-platform test runner: runs `node --test` with the working directory set
// to dist-tests (where compiled *.test.js + their imports live). Avoids the
// POSIX-only `(cd dir && ...)` shell idiom so it works on Windows cmd.exe too.
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

// Anything besides --coverage is forwarded as-is to `node --test`, e.g.
// `npm test -- --test-name-pattern=foo` to run a subset locally.
const rawArgs = process.argv.slice(2);
const coverage = rawArgs.includes("--coverage");
const passthrough = rawArgs.filter((a) => a !== "--coverage");

// `--test-coverage-lines` (a hard, fail-the-run threshold) landed in Node 22.8.
// On older runtimes — including the Node 20 floor — fall back to reporting
// coverage without enforcing it, so `npm run test:coverage` still works there.
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsThreshold = major > 22 || (major === 22 && minor >= 8);

// Default timeout (Node 20.11+, our floor) — a safety net so a hanging test
// (e.g. an unref'd timer with nothing else keeping the event loop alive, the
// exact bug found and fixed in http.test.ts) fails fast with a clear timeout
// instead of hanging indefinitely or reporting a vague "cancelledByParent".
// --test-timeout applies per FILE, not per individual test() call, when
// running multiple files (confirmed: several anilist.test.ts cases each take
// several real seconds testing retry/backoff delays, and their file-level
// total tripped a naive 20s value) — kept generous (well above the ~35s the
// full suite normally takes) so it only catches a genuine hang, not slow but
// legitimate tests. `passthrough` can still override it explicitly.
const hasExplicitTimeout = passthrough.some((a) => a.startsWith("--test-timeout"));

const args = ["--test", ...passthrough];
if (!hasExplicitTimeout) args.push("--test-timeout=120000");
if (coverage) {
  args.push("--experimental-test-coverage");
  if (supportsThreshold) args.push(`--test-coverage-lines=${COVERAGE_LINES_THRESHOLD}`);
}

const child = spawn(process.execPath, args, { cwd: "dist-tests", stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
