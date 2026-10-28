#!/usr/bin/env bash
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec ./start_stream.sh
