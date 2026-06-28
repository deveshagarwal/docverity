---
name: docverity
description: Check whether a project's documentation still matches its code, and report stale or wrong claims with suggested fixes. Use this after editing, renaming, moving, or deleting source files, CLI flags, environment variables, or functions, to catch docs you may have just made inaccurate; when the user asks whether the README or docs are still correct; before a release; or when reviewing a pull request that changes code.
---

# Docverity

Docverity verifies that the claims a project's documentation makes about its
code are still true. It catches doc rot: a renamed flag, a removed environment
variable, a deleted file, a changed default, a fabricated return type.

## When to use it

Run Docverity whenever code changes might have invalidated the docs:

- Right after you edit, rename, move, or delete source files, CLI flags, env
  vars, or functions.
- When the user asks "are the docs still accurate?" or "is the README correct?"
- Before cutting a release.
- When reviewing a PR that changes code.

## How to run it

If the Docverity MCP server is connected, call the `check_docs` tool. Otherwise
run the CLI in the repo root:

```bash
npx docverity --format json
```

Add `--no-llm` for a fast, free, deterministic-only pass. The deterministic
engine needs no API key; set `ANTHROPIC_API_KEY` (or pass `llm=true` to the
tool) to also verify prose-level claims like default values and behavior.

## What it returns and how to act

Each finding has a `doc`, `line`, the exact stale `text`, an `explanation`, a
`confidence`, and usually a `suggestedFix`. For each drifted claim, open the
doc at that line and apply a minimal edit that makes the claim true again. Do
not "fix" claims it did not flag. Prefer the deterministic findings (engine
`reference`) — they are highest confidence.
