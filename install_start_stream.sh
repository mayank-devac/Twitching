#!/usr/bin/env bash
set -euo pipefail

# Install a small, explicit shell function. The function points at this checkout
# and never copies credentials or project files into ~/.zshrc.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
zshrc_path=${ZDOTDIR:-${HOME:?HOME is required}}/.zshrc
marker="# >>> twitching start_stream >>>"

if [ ! -x "$repo_root/start_stream.sh" ]; then
  printf '%s\n' "ERROR: $repo_root/start_stream.sh is missing or not executable." >&2
  exit 1
fi

if [ -e "$zshrc_path" ] && ! [ -f "$zshrc_path" ]; then
  printf '%s\n' "ERROR: $zshrc_path exists but is not a regular file." >&2
  exit 1
fi

if [ -f "$zshrc_path" ] && grep -Fqx "$marker" "$zshrc_path"; then
  printf '%s\n' "start_stream is already installed in $zshrc_path; no changes made."
  exit 0
fi

umask 077
mkdir -p "$(dirname -- "$zshrc_path")"
touch "$zshrc_path"
cat >>"$zshrc_path" <<EOF

$marker
start_stream() {
  # The no-argument command opens Twitching's safe welcome screen. Docker is
  # only needed later if the browser flow selects the sandbox runner.
  if command -v colima >/dev/null 2>&1; then
    # Colima is used when the Docker engine is not already reachable. This
    # keeps Docker Desktop settings and registry credentials separate.
    if ! command -v docker >/dev/null 2>&1 || ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
      "$repo_root/with_colima.sh" "$repo_root/start_stream.sh" "\$@"
      return
    fi
  fi

  "$repo_root/start_stream.sh" "\$@"
}
# <<< twitching start_stream <<<
EOF

printf '%s\n' "Installed start_stream in $zshrc_path."
printf '%s\n' 'Run: source ~/.zshrc'
printf '%s\n' 'Then run: start_stream'
