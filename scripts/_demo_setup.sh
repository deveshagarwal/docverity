#!/usr/bin/env bash
# Builds the synthetic repo for scripts/demo.tape: a docverity-themed CLI whose
# README went stale. Real docverity is clean on itself, so we stage the rot to
# illustrate the checks (a self-review in spirit). Git history is dated so the
# staleness headline and "added after the docs" elevation fire.
set -euo pipefail
DIR="/tmp/docverity-demo"
rm -rf "$DIR"
mkdir -p "$DIR/src"
cd "$DIR"
git init -q
git config user.email demo@docverity.dev
git config user.name docverity
git config commit.gpgsign false

cat > package.json <<'EOF'
{ "name": "docverity", "version": "0.5.0", "bin": { "docverity": "src/cli.js" } }
EOF

# Commit 1: the tool starts with only `check`.
cat > src/cli.js <<'EOF'
const { program } = require("commander");
program.name("docverity").description("Catch documentation that lies about your code.");
program.command("check").option("--format <f>", "pretty | json | github");
program.parse();
EOF
git add -A
GIT_AUTHOR_DATE="2026-02-10T00:00:00" GIT_COMMITTER_DATE="2026-02-10T00:00:00" \
  git commit -qm "check command"

# Commit 2: the README is written. This is the doc baseline. It miscounts its
# own list ("two checks", three bullets) and predates everything below.
cat > README.md <<'EOF'
# Docverity

Catch documentation that lies about your code.

## Two checks

Docverity runs two checks:

- reference
- coverage
- narrative

Run `docverity check --format json`.
EOF
git add -A
GIT_AUTHOR_DATE="2026-03-01T00:00:00" GIT_COMMITTER_DATE="2026-03-01T00:00:00" \
  git commit -qm "docs"

# Commit 3 (after the docs): ship new surface, never update the README.
cat > src/cli.js <<'EOF'
const { program } = require("commander");
program.name("docverity").description("Catch documentation that lies about your code.");
program.command("check")
  .option("--format <f>", "pretty | json | github")
  .option("--fail-on <level>", "error | warning | none")
  .action(() => { const key = process.env.DOCVERITY_TOKEN; });
program.command("suggest").description("Draft the missing docs.");
program.command("mcp").description("Run as an MCP server.");
program.parse();
EOF
git add -A
GIT_AUTHOR_DATE="2026-06-20T00:00:00" GIT_COMMITTER_DATE="2026-06-20T00:00:00" \
  git commit -qm "add suggest + mcp commands, --fail-on, token"
