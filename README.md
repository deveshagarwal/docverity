# Docverity

**Catch documentation that lies about your code.**

![Docverity catching documentation drift](docs/demo.gif)

Docverity reads your docs, extracts the concrete claims they make about your
codebase, and checks each one against the actual source. When a documented flag
gets renamed, a config default changes, or a referenced file is deleted, your
docs silently start lying. Docverity turns that into a failing check, in CI,
before your users hit it.

Existing tools run the code blocks in your docs (`doctest`, `mdbook test`) or
help you author and host docs. None of them verify that the *prose* still tells
the truth about the code. That is the gap Docverity fills.

## Two engines

Docverity ships with two complementary engines:

- **Reference checker** — deterministic, no API key, instant. Catches docs that
  mention files, CLI flags, environment variables, or symbols that no longer
  exist anywhere in the source.
- **Claim verifier** — LLM-backed, catches prose-level semantic drift: "the
  default timeout is 30s", "this returns a list", "set `FOO=bar` to enable X".
  Runs when `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is set.

Works free out of the box. Gets smarter with a key.

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
| `--no-llm` | Deterministic checks only; no API calls. |
| `--model <id>` | Model for the LLM engine (default `claude-opus-4-8`). |
| `--fail-confidence <n>` | Minimum confidence (0..1) to fail the build on. Default `0.7`. |
| `--strict` | Also fail on unverifiable claims. |
| `--format <fmt>` | `pretty` (default), `json`, or `github`. |

Docverity exits non-zero when it finds drift above the confidence threshold, so
it fails CI the way a linter would. Exit codes: `0` clean, `1` drift found,
`2` a configuration error (e.g. an invalid `--fail-confidence` or a missing doc
file) so a typo can never mask real drift with a green build.

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
