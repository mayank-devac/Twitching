# Shared helpers for setup.sh, doctor.sh, with_colima.sh and install_start_stream.sh.
# Source it after `cd` into the repository root. Bash 3.2 (macOS) compatible.
# Nothing here reads credentials: login checks only test that a file exists.

TWITCHING_ISSUES_URL="https://github.com/mayank-devac/Twitching/issues"
# Colima VM size for a new profile: two agent containers (2 CPU / 2 GB each) plus previews.
COLIMA_CPUS=4
COLIMA_MEMORY_GB=6
COLIMA_DISK_GB=20

if [ -t 1 ]; then
  c_ok=$'\033[32m' c_warn=$'\033[33m' c_fail=$'\033[31m' c_dim=$'\033[2m' c_end=$'\033[0m'
else
  c_ok='' c_warn='' c_fail='' c_dim='' c_end=''
fi
say_ok() { printf '%s\n' "${c_ok}OK${c_end}   $*"; }
say_warn() { printf '%s\n' "${c_warn}WARN${c_end} $*"; }
say_fail() { printf '%s\n' "${c_fail}FAIL${c_end} $*" >&2; }
say_fix() { printf '%s\n' "     ${c_dim}fix:${c_end} $*"; }
have() { command -v "$1" >/dev/null 2>&1; }
interactive() { [ -t 0 ] && [ -t 1 ] && [ "${TWITCHING_YES:-0}" != 1 ]; }

# ask "Question?" default(y|n) → 0 for yes. Non-interactive runs take the default,
# except TWITCHING_YES=1 (setup.sh --yes) which answers yes.
ask() {
  local question=$1 default=${2:-n} answer hint="[y/N]"
  [ "$default" = y ] && hint="[Y/n]"
  if [ "${TWITCHING_YES:-0}" = 1 ]; then return 0; fi
  if ! [ -t 0 ]; then [ "$default" = y ]; return; fi
  read -r -p "$question $hint: " answer || answer=
  [ -z "$answer" ] && answer=$default
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Prints home-relative paths so reports never expose the account name.
tidy_path() { case "$1" in "$HOME"*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }

node_ok() { have node && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; }
docker_up() { have docker && docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; }

colima_running() { have colima && colima status >/dev/null 2>&1; }
colima_profile_exists() { have colima && colima list 2>/dev/null | awk 'NR > 1 && $1 == "default" { found = 1 } END { exit !found }'; }
colima_socket() { colima status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).docker_socket||"")}catch{}})' 2>/dev/null; }
# True when the docker CLI talks to Colima (DOCKER_HOST or the active context).
docker_is_colima() {
  colima_running || return 1
  local socket endpoint
  socket=$(colima_socket)
  [ -n "$socket" ] || return 1
  endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)}
  [ "$endpoint" = "$socket" ]
}
repo_outside_home() { case "$1/" in "$HOME"/*) return 1 ;; *) return 0 ;; esac; }
# Mount flags: home (Colima's default, keeps other projects working) + the clone if outside home.
colima_mount_args() {
  printf '%s\n' --mount "$HOME:w"
  if repo_outside_home "$1"; then printf '%s\n' --mount "$1:w"; fi
}
# Start Colima; a brand-new profile gets enough CPU/RAM/disk and shares the clone.
colima_start() {
  local root=$1 args=()
  if ! colima_profile_exists; then
    args=(--cpu "$COLIMA_CPUS" --memory "$COLIMA_MEMORY_GB" --disk "$COLIMA_DISK_GB")
    while IFS= read -r arg; do args+=("$arg"); done < <(colima_mount_args "$root")
  fi
  colima start "${args[@]+"${args[@]}"}"
}
# Restart Colima sharing home (+ clone). Running containers stop.
colima_reshare() {
  local root=$1 args=()
  while IFS= read -r arg; do args+=("$arg"); done < <(colima_mount_args "$root")
  colima stop && colima start "${args[@]}"
}
# Can containers see a folder created just now inside the clone? Needs a local image.
project_visible() {
  local root=$1 image=$2 dir attempt
  dir="$root/runtime/workspaces/.share-probe-$$-$RANDOM"
  mkdir -p "$dir" && : >"$dir/ok" || return 1
  for attempt in 1 2 3 4 5; do
    if docker run --rm --network none --user 0:0 --entrypoint test \
      --mount "type=bind,source=$dir,target=/probe,readonly" "$image" -e /probe/ok >/dev/null 2>&1; then
      rm -rf "$dir"; return 0
    fi
    sleep 1
  done
  rm -rf "$dir"
  return 1
}
image_present() { docker image inspect "$1" >/dev/null 2>&1; }
# settings.json value with a fallback, without requiring node.
setting() {
  local key=$1 fallback=$2 value=""
  if have node && [ -f settings.json ]; then
    value=$(node -e 'try{const v=JSON.parse(require("fs").readFileSync("settings.json","utf8"))[process.argv[1]];if(v!==undefined)process.stdout.write(String(v))}catch{}' "$key" 2>/dev/null)
  fi
  printf '%s' "${value:-$fallback}"
}
# Which shell startup file to edit for this user.
shell_rc() {
  case "$(basename -- "${SHELL:-}")" in
    bash) if [ "$(uname)" = Darwin ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi ;;
    *) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
  esac
}
