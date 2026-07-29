---
name: docs-consistency-check
description: Check README/manifest.json/server.json/CHANGELOG.md/AGENTS.md and docs/*.md for drift against the actual registered tools and source. Use after adding, renaming, or removing a tool, or as part of a live-audit pass.
---

# Docs/metadata consistency

Check every one of these, not just a sample:

- `README.md`'s tool table matches `src/server.ts`'s registrations (names,
  and the permission/auth column against each tool's actual `requireAuth()`
  usage).
- `manifest.json`'s and `server.json`'s `tools` arrays list the same tool
  **names** as what's actually registered (`npm test` already asserts this
  via `e2e.test.ts` — treat a failure there as authoritative). Their
  `description` fields are deliberately short, independent marketing-style
  summaries, NOT a copy of the tool's full `.describe()`/`description` text
  in `src/tools/*.ts` — don't "fix" them to match verbatim, that's not a
  bug. Do re-read them for accuracy if a tool's _behavior_ changed in a way
  the short summary now misrepresents.
- Tool `description`/field `.describe()` text in `src/tools/*.ts` itself:
  does it still match the actual `inputSchema`/`outputSchema` and the client
  function's real behavior? Cross-check new/edited descriptions against the
  `tool-description-check` skill (Glama's TDQS rubric) per AGENTS.md.
- `CHANGELOG.md`'s `[Unreleased]` section (see the `changelog-style` skill
  for entry style) has one line per real behavior change made in this pass
  — add missing entries, don't just flag them as missing.
- `docs/api-references.md`'s "confirmed live" claims still match the current
  client code, especially any claim this pass's own fixes just invalidated.
- `AGENTS.md`'s `src/` tree (and this `skills/` entry) still matches the
  filesystem.
- `docs/clients.md` and any other `docs/*.md` for stale phrasing (e.g.
  describing something as "once published"/"upcoming" that already
  shipped).
- `PRIVACY.md` and `SECURITY.md`: re-verify every specific claim against the
  actual current code, don't just skim for plausibility — which credentials
  exist and how each is transmitted/redacted (`redact()` in
  `src/lib/errors.ts`), what is and isn't cached (cache key/TTL/what clears
  it, in `src/lib/cache.ts` and `clients/anilist.ts`), the current list of
  read-only vs. mutating tools (grep `registerTool(` in `src/tools/*.ts`),
  and the env-configurable-endpoint/host-allowlist statement in `config.ts`.
  This class of drift is easy to miss because it reads fine on its own and
  only breaks against the code: a sibling repo's `SECURITY.md`/`PRIVACY.md`
  both claimed "player-specific data is never cached" after a later feature
  added exactly that caching, and a separate claim conflated an
  actually-cached field with a similarly-named never-cached one — neither
  doc was self-evidently wrong, both required re-reading the client code to
  catch. Given this repo's especially broad write/social tool surface, the
  mutating-tool enumeration (currently 13 — see `SECURITY.md`'s "The
  mutating tool surface") is the highest-value thing to re-check here
  specifically; it's exactly the kind of count that silently goes stale the
  next time a tool is added, renamed, or removed.
