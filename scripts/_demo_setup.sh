#!/usr/bin/env bash
# Clones the famous repo used by scripts/demo.tape (VHS recording). Not shipped.
# oclif (the Node CLI framework) reads several env vars its docs never mention —
# a dense, real coverage finding that makes a good demo.
set -euo pipefail
DIR="/tmp/docverity-demo-oclif"
if [ ! -d "$DIR" ]; then
  git clone --depth 1 --single-branch -q https://github.com/oclif/core "$DIR"
fi
