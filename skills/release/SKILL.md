---
name: release
description: Cut a release of anilist-mcp-server — draft CHANGELOG entries, then bump/tag/push. Use when asked to release, cut a version, or publish a new version of this package.
---

# Releasing

`package.json` is the **single source of truth** for the version. The npm
`version` lifecycle hook runs `scripts/sync-version.mjs`, which propagates it to
`src/version.ts`, `manifest.json` and `server.json` (incl. the `.mcpb` release-asset
URL), and also renames `CHANGELOG.md`'s `## [Unreleased]` heading to
`## [X.Y.Z] - <today>` (adding a fresh empty `## [Unreleased]` above it) —
`version.test.ts` guards that version.ts/manifest.json/server.json never drift.

A `preversion` hook (`scripts/preversion-check.mjs`) runs first — it's a
presence-only safety net, not a substitute for actually running the skill
below as a real judgment step. It blocks `npm version` if `CHANGELOG.md`'s
`[Unreleased]` section is empty at that point: run the `changelog-style` skill
against the commits since the last tag first — it's what actually makes the
entries short, self-describing, free of implementation detail, and linked to
their commits; the hook only confirms _something_ is there, not that it
follows that style. (Or re-run with `CONFIRM_EMPTY_CHANGELOG=1` if this
release genuinely has no user-facing changes, e.g. a pure dependency bump.)

**Do NOT rename `## [Unreleased]` to a dated heading yourself before running
`npm version`.** That used to be this skill's documented step 1 and it's a
confirmed, self-inflicted failure mode: the `preversion` gate checks whether
`[Unreleased]` is populated, and by definition it's empty right after you've
already moved its entries into a dated section — so a manual pre-rename
guarantees the gate blocks, forcing an awkward `CONFIRM_EMPTY_CHANGELOG=1`
override for a release that isn't actually empty. `sync-version.mjs` now does
this rename itself, from inside the `version` lifecycle script, which runs
strictly _after_ the `preversion` gate has already passed — so the entries
are still under `[Unreleased]` (and thus visible to the gate) at exactly the
moment it matters, and get filed under the right dated heading automatically
right after.

**When invoked as this skill**, run these as explicit steps, not optional —
don't rely on the `preversion` hook alone to catch a skipped one:

1. Invoke the `changelog-style` skill against the commits since the last tag;
   write/fix the `[Unreleased]` entries per its style rules and leave them
   under `[Unreleased]` — don't rename the heading (see above).
2. Commit it.
3. `npm version <patch|minor|major>` — preversion gate, then bumps + syncs
   every file (including the CHANGELOG rename) + commits + tags `vX.Y.Z`.
4. `git push --follow-tags` — pushing the tag triggers `.github/workflows/release.yml`.

The tag push (`v*`) runs the **Release** workflow: `check:api` gate → build → test
→ pack `.mcpb` → GitHub Release → `npm publish` (OIDC trusted publishing, with
provenance — no token) → **publish to the official MCP Registry** (`mcp-publisher`,
GitHub OIDC). Never hand-edit the version in the derived files; bump `package.json`
via `npm version` and let the hook sync the rest.

## MCP Registry

The server is intended to be listed at `registry.modelcontextprotocol.io` as
`io.github.Grinv/anilist-mcp-server` (`server.json`), exposing **both** packages: the npm
package (`anilist-mcp-server`, run via `npx`) and the `.mcpb` GitHub-release bundle.
Ownership is verified per package type:

- **npm** → the `mcpName` field in `package.json` must equal `server.json`'s `name`
  (guarded by `version.test.ts`). It ships in the published package, so it is
  set once and every release just works.
- **mcpb** → `server.json` needs the artifact's `fileSha256`. Because `.mcpb`
  (a zip) isn't byte-reproducible, the release workflow recomputes it from the
  just-packed bundle and injects it before `mcp-publisher publish` — no committed
  value is kept. The asset URL must contain "mcp" (it does).

The namespace `io.github.Grinv/*` is authorized by GitHub OIDC from this repo, so
no registry token/secret is needed. To publish manually instead:
`mcp-publisher login github && mcp-publisher publish`.

**Keep config in three places in sync.** A user-facing env var is declared in
`config.ts` (the source of truth), `manifest.json` `user_config` (the `.mcpb`
install form), and `server.json` `packages[].environmentVariables` (the registry
entry). When you add/rename/remove one in `config.ts`, update the other two —
`version.test.ts` guards that `manifest.json` and `server.json` agree, but it
can't see `config.ts`, so the `config.ts` → descriptors step is on you. Keep
`server.json` descriptions ≤ 100 chars (registry schema cap). Purely internal
tunables (timeouts, cache, rate limits, `LOG_LEVEL`) stay env-only — they don't
belong in the install form or registry entry.

**Keep `manifest.json`'s `tools` array in sync too.** It's hand-maintained
(`tools_generated: false`) with one short one-line description per tool —
update it whenever a tool is added, renamed, or removed in `src/tools/*`.
