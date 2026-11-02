#!/usr/bin/env bash
# One-time guided setup for a fresh clone. Safe to rerun: every step checks
# first and only changes what is missing. Nothing here reads credentials.
#
#   ./setup.sh          ask before each change
#   ./setup.sh --yes    accept every change (CLI logins are still skipped; they need you)
set -uo pipefail
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
root=$PWD
. scripts/shell-lib.sh

case "${1:-}" in
  --yes|-y) export TWITCHING_YES=1 ;;
  --help|-h) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) printf 'Unknown option: %s (use --yes or --help)\n' "$1" >&2; exit 2 ;;
esac

os=$(uname)
problems=0
step() { printf '\n== %s ==\n' "$*"; }
problem() { say_fail "$1"; [ -n "${2:-}" ] && say_fix "$2"; problems=$((problems + 1)); }

printf 'Twitching setup in %s (%s %s)\n' "$(tidy_path "$root")" "$os" "$(uname -m)"
[ "$os" = Darwin ] || [ "$os" = Linux ] || problem "Unsupported system $os" "Use macOS or Linux (on Windows, run inside WSL2)."

step "1/7 Node.js 24+"
if node_ok; then
  say_ok "node $(node -v)"
elif [ "$os" = Darwin ] && have brew && ask "Install Node.js with Homebrew (brew install node)?" y; then
  brew install node && node_ok && say_ok "node $(node -v)" || problem "Node.js 24+ is still missing" "Install it from https://nodejs.org, reopen the terminal, rerun ./setup.sh."
else
  problem "Node.js 24 or newer is required" "Install it from https://nodejs.org (or: brew install node / your package manager), reopen the terminal, rerun ./setup.sh."
  printf '\nStopping: the remaining steps need Node.js.\n' >&2
  exit 1
fi

step "2/7 App dependencies"
if [ -x node_modules/.bin/tsx ] && npm ls --depth=0 >/dev/null 2>&1; then
  say_ok "node_modules is current"
elif ask "Install app dependencies (npm ci)?" y; then
  npm ci && say_ok "dependencies installed" || problem "npm ci failed" "Read the npm error above. Common causes: no network, or an older npm (npm i -g npm)."
else
  problem "Dependencies are missing" "Run: npm ci"
fi

step "3/7 Local config files"
mkdir -p runtime && chmod 700 runtime
if [ -e .env.local ]; then
  say_ok ".env.local exists (not opened)"
else
  umask 077; cp .env.example .env.local
  say_ok "created .env.local from .env.example — fill in only the platforms you use (all optional for rehearsal)"
fi
[ -e prompts.txt ] || { printf '# One task per line. Lines starting with # are ignored.\n' >prompts.txt; say_ok "created an empty prompts.txt"; }
[ -e "$(setting musicPath assets/break.mp3)" ] || say_warn "no break music ($(setting musicPath assets/break.mp3)); breaks will be silent. Add your own mp3 any time."

step "4/7 Docker engine (Colima or Docker Desktop)"
if docker_up; then
  if docker_is_colima; then say_ok "Docker via Colima"; else say_ok "Docker engine reachable ($(docker context show 2>/dev/null || echo default))"; fi
elif have colima; then
  if ask "Start Colima now?" y; then
    colima_start "$root" && docker_up && say_ok "Colima started" || problem "Colima did not start" "Run colima start and read its error; colima delete then rerun ./setup.sh resets a broken VM."
  else
    problem "Docker is not running" "Run colima start, then rerun ./setup.sh."
  fi
elif [ "$os" = Darwin ] && [ -d /Applications/Docker.app ]; then
  open -a Docker
  printf 'Opening Docker Desktop; waiting up to 90s for its engine…\n'
  for _ in $(seq 1 45); do docker_up && break; sleep 2; done
  docker_up && say_ok "Docker Desktop is running" || problem "Docker Desktop did not become ready" "Finish Docker Desktop's first-run screens, then rerun ./setup.sh."
elif [ "$os" = Darwin ] && have brew && ask "Install Colima + Docker CLI with Homebrew (no Docker Desktop needed)?" y; then
  brew install colima docker docker-compose docker-buildx && colima_start "$root" && docker_up \
    && say_ok "Colima installed and started" || problem "Colima install/start failed" "Read the error above, then rerun ./setup.sh."
else
  problem "No Docker engine found" "macOS: brew install colima docker docker-compose docker-buildx (or install Docker Desktop). Linux: install Docker Engine (https://docs.docker.com/engine/install/) and add yourself to the docker group: sudo usermod -aG docker \$USER, then log out and in."
fi
# A Homebrew docker CLI needs compose/buildx registered as plugins.
if docker_up && ! docker compose version >/dev/null 2>&1; then
  if have docker-compose; then
    mkdir -p "$HOME/.docker/cli-plugins"
    ln -sfn "$(command -v docker-compose)" "$HOME/.docker/cli-plugins/docker-compose"
    have docker-buildx && ln -sfn "$(command -v docker-buildx)" "$HOME/.docker/cli-plugins/docker-buildx"
  fi
  docker compose version >/dev/null 2>&1 && say_ok "docker compose available" || problem "docker compose is missing" "macOS: brew install docker-compose docker-buildx. Linux: install the docker-compose-plugin package."
fi

