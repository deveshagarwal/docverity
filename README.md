# Docverity

**AI made documentation rot an epidemic.**

![Docverity catching documentation drift](docs/demo.gif)

Code changes by the hour, and AI assistants only make it faster. Documentation
does not keep up. Docverity reads your documentation, extracts the concrete
claims it makes about the codebase, and checks each one against the source.
Drift becomes a failing check in CI, the same way a broken test would.

Tools like `doctest` and `mdbook test` run the code blocks embedded in your
docs. Docverity verifies the prose around them: the flags, options, environment
variables, paths, and behavior your documentation describes are checked against
what the code actually does.

## Two engines

Docverity ships with two complementary engines:

- **Reference checker** — deterministic, no API key, instant. Catches docs that
  mention files, CLI flags, environment variables, or symbols that no longer
  exist anywhere in the source.
- **Claim verifier** — LLM-backed, catches prose-level semantic drift: "the
  default timeout is 30s", "this returns a list", "set `FOO=bar` to enable X".
  Runs when `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is set.
- **Coverage** — the reverse direction: flags and environment variables the
  code uses that the docs never mention. On by default, reported as warnings.

Works free out of the box. Gets smarter with a key.

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

Skip the LLM engine for a fast, deterministic-only run:

```bash
docverity --no-llm
```

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
(fast, free, no key); pass `llm: true` to also verify prose claims.

A [`SKILL.md`](SKILL.md) is included so the agent knows when to reach for it
(after editing code, before a release, when asked whether the docs are correct).

## How it works

1. **Extract** — parse each doc into atomic claims (a flag, a path, an env var,
   a symbol, or a prose assertion).
2. **Locate** — search the source tree (via ripgrep when available) for evidence
   of each claim. Documentation files are excluded from evidence: a claim must
   be backed by code, not by the docs restating it.
3. **Verify** — the reference engine checks for hard evidence; the LLM engine
   judges prose claims against the located evidence and returns
   ok / drifted / unverifiable with a specific reason.
4. **Report** — pretty output, machine-readable JSON, or GitHub annotations.

## License

MIT
