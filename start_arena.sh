#!/usr/bin/env bash
# Prompt arena controls: the guided arena startup (mode, runner, sessions, checks).
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec ./start_stream.sh arena "$@"