step "5/7 Sandbox images, proxy and project sharing"
if docker_up; then
  agent_image=$(setting agentImage prompt-arena-agent:local)
  preview_image=$(setting previewImage prompt-arena-preview:local)
  if image_present "$agent_image"; then say_ok "agent image $agent_image"
  elif ask "Build the agent sandbox image (several minutes)?" y; then
    INSTALL_CURSOR=${INSTALL_CURSOR:-$(ask "  Include Cursor CLI in it?" n && echo 1 || echo 0)} \
    INSTALL_CLAUDE=${INSTALL_CLAUDE:-$(ask "  Include Claude Code CLI in it?" y && echo 1 || echo 0)} \
      npm run sandbox:build && say_ok "agent image built" || problem "Agent image build failed" "Check network and free disk space (docker system df), then rerun ./setup.sh."
  else problem "Agent image missing" "Run: npm run sandbox:build"; fi
  if image_present "$preview_image"; then say_ok "preview image $preview_image"
  elif ask "Build the preview image (several minutes)?" y; then
    npm run sandbox:build:preview && say_ok "preview image built" || problem "Preview image build failed" "Check network and free disk space, then rerun ./setup.sh."
  else problem "Preview image missing" "Run: npm run sandbox:build:preview"; fi
  if image_present "$preview_image"; then
    if project_visible "$root" "$preview_image"; then
      say_ok "Docker can see this project folder"
    elif docker_is_colima && ask "Colima cannot see this folder. Restart Colima sharing your home folder$(repo_outside_home "$root" && echo ' and this clone')?" y; then
      colima_reshare "$root" && project_visible "$root" "$preview_image" && say_ok "project folder now shared" \
        || problem "Docker still cannot see this folder" "Clone the project inside your home folder, or run: colima stop && colima start --mount \"$root:w\""
    else
      problem "Docker cannot see this project folder" "Colima: colima stop && colima start --mount \"\$HOME:w\". Docker Desktop: Settings → Resources → File sharing → add $(tidy_path "$root")."
    fi
  fi
  if docker compose -f sandbox/compose.yml up -d >/dev/null 2>&1; then say_ok "egress proxy running"
  else problem "Could not start the egress proxy" "Run: docker compose -f sandbox/compose.yml up -d and read its error."; fi
  if docker network inspect stram_previews >/dev/null 2>&1 || docker network create --internal stram_previews >/dev/null 2>&1; then
    say_ok "internal preview network"
  else problem "Could not create the stram_previews network" "Run: docker network create --internal stram_previews"; fi
else
  say_warn "skipped: Docker is not running (fix step 4, then rerun ./setup.sh)"
fi

step "6/7 Coding CLI logins (sandbox)"
login_present() {
  case "$1" in
    codex) [ -e runtime/auth/codex/.codex/auth.json ] ;;
    cursor) [ -d runtime/auth/cursor ] ;;
    claude) [ -e runtime/auth/claude/oauth-token ] ;;
  esac
}
# When this machine already has a login, sandbox:login offers to reuse it
# (Codex: copy ~/.codex/auth.json; Claude: run claude setup-token here) or
# make a new one. Only presence is checked; no credential is read here.
login_offer() {
  case "$1" in
    codex) [ -e "$HOME/.codex/auth.json" ] && { printf 'Set up codex for the sandbox now (you can copy your existing ~/.codex login or sign in fresh)?'; return; } ;;
    claude) have claude && { printf 'Set up claude for the sandbox now (you can reuse your existing Claude sign-in or paste a token)?'; return; } ;;
  esac
  return 1
}
# Docker is only needed to sign in inside the sandbox, not to copy or paste.
login_needs_docker() { [ "$1" = cursor ] || { [ "$1" = codex ] && ! [ -e "$HOME/.codex/auth.json" ]; }; }
any_login=0
for cli in codex claude cursor; do
  if login_present "$cli"; then say_ok "$cli login saved"; any_login=1
  elif { ! login_needs_docker "$cli" || docker_up; } && interactive \
    && if offer=$(login_offer "$cli"); then ask "$offer" y; else ask "Log in to $cli for the sandbox now (opens its sign-in)?" n; fi; then
    npm run "sandbox:login:$cli" && { say_ok "$cli login saved"; any_login=1; } || say_warn "$cli login did not finish; rerun: npm run sandbox:login:$cli"
  else
    printf '     %s: not logged in (optional) — npm run sandbox:login:%s\n' "$cli" "$cli"
  fi
done
[ "$any_login" = 1 ] || problem "No coding CLI is logged in" "Log in to at least one: npm run sandbox:login:codex (or :claude / :cursor)."

step "7/7 Terminal commands"
if ask "Add start_arena, start_sessions, start_stream and twitching_doctor to $(tidy_path "${TWITCHING_RC:-$(shell_rc)}")?" y; then
  ./install_start_stream.sh || problem "Could not install terminal commands" "Run ./install_start_stream.sh and read its error."
else
  say_warn "skipped; use ./start_arena.sh and ./start_sessions.sh from this folder"
fi

printf '\n'
if [ "$problems" -eq 0 ]; then
  printf '%s\n' "${c_ok}Setup complete.${c_end}" "Open a new terminal (or: source $(tidy_path "${TWITCHING_RC:-$(shell_rc)}")), then:" \
    "  start_arena       prompt arena controls" "  start_sessions    session mode controls" \
    "OBS is optional: add http://127.0.0.1:$(setting port 3210)/overlay as a 1920×1080 Browser Source whenever you are ready."
else
  printf '%s\n' "${c_warn}Setup finished with $problems problem(s) above.${c_end} Fix them and rerun ./setup.sh." \
    "Stuck? Run ./doctor.sh and paste its report into $TWITCHING_ISSUES_URL"
  exit 1
fi
