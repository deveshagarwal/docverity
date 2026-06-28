#!/usr/bin/env bash
# Builds the demo repo used by scripts/demo.tape (VHS recording). Not shipped.
set -euo pipefail
DIR="/tmp/taskwarden-demo"
rm -rf "$DIR"
mkdir -p "$DIR/src"
cd "$DIR"

cat > src/cli.ts <<'EOF'
export function run(argv: string[]) {
  const json = argv.includes("--json");
  const follow = argv.includes("--follow");
  const token = process.env.TW_API_KEY;
  return { json, follow, token };
}
EOF

cat > src/app.ts <<'EOF'
export const VERSION = "1.0.0";
EOF

cat > README.md <<'EOF'
# taskwarden

A tiny task runner.

## Usage

Run `taskwarden --watch` to re-run on changes, or pass `--json` for machine
output. Set `TASKWARDEN_TOKEN` in your environment to authenticate. The core
loop lives in `src/server.ts`.
EOF
