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

## What it returns

Each finding has a `doc`, `line`, the exact `text`, an `explanation`, a
`confidence`, a `severity` (`error` or `warning`), and usually a `suggestedFix`.

## Verify before you fix — this is the important part

The deterministic engine is a fast, high-recall scanner that matches tokens. It
is deliberately noisy and **you are the verifier**. Before acting on any
finding, read the cited code (and the surrounding documentation) and confirm it
is a real problem. A finding is NOT real when the token is:

- an illustrative example (a sample flag, a loop label, an example env var);
- documented as removed/deprecated (a changelog or migration note);
- another tool's flag (`git`, `npm`, `node`) or a standard env var;
- a real option the code declares by its bare name (`output-file`, not `--output-file`).

For each finding you confirm is real, open the doc at that line and make the
minimal edit that makes the claim true again. Do not "fix" claims it did not
flag, and do not blindly trust a finding without reading the code.

When Docverity runs as an MCP server inside a host that supports sampling, it
already does this adjudication for you using your model — but when you run the
CLI yourself, do the verification by reading the code before editing.
