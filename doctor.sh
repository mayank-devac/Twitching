#!/usr/bin/env bash
# Read-only diagnostics. Changes nothing (apart from a temporary probe folder
# under runtime/), never reads credentials, and prints paths relative to ~ so
# the report is safe to paste into a GitHub issue.
#
#   ./doctor.sh              print the report
#   ./doctor.sh --save FILE  also write it to FILE
set -uo pipefail
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
root=$PWD
. scripts/shell-lib.sh

save=""
case "${1:-}" in
  --save) save=${2:?--save needs a file name} ;;
  --help|-h) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

fails=0 warns=0
ok() { say_ok "$*"; }
warn() { say_warn "$1"; [ -n "${2:-}" ] && say_fix "$2"; warns=$((warns + 1)); }
fail() { say_fail "$1" 2>&1; [ -n "${2:-}" ] && say_fix "$2"; fails=$((fails + 1)); }
section() { printf '\n## %s\n' "$*"; }

report() {
  printf '# Twitching doctor report\n'
  printf 'clone: %s\n' "$(tidy_path "$root")"
  printf 'system: %s %s %s, shell %s\n' "$(uname -s)" "$(uname -r)" "$(uname -m)" "$(basename -- "${SHELL:-unknown}")"
  if have git && git rev-parse --git-dir >/dev/null 2>&1; then
    printf 'commit: %s%s\n' "$(git rev-parse --short HEAD 2>/dev/null)" "$( [ -n "$(git status --porcelain 2>/dev/null)" ] && echo ' (local changes)')"
  fi

  section "Node.js"
  if node_ok; then ok "node $(node -v), npm $(npm -v 2>/dev/null)"
  else fail "Node.js 24+ missing (found: $(node -v 2>/dev/null || echo none))" "Install Node.js 24+ from https://nodejs.org, then ./setup.sh"; fi
  if [ -x node_modules/.bin/tsx ]; then
    if npm ls --depth=0 >/dev/null 2>&1; then ok "dependencies installed and match package.json"
    else warn "installed dependencies do not match package.json" "npm ci"; fi
  else fail "dependencies missing" "npm ci"; fi
  if [ -f dist/index.html ]; then ok "UI built"; else warn "UI not built yet (the launcher builds it on start)"; fi

  section "Config"
  if have node && node -e 'JSON.parse(require("fs").readFileSync("settings.json","utf8"))' 2>/dev/null; then ok "settings.json is valid JSON"
  else fail "settings.json is missing or not valid JSON" "git checkout settings.json, or fix the JSON error"; fi
  host=$(setting host 127.0.0.1)
  case "$host" in 127.0.0.1|::1|localhost) ok "control server host $host" ;; *) fail "settings.json host is $host" "Set \"host\": \"127.0.0.1\"; the control panel must stay local." ;; esac
  if [ -e .env.local ]; then ok ".env.local exists (contents not read)"; else warn ".env.local missing (only needed for chat platforms, Jev and OBS password)" "cp .env.example .env.local"; fi
  if [ -e "$(setting musicPath assets/break.mp3)" ]; then ok "break music present"; else warn "no break music; breaks will be silent"; fi

  section "Terminal commands"
  rc=$(shell_rc)
  if [ -f "$rc" ] && grep -Fq "# >>> twitching start_stream >>>" "$rc"; then
    if grep -Fq "\"$root/\$script\"" "$rc"; then ok "start_arena/start_sessions installed in $(tidy_path "$rc") and point at this clone"
    else warn "commands in $(tidy_path "$rc") point at a different clone" "./install_start_stream.sh && source $(tidy_path "$rc")"; fi
  else warn "start_arena/start_sessions not installed for $(basename -- "${SHELL:-sh}")" "./install_start_stream.sh, or run ./start_arena.sh from this folder"; fi
  for f in start_stream.sh start_arena.sh start_sessions.sh check_stream_start.sh with_colima.sh; do
    [ -x "$f" ] || fail "$f is missing or not executable" "git checkout $f && chmod +x $f"
  done

  section "Docker"
  if ! have docker; then
    fail "docker CLI not installed" "macOS: brew install colima docker docker-compose docker-buildx (or Docker Desktop). Linux: install Docker Engine."
  elif ! docker_up; then
    if have colima && ! colima_running; then fail "Docker engine not running (Colima is stopped)" "colima start"
    elif docker info 2>&1 | grep -qi "permission denied"; then fail "no permission to use Docker" "sudo usermod -aG docker \$USER, then log out and back in"
    else fail "Docker engine not reachable (context: $(docker context show 2>/dev/null || echo ?))" "Start Docker Desktop or run colima start"; fi
  else
    engine="Docker ($(docker context show 2>/dev/null || echo default))"
    docker_is_colima && engine="Colima"
    ok "$engine, server $(docker info --format '{{.ServerVersion}}' 2>/dev/null), $(docker info --format '{{.NCPU}} CPUs, {{.MemTotal}}' 2>/dev/null | awk '{printf "%s %s %.1f GB", $1, $2, $3/1073741824}')"
    mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
    [ "${mem:-0}" -ge 5000000000 ] 2>/dev/null || warn "Docker VM has under 5 GB RAM; two agents plus previews may be killed" "Colima: colima stop && colima start --memory $COLIMA_MEMORY_GB --cpu $COLIMA_CPUS. Docker Desktop: Settings → Resources."
    docker compose version >/dev/null 2>&1 && ok "docker compose available" || fail "docker compose missing" "brew install docker-compose (then ./setup.sh registers it) or install docker-compose-plugin"
    agent_image=$(setting agentImage prompt-arena-agent:local)
    preview_image=$(setting previewImage prompt-arena-preview:local)
    image_present "$agent_image" && ok "agent image $agent_image" || fail "agent image $agent_image missing" "npm run sandbox:build"
    if image_present "$preview_image"; then
      ok "preview image $preview_image"
      if project_visible "$root" "$preview_image"; then ok "containers can see this project folder"
      elif docker_is_colima; then fail "Colima cannot see this project folder (bind source path does not exist)" "colima stop && colima start --mount \"\$HOME:w\"$(repo_outside_home "$root" && printf ' --mount "%s:w"' "$(tidy_path "$root")")"
      else fail "Docker cannot see this project folder" "Docker Desktop: Settings → Resources → File sharing → add $(tidy_path "$root")"; fi
    else fail "preview image $preview_image missing" "npm run sandbox:build:preview"; fi
    if [ -n "$(docker compose -f sandbox/compose.yml ps --status running -q 2>/dev/null)" ]; then ok "egress proxy running"
    else warn "egress proxy not running (the launcher can start it)" "docker compose -f sandbox/compose.yml up -d"; fi
    for net in stram_agents stram_previews; do
      internal=$(docker network inspect "$net" --format '{{.Internal}}' 2>/dev/null)
      case "$internal" in true) ok "network $net (internal)" ;; "") warn "network $net missing (created on start)" ;; *) fail "network $net is not internal" "Stop its containers, docker network rm $net, rerun ./setup.sh" ;; esac
    done
  fi

  section "Coding CLI logins (presence only)"
  [ -e runtime/auth/codex/.codex/auth.json ] && ok "codex: sandbox login saved" || { [ -e "$HOME/.codex/auth.json" ] && warn "codex: not set up for the sandbox (your ~/.codex login can be copied)" "npm run sandbox:login:codex" || warn "codex: not logged in" "npm run sandbox:login:codex"; }
  [ -e runtime/auth/codex-2/.codex/auth.json ] && ok "codex: second account (session-2) saved"
  [ -e runtime/auth/claude/oauth-token ] && ok "claude: token saved" || warn "claude: not logged in" "npm run sandbox:login:claude"
  [ -d runtime/auth/cursor ] && ok "cursor: login saved" || warn "cursor: not logged in" "npm run sandbox:login:cursor"

  section "Ports"
  port=$(setting port 3210)
  for p in "$port" "$(setting previewPort 3211)" "$(setting webhookPort 3212)" "$(setting browserPort 3213)"; do
    if have lsof && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      if [ "$p" = "$port" ] && have curl && curl -fsS -m 2 "http://127.0.0.1:$p/api/boot" >/dev/null 2>&1; then ok "port $p: Twitching app is running"
      elif [ "$p" = "$port" ]; then fail "port $p is used by another program" "Close it, or change \"port\" in settings.json"
      else ok "port $p in use (normal while the app runs)"; fi
    else ok "port $p free"; fi
  done

  section "OBS (optional)"
  obs_port=$(setting obsUrl ws://127.0.0.1:4455 | sed -E 's#.*:([0-9]+).*#\1#')
  if have lsof && lsof -nP -iTCP:"$obs_port" -sTCP:LISTEN >/dev/null 2>&1; then ok "OBS WebSocket listening on $obs_port"
  else warn "OBS WebSocket not listening on $obs_port (fine until you stream)" "OBS → Tools → WebSocket Server Settings → Enable; put OBS_PASSWORD in .env.local"; fi

  printf '\n## Summary\n'
  if [ "$fails" -eq 0 ]; then printf '%s\n' "${c_ok}No blocking problems${c_end} ($warns warning(s))."
  else printf '%s\n' "${c_fail}$fails blocking problem(s)${c_end}, $warns warning(s). Apply the fixes above, or run ./setup.sh."; fi
  printf 'Still stuck? Open an issue at %s and paste this whole report.\n' "$TWITCHING_ISSUES_URL"
  [ "$fails" -eq 0 ]
}

if [ -n "$save" ]; then
  report 2>&1 | tee "$save"
  status=${PIPESTATUS[0]}
  printf 'Saved to %s\n' "$save"
else
  report 2>&1
  status=$?
fi
exit "$status"
