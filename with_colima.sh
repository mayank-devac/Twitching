#!/usr/bin/env bash
set -euo pipefail
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

for tool in node colima docker docker-compose docker-buildx; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing tool: %s\nInstall Node.js 24+ and run: brew install colima docker docker-compose docker-buildx\n' "$tool" >&2
    exit 1
  fi
done

. scripts/shell-lib.sh
# Ask Colima for its socket instead of inheriting another Docker context.
# A brand-new profile is sized for two agents and shares this clone.
if ! colima_status=$(colima status --json 2>/dev/null); then
  colima_start "$PWD"
  colima_status=$(colima status --json)
fi
export DOCKER_HOST
DOCKER_HOST=$(printf '%s' "$colima_status" | node -e '
  const fs = require("node:fs");
  const status = JSON.parse(fs.readFileSync(0, "utf8"));
  if (status.runtime !== "docker" || !status.docker_socket?.startsWith("unix://")) {
    console.error("Colima must be running with the Docker runtime.");
    process.exit(1);
  }
  process.stdout.write(status.docker_socket);
')
unset DOCKER_CONTEXT

# Public image downloads need no saved registry login or Desktop helper.
# Keep this profile separate from both personal Docker settings and CLI auth.
export DOCKER_CONFIG="$PWD/runtime/docker-cli"
mkdir -p "$DOCKER_CONFIG/cli-plugins"
ln -sfn "$(command -v docker-compose)" "$DOCKER_CONFIG/cli-plugins/docker-compose"
ln -sfn "$(command -v docker-buildx)" "$DOCKER_CONFIG/cli-plugins/docker-buildx"

if [ "$#" -eq 0 ]; then
  set -- ./start_stream.sh --mode rehearsal --runner docker
fi
exec "$@"
