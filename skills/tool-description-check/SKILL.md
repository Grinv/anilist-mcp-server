---
name: tool-description-check
description: Self-check a new or edited MCP tool `description`/field `.describe()` text before committing — verify every behavioral claim against live testing, check for contradictions with sibling tools, and score against Glama's Tool Definition Quality Score (TDQS) rubric. Use whenever a tool description or schema field description in src/tools/*.ts is added or changed.
---

# Tool descriptions: what to check before committing

Published research on this exact failure mode: [Glama's TDQS
methodology](https://github.com/glama-ai/tool-definition-quality-score) found
97% of 856 tools across 103 real MCP servers have a description defect — 56%
don't clearly state what the tool does, 89% don't say when to use it.
Separately, "From Docs to Descriptions" measured that strong descriptions get
260% more selection in competitive scenarios and lift task success ~6 points.
Bad descriptions aren't a hypothetical risk; they're the median case. This
server is scored on the same rubric at
[glama.ai/mcp/servers/Grinv/anilist-mcp-server/score](https://glama.ai/mcp/servers/Grinv/anilist-mcp-server/score)
(re-analyzed on Glama's own schedule, not on push — treat this as a manual
pre-commit check, not something to verify live after every edit).

| TDQS dimension          | Weight | Question                                                           |
| ----------------------- | ------ | ------------------------------------------------------------------ |
| Purpose Clarity         | 25%    | Does the description state what the tool does?                     |
| Usage Guidelines        | 20%    | Does it say when to use this tool vs. alternatives?                |
| Behavioral Transparency | 20%    | Does it disclose behavior beyond what annotations already provide? |
| Parameter Semantics     | 15%    | Does it add meaning beyond what the input schema provides?         |
| Conciseness & Structure | 10%    | Is it appropriately sized and front-loaded?                        |
| Contextual Completeness | 10%    | Given the tool's complexity, is the description complete enough?   |

Usage Guidelines and Behavioral Transparency carry the most weight after
Purpose — double-check those two first on any new or edited tool.

## Two rules that override everything below

1. **No unverified claims.** Every behavioral statement in a description —
   not just "the schema allows this input," which is self-evidently true,
   but "here's what happens when you send it" — must be backed by one of:
   - an existing `docs/api-references.md` "confirmed live" entry, cited by
     reference instead of re-asserted from memory;
   - a fresh live call against the real API/account made during this review,
     with the before/after state actually observed;
   - direct reading of the exact function implementing the behavior, when
     it's deterministic code logic rather than an external API's quirk.

   If you can't tick one of these, don't write the claim. "This is probably
   how it works by analogy with a similar field" is exactly how this project
   shipped the `get_media_tags` `lastPage` bug (claimed "computed and
   accurate" when the field was never computed at all) and the
   `get_authorized_user` cross-reference bug (claimed `advancedScoring`
   pointed callers to fetch first, when its own text never said that) —
   both from one session of otherwise-careful editing.

2. **No contradictions between tools.** A claim in tool A's description
   about tool B, a shared value, or a shared behavior must match what B
   actually says and does. When you edit one description, re-read every
   sibling description that cross-references it or shares its underlying
   data — fixing A while leaving a now-false claim in B is still a bug you
   introduced this session, not a pre-existing one.

## Checklist

### Purpose and when to call it

- State what the tool does **and** when to call it — a trigger condition
  ("call this when the user asks about X"), not just a return-value
  description (a measured effect on newer, tool-call-conservative models,
  per Anthropic's own tool-use guidance — not just style).
- Give the tool itself a clear, specific name — verb + resource
  (`get_media_tags`, not `tags`). An agent screens dozens of tool names
  before it ever reads a description; a vague or overlapping name loses the
  match before the description gets a chance to help.
- Name the alternative tool for every pair that could plausibly be confused
  (similar inputs, overlapping domain) — "use X instead of Y when Z" is the
  single highest-leverage fix for this dimension. Make it bidirectional: if
  Y's description points to X, X's own description should acknowledge that
  role (e.g. `get_authorized_user` stating it's the fetch-before-full-replace
  source `update_user` points callers toward).
- Don't split one concept across near-duplicate tools, and don't collapse
  unrelated actions into one tool with a mode flag — one tool, one job,
  matching how this project already groups by domain rather than by raw
  API endpoint.
- When genuinely unsure whether a description will make an agent pick the
  right tool among lookalikes, test it: prompt a fresh model with the
  candidate tools and a representative request, see what it actually picks,
  and adjust the text from that observed choice — not from how it reads to
  you. This checks selection _effectiveness_, a different failure mode from
  the fact-_correctness_ rule above.

### Parameter semantics

- Name a field for what it actually accepts, not a generic suffix (`user`,
  not `user_id`, when it takes either an ID or a username) — this project's
  own naming convention, in [AGENTS.md](../../AGENTS.md)'s Conventions
  section; check new fields against it and against every sibling tool
  handling the same concept.
- If a field's coverage is already ~100% `.describe()` (this project's
  baseline), don't pad prose restating the schema — TDQS's own rubric caps
  this dimension at 3/5 regardless. Only add text for a genuinely non-obvious
  fact the schema can't express on its own.
- Every numeric range or enum the prose promises must be enforced in the Zod
  schema (`.min()`/`.max()`/`z.enum`) — a described bound with no matching
  constraint is a lie the schema doesn't back up.
- Mark a field `required` only if the tool genuinely can't work without it,
  and give every optional field a sensible default (stated in its
  `.describe()` if non-obvious, e.g. `add_list_entry`'s `status` defaulting
  to CURRENT). A truly-required field marked optional forces a caller to
  guess whether omitting it is safe; the reverse adds friction to every call
  for no reason.
- If a field accepts two forms (numeric ID vs. name/string) and only one
  form is validated against real data, say so — e.g. an unknown username
  errors while an unknown numeric ID silently returns an empty result.
  Without this, "no results" and "wrong input" are indistinguishable to the
  caller.

### Mutations — behavioral transparency

- State full-replace-vs-partial-merge **at the exact field**, never inferred
  from the container. A container can merge at the field level while one
  specific field inside it (an array value) is still a full replace when
  set — confirmed for `update_user`'s `customLists` (account level) and for
  `add_list_entry`/`update_list_entry`'s `customLists` (entry level):
  omitting a previously-set list silently drops or disables it, it isn't
  left alone. When two tools independently duplicate the same field with no
  cross-reference between them (not just ones that explicitly reference each
  other), a disclosure added to one doesn't imply the other has it — grep the
  sibling and check, don't assume: confirmed drifted once already
  (`add_list_entry`'s `customLists` got this warning, `update_list_entry`'s
  identical field didn't, in the same commit that added it to the first).
- If the mutation upserts (create-or-update by some key), say so plainly.
  "Everything else is left at defaults" is only true for a genuinely new
  record — on an existing one, omitted fields keep their _previous_ value.
- If a value is matched **positionally** against a separately-configured
  order (e.g. per-category scores matched against a category-name list),
  say that reordering/renaming the category list silently reinterprets
  already-stored values — this is data corruption dressed up as a cosmetic
  rename, not just a UX nit.
- Never claim a capability (privacy, confidentiality, atomicity) the schema
  doesn't wire up. If AniList's own mutation has a `private`/`locked`
  argument this tool doesn't expose, say the _tool_ lacks it — don't imply
  AniList itself lacks it.
- Never contradict an annotation. A description implying a side effect a
  `readOnlyHint: true` tool doesn't have, or implying safety an
  `idempotentHint: true` tool doesn't actually have (e.g. it errors instead
  of no-opping on a repeat call), is an automatic failure on this dimension.

### Reads — behavioral transparency

- Distinguish "genuinely zero results" from "silently filtered out by a
  bad/unrecognized input" wherever AniList doesn't error on a mismatch —
  wrong enum value, unrecognized genre/tag name, nonexistent category or
  media ID passed as a filter. Apply this **consistently across every
  sibling field of the same shape** — if one filter says "an invalid value
  just filters to nothing, not an error," every other field with the
  identical underlying behavior needs the same sentence, not just the one
  you happened to test first.
- A shared/reused description or output-schema caveat (e.g. "this count
  isn't accurate," borrowed from a container schema) must be re-verified
  against _this specific tool's_ actual query — it can be correct for the
  sibling it was copied from and wrong here (e.g. a tool that computes its
  own exact count client-side doesn't inherit AniList's degraded-pagination
  caveat).
- Disclose the return shape's real substance, not just the auth/key caveat —
  fixed caps (`get_studio`'s 10 titles), ordering, and which nested fields a
  specific tool omits that a same-shaped sibling includes (e.g.
  `get_todays_birthdays` skipping the `media`/`staffMedia` filmography that
  `get_character`/`get_staff` return). This is the same rigor as
  `outputSchema`'s own `.describe()` text, not just the top-level
  description's prose.

### Conciseness, title, and structure

- Front-load the single most important fact (what + when) in the first
  sentence — a caller reads the opening far more reliably than the tail of a
  long description. Keep total length proportional to actual complexity: one
  sentence for a simple read, several for a mutation with real caveats —
  don't pad either direction.
- Keep `title` a short, literal human label (e.g. "Add an entry to your
  AniList list") — it's the UI-facing name, not a second description; don't
  duplicate `description`'s content there or leave it vaguer than the tool's
  own name.

## Verify, then fix the implementation before dumbing down the description

When a true fact would make a description more useful but the code doesn't
actually do it yet (e.g. a field the description could confidently promise
if the client computed it), prefer fixing the implementation to match the
better description over writing a weaker, technically-safe sentence — as
long as the fix is small, deterministic, and doesn't change any other
observable behavior. Only fall back to narrowing the claim when the fix
would be a real feature addition, not a one-line gap-filler.

## Full spec

The [repo README](https://github.com/glama-ai/tool-definition-quality-score)
is the complete TDQS methodology: scoring pipeline, exact LLM prompts
(Appendix A), calibration examples, and weight formulas. Read it once for
calibration examples if an edit isn't clearly hitting 4-5 on the dimension
you're targeting.

## Keep this checklist honest against drift

This is an incremental, diff-based check by design — "new or edited"
descriptions — which means a rule added here today says nothing about
whether _already-registered_ tools already violate it. This repo found
exactly that gap live: the "never contradict an annotation" rule above (an
`idempotentHint: true` tool whose own description says a repeat call
errors, not no-ops) was added in a fix commit that corrected _other_ tools'
descriptions — but `delete_activity`/`delete_thread`/
`delete_thread_comment`/`remove_list_entry`'s own `idempotentHint: true`
annotations, exactly what that rule was written to catch, were never
rechecked against it at the same time, and stayed wrong from this repo's
very first release through several audits after (fixed only later, once a
cross-repo review read the annotation against the description directly).

- **A new or tightened rule here implies an immediate retroactive sweep, not
  just future guidance.** When you add or tighten a rule in this file, run
  it against every currently registered tool (not just the one you're
  editing) before considering the update done, and fix what it finds in the
  same pass.
- **Periodically run this whole checklist as a full sweep**, not only on
  new/edited descriptions — e.g. before a release, or whenever asked for a
  broader audit — since incremental diff-based checking alone lets an
  already-registered tool drift out of compliance forever once nobody edits
  it again.
