---
name: prompt-check
description: Live-test every MCP Prompt in src/prompts.ts through the real MCP protocol (not a static read) across every argument combination. Use when a prompt is added or its argument-handling logic changes, or as part of a live-audit pass.
---

# Prompt check — live-test every MCP Prompt argument combination

A static read comparing prompt text against tool names/params misses
argument-handling bugs. Actually render every prompt through the real MCP
protocol:

```sh
npx @modelcontextprotocol/inspector --cli node dist/index.js --method prompts/list
npx @modelcontextprotocol/inspector --cli node dist/index.js --method prompts/get \
  --prompt-name <name> --prompt-args key=value key2=value2
```

`--prompt-args` takes space-separated `key=value` pairs, **not** a JSON blob
— the CLI rejects JSON with "Invalid parameter format".

Run each prompt with:

- No args.
- Only one of several optional args set at a time — an argument that's
  individually optional can still have a bug that only shows up when given
  alone (e.g. a prompt silently ignoring `year` because its branching logic
  required `season` to also be present, even though the two are independent
  filters on the underlying tool).
- All optional args set together.

Read-only, no-account-risk — never route this through anything that touches
mutations.
