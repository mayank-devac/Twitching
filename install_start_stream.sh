#!/usr/bin/env bash
set -euo pipefail

# Install small, explicit shell functions. They point at this checkout and
# never copy credentials or project files into ~/.zshrc.
#   start_stream    welcome page (no flags) or guided arena (with flags)
#   start_arena     prompt arena controls: guided arena startup
#   start_sessions  session mode controls: welcome page for coding sessions
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
zshrc_path=${ZDOTDIR:-${HOME:?HOME is required}}/.zshrc
marker="# >>> twitching start_stream >>>"
end_marker="# <<< twitching start_stream <<<"
version_line="# twitching launcher v2: start_stream start_arena start_sessions"

for script in start_stream.sh start_arena.sh start_sessions.sh with_colima.sh; do
  if [ ! -x "$repo_root/$script" ]; then
    printf '%s\n' "ERROR: $repo_root/$script is missing or not executable. Run: chmod +x $script" >&2
    exit 1
  fi
done

if [ -e "$zshrc_path" ] && ! [ -f "$zshrc_path" ]; then
  printf '%s\n' "ERROR: $zshrc_path exists but is not a regular file." >&2
  exit 1
fi

umask 077
mkdir -p "$(dirname -- "$zshrc_path")"
touch "$zshrc_path"

if grep -Fqx "$version_line" "$zshrc_path"; then
  printf '%s\n' "start_stream, start_arena and start_sessions are already installed in $zshrc_path; no changes made."
  exit 0
fi

# An older install has only start_stream: replace that marked block, keep the rest.
if grep -Fqx "$marker" "$zshrc_path"; then
  if ! grep -Fqx "$end_marker" "$zshrc_path"; then
    printf '%s\n' "ERROR: $zshrc_path has '$marker' without its end line. Remove the old block by hand, then rerun." >&2
    exit 1
  fi
  cp -p "$zshrc_path" "$zshrc_path.twitching-backup"
  tmp=$(mktemp "${zshrc_path}.XXXXXX")
  awk -v start="$marker" -v end="$end_marker" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$zshrc_path" >"$tmp"
  cat "$tmp" >"$zshrc_path"
  rm -f "$tmp"
  printf '%s\n' "Replaced the old start_stream block (backup: $zshrc_path.twitching-backup)."
fi

cat >>"$zshrc_path" <<EOF

$marker
$version_line
_twitching_launch() {
  # Docker is only needed later if the chosen flow uses the sandbox runner.
  local script="\$1"
  shift
  if command -v colima >/dev/null 2>&1; then
    # Colima is used when the Docker engine is not already reachable. This
    # keeps Docker Desktop settings and registry credentials separate.
    if ! command -v docker >/dev/null 2>&1 || ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
      "$repo_root/with_colima.sh" "$repo_root/\$script" "\$@"
      return
    fi
  fi
  "$repo_root/\$script" "\$@"
}
start_stream() { _twitching_launch start_stream.sh "\$@"; }
start_arena() { _twitching_launch start_arena.sh "\$@"; }
start_sessions() { _twitching_launch start_sessions.sh "\$@"; }
$end_marker
EOF

printf '%s\n' "Installed start_stream, start_arena and start_sessions in $zshrc_path."
printf '%s\n' 'Run: source ~/.zshrc'
printf '%s\n' 'Then run: start_arena     (prompt arena controls)'
printf '%s\n' '      or: start_sessions  (session mode controls)'
