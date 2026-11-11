#!/usr/bin/env bash
# Runs every CI check that needs no root on this Mac, as .github/workflows/ci.yml defines them
# (CI is paused, ADR-0020). The work is done by scripts/ci/local.mjs; see its header and
# docs/RELEASING.md ("Checking a build on this Mac").
#
# usage: scripts/ci/local.sh [--job <name>]... [--keep-going] [--list] [--dry-run] [--logs <dir>]
#   e.g. scripts/ci/local.sh                      every job that needs no root
#        scripts/ci/local.sh --job daemon         one job
#        scripts/ci/local.sh --keep-going         run the rest after a failure
# The jobs that need root (simulated networks) are run by scripts/ci/local-root.sh.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
command -v node >/dev/null || {
  echo "local-ci: Node.js is not on PATH (CI uses Node.js 22)" >&2
  exit 2
}
exec node "$HERE/local.mjs" "$@"
