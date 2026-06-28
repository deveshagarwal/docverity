#!/usr/bin/env bash
#
# Demo for recording the launch GIF. Builds a small, realistic project whose
# README has drifted from its code, then runs the published docverity against it.
#
#   ./scripts/demo.sh
#
# Records best at ~90 cols. To use a local build instead of npm:
#   DOCVERITY="node $(pwd)/dist/cli.js" ./scripts/demo.sh
#
# Recording tips:
#   - Warm the npx cache once first (run the script, then record the second run).
#   - asciinema rec demo.cast  ->  agg demo.cast demo.gif
#   - or terminalizer / QuickTime screen capture, cropped to the terminal.

set -uo pipefail

DOCVERITY="${DOCVERITY:-npx --yes docverity@latest}"
DEMO="$(mktemp -d)/taskwarden"
mkdir -p "$DEMO/src"
cd "$DEMO"

# A believable little CLI. Note: --watch became --follow, TASKWARDEN_TOKEN
# became TW_API_KEY, and src/server.ts became src/app.ts — but the README below
# was never updated to match.
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

# ...whose README quietly fell out of sync with it.
cat > README.md <<'EOF'
# taskwarden

A tiny task runner.

## Usage

Run `taskwarden --watch` to re-run on changes, or pass `--json` for machine
output. Set `TASKWARDEN_TOKEN` in your environment to authenticate. The core
loop lives in `src/server.ts`.
EOF

run() { printf '\n\033[1;36m$ %s\033[0m\n' "$*"; eval "$*" || true; }

clear 2>/dev/null || true
printf '\033[1m# taskwarden: the README drifted from the code. Does docverity catch it?\033[0m\n'
run "$DOCVERITY --no-llm"
printf '\n\033[2m# 3 stale claims, each with the file, line, and a suggested fix. Exit 1, fails CI.\033[0m\n\n'
