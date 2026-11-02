#!/usr/bin/env bash
# Session mode controls: opens the welcome page for coding sessions. Accepts only --chats.
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec ./start_stream.sh sessions "$@"
