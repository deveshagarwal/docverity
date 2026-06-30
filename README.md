# Docverity

[![npm](https://img.shields.io/npm/v/docverity?color=cb3837&logo=npm)](https://www.npmjs.com/package/docverity)
[![CI](https://github.com/deveshagarwal/docverity/actions/workflows/ci.yml/badge.svg)](https://github.com/deveshagarwal/docverity/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/docverity?color=blue)](LICENSE)

**AI made documentation rot an epidemic.**

![Docverity reviewing a stale README and drafting the fixes](docs/demo.gif)

Code changes by the hour, and AI assistants only make it faster. Documentation
does not keep up. Docverity reads your documentation, extracts the concrete
claims it makes about the codebase, and checks each one against the source.
Drift becomes a failing check in CI, the same way a broken test would.

Tools like `doctest` and `mdbook test` run the code blocks embedded in your
docs. Docverity verifies the prose around them: the flags, options, environment
variables, paths, and behavior your documentation describes are checked against
what the code actually does.

## The checks

Docverity runs several complementary checks:

- **Reference checker**: deterministic, no API key, instant. Catches docs that
  mention files, CLI flags, environment variables, or symbols that no longer
  exist anywhere in the source.
- **Claim verifier**: LLM-backed, catches prose-level semantic drift: "the
  default timeout is 30s", "this returns a list", "set `FOO=bar` to enable X".
  Runs when `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is set.
- **Coverage**: the reverse direction, surface the code exposes that the docs
  never mention. Deterministically it catches CLI flags, environment variables,
  subcommands, and accepted option/enum values. When a model is reachable it
  also runs a **capability pass** that catches undocumented *behavior* a token
  match cannot see: a new mode, an output format, an integration surface, a
  changed default. On by default, reported as warnings.
- **Narrative**: whether a section that describes the system is still a faithful
  account of it. Deterministically it flags a section whose stated count
  disagrees with its list ("three checks" above four bullets). With a model it
  flags a descriptive section, a pipeline or enumeration, that omits a step the
  code actually runs, the failure mode where no single claim is false but the
  account is incomplete.

In a git repository, coverage is **history-aware**: it finds the last commit
that touched the docs and elevates any undocumented surface the code added
*after* that point (a far stronger "you forgot to document this" signal than a
bare token absence), and reports how many commits the docs now lag behind. It
degrades silently outside git or in a shallow clone.

Works free out of the box. Gets smarter with a key.

Docverity is not JavaScript-only. The reference checker is language-agnostic (it
searches the source tree for tokens), and coverage detects environment variables
and flags in Python, Go, Java, and Ruby as well as JS/TS. It reads Markdown,
reStructuredText, AsciiDoc, and plain-text docs.

Every finding has a **severity**: `error` (a reader acts on it and gets burned)
or `warning` (real but not blocking). By default only errors fail the build, so
a slight issue is reported without breaking CI. Tune it with `--fail-on`.

## Install

```bash
npm install -g docverity
```

Or run without installing:

```bash
npx docverity
```

## Usage

From your repo root:

```bash
docverity
```

By default it checks `README.md` and every `.md` file under `docs/`. Pass files
explicitly to narrow the scope, and use `-C` to point at another root:

```bash
docverity -C path/to/repo
```

Skip the model entirely for a fast, deterministic-only run:

```bash
docverity --no-llm
```

When a model is available, Docverity runs an **adjudication pass** that dismisses
the false positives a token matcher can't tell from real drift (illustrative
examples, flags documented as removed, other tools' commands). It finds a model
in this order, and needs no setup if you already use Claude Code:

1. `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`),
2. the `claude` CLI (Claude Code) if it is on your PATH, using your subscription,
3. when running as an MCP server, the host's model via MCP sampling.

### Options

| Flag | Description |
| --- | --- |
| `-C, --root <dir>` | Repo root to check (default: current directory). |
| `--no-llm` | Deterministic checks only; no API calls. |
| `--model <id>` | Model for the LLM engine (default `claude-opus-4-8`). |
| `--no-coverage` | Skip the code-to-docs check for undocumented flags/env vars. |
| `--fail-confidence <n>` | Minimum confidence (0..1) to report a finding. Default `0.7`. |
| `--fail-on <level>` | Lowest severity that fails the build: `error` (default), `warning`, `info`, or `none`. |
| `--strict` | Also fail on unverifiable claims. |
| `--format <fmt>` | `pretty` (default), `json`, or `github`. |

Docverity fails CI the way a linter would. Exit codes: `0` clean (or warnings
only), `1` a finding at or above `--fail-on` severity, `2` a configuration error
(e.g. an invalid `--fail-confidence`/`--fail-on` or a missing doc file) so a
typo can never mask real drift with a green build.

## Draft the missing docs

Detection tells you what's missing; `suggest` writes it for you. It reads what
the code exposes and drafts the documentation to cover everything the docs
don't, real markdown, grounded in a deterministic scan of the undocumented
surface and in the source so the prose is accurate:

```bash
docverity suggest
```

By default it prints the drafted improvements (a command's options table, an
environment-variables section, a revised pipeline). Pass `--write` to append
them to a doc file between replaceable markers, additive, so nothing you wrote
is overwritten and re-running refreshes the same block:

```bash
docverity suggest --write           # appends to README (or the first doc)
docverity suggest --write --into docs/cli.md
```

`suggest` needs a model, found the same way the check does (`ANTHROPIC_API_KEY`,
the `claude` CLI, or an MCP host).

## In CI (GitHub Actions)

```yaml
name: docs
on: [pull_request]
jobs:
  docverity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx docverity --format github
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

With `--format github`, drifted claims appear as inline annotations on the
changed lines of the pull request.

## Use it from an agent (MCP)

Docverity ships an MCP server so a coding agent can check docs as a tool and fix
drift in the same turn it changed the code. Add it to your MCP client:

```json
{
  "mcpServers": {
    "docverity": {
      "command": "npx",
      "args": ["docverity", "mcp"]
    }
  }
}
```

This exposes one tool, `check_docs`, which returns each drifted claim with its
file, line, the stale text, code evidence, a confidence score, and a suggested
fix the agent can apply directly. It runs the deterministic engine by default
(fast, free, no key); pass `llm: true` to also verify prose claims. It accepts
`root`, `docs`, `coverage` (default true), and `failConfidence` (default 0.7).
When the host supports MCP sampling, findings are adjudicated and the capability
pass runs using the host's model, with no API key of docverity's own. In a git
repo the summary also reports `docsLastChanged` and `commitsSinceDocs`, so the
agent knows how far the docs lag the code it just changed.

A [`SKILL.md`](SKILL.md) is included so the agent knows when to reach for it
(after editing code, before a release, when asked whether the docs are correct).

## How it works

Docverity makes several passes and merges the results:

1. **Extract**: parse each doc into atomic claims (a flag, a path, an env var, a
   symbol, a subcommand, or a prose assertion).
2. **Locate**: search the source tree (via ripgrep when available) for evidence
   of each claim. Documentation files are excluded from evidence: a claim must
   be backed by code, not by the docs restating it.
3. **Verify drift** (docs to code): the reference engine confirms each token
   still exists; the LLM engine judges prose claims (values, defaults, behavior)
   against the located evidence and returns ok / drifted / unverifiable.
4. **Coverage** (code to docs): scan the public surface the code exposes (flags,
   env vars, subcommands, option values) and report what the docs never mention.
   With a model, a capability pass adds undocumented *behavior*; in a git repo,
   surface the code added after the docs last changed is elevated.
5. **Narrative**: check that sections describing the system (a pipeline, an
   enumeration) are still complete and self-consistent accounts of the code.
6. **Adjudicate**: when a model is reachable, hand the candidate findings back to
   it to drop the false positives a token matcher cannot tell from real drift
   (illustrative examples, flags documented as removed, other tools' tokens).
7. **Report**: pretty output, machine-readable JSON, or GitHub annotations, each
   finding carrying a severity.

## License

MIT
