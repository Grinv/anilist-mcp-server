// @ts-check
// Propagate the version from package.json (the single source of truth) into the
// other files that must carry it: src/version.ts, manifest.json (.mcpb bundle),
// server.json (MCP registry, incl. the release-asset URL), and CHANGELOG.md
// (renames [Unreleased] to this version — see renderChangelogRelease below).
// Wired into the npm `version` lifecycle hook (see package.json), so
// `npm version <bump>` updates every file in one commit.
//
// preversion-check.mjs gates on [Unreleased] being non-empty, and by design
// that check runs BEFORE npm bumps package.json/runs this script, so this
// rename must happen AFTER the gate, not before it. Doing it manually
// beforehand (as this project's own `release` skill used to instruct) leaves
// [Unreleased] empty right when the gate inspects it — a real, confirmed
// self-inflicted failure, not a hypothetical one.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string} rel
 * @param {[RegExp, string][]} edits
 */
function patch(rel, edits) {
  const file = join(root, rel);
  let text = readFileSync(file, "utf8");
  for (const [pattern, replacement] of edits) {
    if (!text.match(pattern)) {
      throw new Error(`sync-version: pattern ${pattern} not found in ${rel} — update the script`);
    }
    text = text.replace(pattern, replacement);
  }
  writeFileSync(file, text);
}

// The leading quote means this never matches `"manifest_version"` in manifest.json.
const versionField = /("version":\s*")[^"]*(")/;

// Move CHANGELOG.md's [Unreleased] notes under a new dated version heading,
// reopening a fresh, empty [Unreleased] above it. Pure string -> string (no
// file I/O) so it's directly unit-testable (see version.test.ts). Checks for
// an actual bullet (`- `) under [Unreleased] rather than just "is a heading
// immediately next" — robust to stray blank lines, and safe to run more than
// once (idempotent: a re-run after a failed release, or a genuinely-empty
// CONFIRM_EMPTY_CHANGELOG=1 release that preversion-check.mjs already gated,
// both find nothing to move and return the input unchanged).
/**
 * @param {string} text
 * @param {string} version
 * @param {string} date
 * @returns {string}
 */
export function renderChangelogRelease(text, version, date) {
  const match = text.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/);
  if (!match) {
    throw new Error("sync-version: CHANGELOG.md has no [Unreleased] heading — update the script");
  }
  if (!/^-\s/m.test(match[1].trim())) {
    return text;
  }
  return text.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] - ${date}\n`);
}

function main() {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  patch("src/version.ts", [[/(export const VERSION = ")[^"]*(")/, `$1${version}$2`]]);
  patch("manifest.json", [[versionField, `$1${version}$2`]]);
  patch("server.json", [
    [new RegExp(versionField, "g"), `$1${version}$2`], // top-level + package version
    [/(releases\/download\/v)\d+\.\d+\.\d+(\/)/, `$1${version}$2`], // .mcpb asset URL tag
  ]);

  const changelogFile = join(root, "CHANGELOG.md");
  const date = new Date().toISOString().slice(0, 10);
  const before = readFileSync(changelogFile, "utf8");
  const after = renderChangelogRelease(before, version, date);
  if (after === before) {
    console.log("sync-version: CHANGELOG.md's [Unreleased] has no bullets — leaving as-is");
  } else {
    writeFileSync(changelogFile, after);
    console.log(
      `sync-version: filed CHANGELOG.md's [Unreleased] entries under [${version}] - ${date}`,
    );
  }

  console.log(`sync-version: set ${version} in version.ts, manifest.json, server.json`);
}

// Only run as a script (not when version.test.ts imports renderChangelogRelease).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
