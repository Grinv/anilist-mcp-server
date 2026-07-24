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
