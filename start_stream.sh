#!/usr/bin/env bash
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  printf '%s\n' 'ERROR: Node.js 24 or newer is required. Install it, reopen your terminal, then run this file again.' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'ERROR: Docker is required for previews and for the arena Codex login. Install Docker Desktop, open it, then run this file again.' >&2
  exit 1
fi
if [ ! -x node_modules/.bin/tsx ]; then
  printf '%s\n' 'ERROR: App dependencies are missing. Run: npm ci' >&2
  if [ -t 0 ] && [ -t 1 ]; then
    read -r -p 'Install the app dependencies now? [y/N]: ' answer
    case "$answer" in y|Y|yes|YES) npm ci ;; *) exit 1 ;; esac
  else
    exit 1
  fi
fi
exec node_modules/.bin/tsx scripts/stream.ts start "$@"
