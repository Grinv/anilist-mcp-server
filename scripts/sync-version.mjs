// @ts-check
// Propagate the version from package.json (the single source of truth) into the
// other files that must carry it: src/version.ts, manifest.json (.mcpb bundle)
// and server.json (MCP registry, incl. the release-asset URL). Wired into the
// npm `version` lifecycle hook (see package.json), so `npm version <bump>`
// updates every file in one commit. Uses targeted token replacement — not JSON
// re-serialization — to preserve each file's exact formatting.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

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

patch("src/version.ts", [[/(export const VERSION = ")[^"]*(")/, `$1${version}$2`]]);
patch("manifest.json", [[versionField, `$1${version}$2`]]);
patch("server.json", [
  [new RegExp(versionField, "g"), `$1${version}$2`], // top-level + package version
  [/(releases\/download\/v)\d+\.\d+\.\d+(\/)/, `$1${version}$2`], // .mcpb asset URL tag
]);

console.log(`sync-version: set ${version} in version.ts, manifest.json, server.json`);

// File CHANGELOG.md's [Unreleased] entries under a dated version heading.
// Runs here (the npm `version` lifecycle script), not as a manual pre-step —
// `preversion-check.mjs` gates on [Unreleased] being non-empty, and by
// design that check runs BEFORE npm bumps package.json/runs this script, so
// this rename must happen AFTER the gate, not before it. Doing it manually
// beforehand (as this project's own `release` skill used to instruct)
// leaves [Unreleased] empty right when the gate inspects it — a real,
// confirmed self-inflicted failure, not a hypothetical one.
function syncChangelog() {
  const file = join(root, "CHANGELOG.md");
  const text = readFileSync(file, "utf8");
  const match = text.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/);
  if (!match) {
    throw new Error("sync-version: CHANGELOG.md has no [Unreleased] heading — update the script");
  }
  if (!/^-\s/m.test(match[1].trim())) {
    // Already renamed (re-run), or a genuinely no-user-facing-change release
    // that used CONFIRM_EMPTY_CHANGELOG=1 — nothing to file, leave as-is.
    console.log("sync-version: CHANGELOG.md's [Unreleased] is already empty, leaving it as-is");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    file,
    text.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] - ${today}\n`),
  );
  console.log(
    `sync-version: filed CHANGELOG.md's [Unreleased] entries under [${version}] - ${today}`,
  );
}

syncChangelog();
