#!/usr/bin/env bash
set -euo pipefail

# Install small, explicit shell functions into your shell startup file
# (~/.zshrc for zsh; ~/.bash_profile on macOS or ~/.bashrc on Linux for bash).
# They point at this clone and never copy credentials or project files.
#   start_arena       prompt arena controls: guided arena startup
#   start_sessions    session mode controls: welcome page for coding sessions
#   start_stream      welcome page (no flags) or guided arena (with flags)
#   twitching_doctor  read-only diagnostics report
# Override the file with: TWITCHING_RC=~/.some_rc ./install_start_stream.sh
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd -- "$repo_root"
. scripts/shell-lib.sh
rc_path=${TWITCHING_RC:-$(shell_rc)}
marker="# >>> twitching start_stream >>>"
end_marker="# <<< twitching start_stream <<<"
version_line="# twitching launcher v3: start_stream start_arena start_sessions twitching_doctor"

for script in start_stream.sh start_arena.sh start_sessions.sh with_colima.sh doctor.sh; do
  if [ ! -x "$repo_root/$script" ]; then
    printf '%s\n' "ERROR: $repo_root/$script is missing or not executable. Run: git pull && chmod +x $script" >&2
    exit 1
  fi
done

if [ -e "$rc_path" ] && ! [ -f "$rc_path" ]; then
  printf '%s\n' "ERROR: $rc_path exists but is not a regular file." >&2
  exit 1
fi

umask 077
mkdir -p "$(dirname -- "$rc_path")"
touch "$rc_path"

# Already current and pointing at this clone: nothing to do. A block for another
# (moved or deleted) clone, or an older version, is replaced below.
if grep -Fqx "$version_line" "$rc_path" &&
  grep -Fq "\"$repo_root/\$script\" \"\$@\"" "$rc_path"; then
  printf '%s\n' "Twitching commands in $rc_path already point at $repo_root; no changes made."
  exit 0
fi

if grep -Fqx "$marker" "$rc_path"; then
  if ! grep -Fqx "$end_marker" "$rc_path"; then
    printf '%s\n' "ERROR: $rc_path has '$marker' without its end line. Remove the old block by hand, then rerun." >&2
    exit 1
  fi
  cp -p "$rc_path" "$rc_path.twitching-backup"
  tmp=$(mktemp "${rc_path}.XXXXXX")
  awk -v start="$marker" -v end="$end_marker" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$rc_path" >"$tmp"
  cat "$tmp" >"$rc_path"
  rm -f "$tmp"
  printf '%s\n' "Replaced the previous Twitching block (backup: $rc_path.twitching-backup)."
fi

# Works in both bash and zsh.
cat >>"$rc_path" <<EOF

$marker
$version_line
_twitching_launch() {
  local script="\$1"
  shift
  if [ ! -x "$repo_root/\$script" ]; then
    printf '%s\n' "Twitching commands point at $repo_root, but \$script is not there (moved, deleted or not updated)." "Fix: cd into your Twitching clone (git pull if needed), run ./install_start_stream.sh, then open a new terminal." >&2
    return 1
  fi
  # Docker is only needed when the chosen flow uses the sandbox runner. Colima is
  # started when installed and no Docker engine is reachable.
  if [ "\$script" != doctor.sh ] && command -v colima >/dev/null 2>&1; then
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
twitching_doctor() { _twitching_launch doctor.sh "\$@"; }
$end_marker
EOF

printf '%s\n' "Installed start_arena, start_sessions, start_stream and twitching_doctor in $rc_path."
printf '%s\n' "Open a new terminal (or run: source $rc_path), then:"
printf '%s\n' '  start_arena       prompt arena controls'
printf '%s\n' '  start_sessions    session mode controls'
printf '%s\n' '  twitching_doctor  diagnostics if something goes wrong'
