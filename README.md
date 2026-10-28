# Twitching

A local Codex vs Cursor show: audience suggestions go through a blocked-word list and TypeSafe Jev; both agents get the same task in fresh chats. Cursor is on the left and Codex on the right. The app starts paused in **private rehearsal** mode.

## Start locally

Copy `.env.example` to `.env.local` and fill in your own credentials privately. Add your own `assets/break.mp3` for break music; audio is not distributed with this repository. The blocked-word filter starts empty; configure it before accepting public chat. Jev safety checks remain enabled.

For guided checks and startup:

```sh
./check_stream_start.sh
./start_stream.sh
```

For a single-model show, choose either supported CLI:

```sh
./start_stream.sh --codex
./start_stream.sh --cursor
# Equivalent selection:
./start_stream.sh --cli cursor
./check_stream_start.sh --cli codex --mode rehearsal
```

Single-model mode checks and launches only the selected CLI, with one full-width preview and activity panel. Chat selection, prompt lists, OBS, pause/stop, and rehearsal still use the same show flow. Codex keeps its quota monitoring; Cursor reports usage failures through its CLI and does not require a Codex login. Without a selection flag, both CLIs run as before. Rebuild the frontend with `npm run build` before launching after a UI code change.

`check_stream_start.sh` defaults to **live readiness**. It never starts a broadcast or coding job. It checks Docker, images/networks, saved CLI logins, the exact requested models, Codex quota, Jev, required private field names, media files, the OBS overlay source and a temporary isolated HTML preview. Failures print specific fixes; interactive mode offers builds, network setup or CLI login. Live readiness also requires your recorded rehearsal confirmation with the same Docker/native runner mode. Actual platform permissions/connections and signed Kick delivery need the platforms to be live; the check file marks those as pending instead of pretending they passed.

`start_stream.sh` asks for private/live mode and Docker/native agents, checks readiness, starts or safely reuses a paused app, and offers a private task round or public OBS broadcast. Going public requires scene/audio/webhook confirmation and a final yes. A public broadcast started by this file is stopped if controller startup fails. A pre-existing broadcast is not stopped merely because prerequisite checks failed. Keep the terminal open: Ctrl+C ends the activated show and broadcast.

```sh
./check_stream_start.sh --mode rehearsal
./check_stream_start.sh --mode live --verify
./check_stream_start.sh --mode live --non-interactive
./start_stream.sh --mode rehearsal --runner docker
./start_stream.sh --mode live --runner native
```

When `prompts.txt` (or `settings.promptFile`) already has tasks, the show uses that list instead of live chat: both CLIs get each line in order, then the control desk asks whether to collect from chat or end the stream. **Stop** opens **Chat** and **End**; each then offers After this round / Now. Chat also asks which platforms. `--prompts` forces this mode; `--no-prompts` keeps audience chat even if the file still has lines.

```sh
./start_stream.sh --mode rehearsal --runner docker
./start_stream.sh --mode live --runner docker
./start_stream.sh --mode live --no-prompts --skip yt --skip twitch
```

`--verify` explicitly runs type checks, tests, fixture replay and the frontend build; Docker-agent mode also runs the real agent boundary test. Without it, tests are skipped unless you accept the check file's prompt. Missing dependencies can be installed after answering its shell prompt. Credentials are not requested or printed in the terminal; edit `.env.local` privately. `--help` lists the options.

**Native agents are optional and unprotected.** `runnerMode` defaults to `docker`. With `--runner native`, host-installed Codex uses the private arena login and Cursor uses its native subscription login; previews still require Docker. Type `NATIVE` before starting to accept that agent terminal commands can read/change files outside the project. That consent applies only to the launched app process, through `ARENA_NATIVE_APPROVED`, and is not saved in settings. A direct native app start without confirmation cannot launch coding jobs. Cursor must expose its `--sandbox` option; requested models remain mandatory. Native runners use process groups and ownership records for cancellation/restart recovery. Process groups are not a sandbox: escaped/background work may require manual cleanup. There is no automatic switch to native if Docker fails.

Mode choices use `ARENA_MODE`/`ARENA_RUNNER` for that process without rewriting `settings.json`. An existing app with different/stale settings or active work is refused with pause/stop/restart instructions. OBS checks establish that the Browser Source is configured, not that it is visible in the current scene or that audio is audible; confirm those during rehearsal and the final prompt.

Node.js 24+ and Docker Desktop are required. Install dependencies with `npm ci`. Agent logins and private settings must be configured locally; this repository does not include them. The remaining Docker setup can take a few minutes; run these commands after opening Docker Desktop:

```sh
npm run sandbox:build
npm run sandbox:build:preview
docker compose -f sandbox/compose.yml up -d
docker network create --internal stram_previews
npm run sandbox:login:codex
npm run sandbox:login:cursor
npm run build
npm run dev
```

Login commands use your existing subscriptions and save authentication under ignored `runtime/auth/`. Sign in yourself; never paste CLI credentials into prompts. Host terminal chats are left alone. Each round starts separate new sessions without a resume flag. The Cursor installer is the official installer; its current version is checked at startup. The Codex image pins CLI `0.159.2`; change its build argument if your account needs a newer version:

```sh
docker build --build-arg CODEX_VERSION=YOUR_INSTALLED_VERSION -t prompt-arena-agent:local sandbox
```

Open [the host control panel](http://127.0.0.1:3210/control). Add [the overlay](http://127.0.0.1:3210/overlay) as an OBS Browser Source, 1920 × 1080. Use the exact `127.0.0.1` URLs; other Host headers are rejected. Browser refresh reconnects to existing state and recent events.

## Private credentials

Paste credentials into **`.env.local`**, already created with blank fields and ignored by Git. The controller reads it only at runtime and sets permissions to `0600`. It is never served to the browser or mounted into coding containers. Agent instructions forbid opening it. File permissions cannot technically exclude an assistant running as your same OS user; this project instead keeps it out of all app-facing and container-facing surfaces, and the assistant must not read it after you fill it.

`settings.json` holds public configuration: timings, model IDs, blocked slang, the Jev startup probe, media paths and the Kick webhook URL. Restart after changing settings. The configured Cursor ID is an **unverified requested ID**, not a claim that Grok 4.7 high exists for your account. Startup requires that exact ID in `cursor-agent --list-models` and a label identifying Grok 4.7 high. Missing model/effort support pauses the show; no replacement model is used.

## Connect the platforms

- **YouTube:** enable the YouTube Data API. Provide an OAuth access token with `youtube.readonly`, the live chat ID, and optionally refresh token/client credentials. The adapter uses the official server-streaming gRPC interface and continuation tokens. The protobuf file contains only the wire fields this app consumes, with Google's field numbers. Sponsor metadata and recent official gift events establish the bonus; user claims do not.
- **Twitch:** provide a user access token with `user:read:chat`, its client ID, the bot user ID and broadcaster ID. Add refresh credentials for token expiry. The app creates an EventSub `channel.chat.message` subscription, handles keepalives/reconnects, and recreates subscriptions after a dropped connection. Twitch does not replay messages missed during a disconnected interval.
- **Kick:** create a developer app, enable its webhook, and register an HTTPS endpoint forwarding **only port 3212** to `/kick`. Put that same URL in `kickWebhookUrl`, and provide a token with `events:subscribe` plus the broadcaster user ID. The API uses the webhook registered in your Kick app settings; a URL in this local settings file does not register the remote webhook. The dedicated listener verifies the RSA signature over exact bytes, timestamp, event version and broadcaster; duplicate events are ignored. Do not expose ports 3210, 3211 or 3213 through the tunnel. A signed subscriber badge or gift event establishes eligibility for a bonus.

Live mode can omit YouTube, Twitch and Kick with `--skip yt`, `--skip twitch` and `--skip kick`. Empty Twitch fields also skip Twitch. If YouTube is enabled and `YOUTUBE_LIVE_CHAT_ID` is empty, startup looks up the chat ID from your YouTube access token for an active or upcoming livestream. Platform errors appear in the host desk and pause new rounds. Tokens refreshed during the show remain in memory; after restarting, update credentials if a provider rotated its refresh token. CLI subscription refreshes are retained in private auth directories.

## Rehearse before going public

1. Keep `mode: "rehearsal"`. Enable OBS WebSocket v5 under Tools → WebSocket Server Settings. Put its password in `.env.local`.
2. Press **Start** to check CLI logins, requested models, quota, isolated preview engine, music and visual. If Jev is configured, submit a private test suggestion; otherwise press **Prepare house task**. Both real CLIs run the same task. No fake thinking or fake agent output is shown.
3. Record privately in OBS. Check activity, shared timers, the faster result while the other runs, both finished previews, refresh/reconnect, Pause, Resume, Skip and Stop. Check audio from the browser source; browser autoplay can require OBS configuration or the host's Play music button.
4. After both pages succeed and you have checked OBS, press **I checked the private OBS rehearsal**. This records the host's confirmation; automated tests cannot confirm an actual broadcast rehearsal.
5. Use `start_stream.sh` and choose live mode, or set `mode: "live"`, restart, start OBS streaming manually, then press **Start**. The script can start OBS after confirmation; the controller itself does not start broadcasts. It checks platform startup before collecting; verify signed Kick delivery with a real message.

**Stop show + OBS** stops runners, confirms container shutdown and sends OBS `StopStream`. If you stop streaming in OBS, the app also stops. If stopping OBS fails, the app reports that it could not confirm shutdown; check OBS yourself.

## Round behaviour

- Strip `!prompt`, require at least five words, reject duplicates, blocked abuse, unreadable text and emoji-only content. At least 80% of words must be recognized English, common technical terms or numbers; a small number of unknown names or typos is tolerated. Hinglish/romanized speech has no special support. Repeating one word for 60% or more of a suggestion is rejected as spam. Split blocked words such as `fuc k` and `chu tiya` are checked together. `settings.json` ships with an empty `blockedWords` list; add your own words there; those rules still apply before Jev's separate safety and HTML relevance gates.
- New valid submissions replace that viewer's earlier suggestion, including pending evaluations. One frozen next task is maintained. Once prepared, further submissions wait for the next collection window.
- Rank the strongest 30 with simplicity 40%, clarity 25%, creativity 20%, visual appeal 15%. Verified YouTube/Kick membership or gifts add at most ten points. A weak or unsafe paid idea stays rejected.
- After 60 seconds, ask Jev to select an existing candidate or WAIT. WAIT/API failure allows one 180-second extension, with continued collection. After that, the app asks Jev for one small surprise HTML task; if Jev cannot return one, it keeps waiting for audience activity.
- Both agent runners are prepared before their start commands are issued together. Provider startup latency may differ; both elapsed timers use the controller's launch timestamp. Work continues until completion, a usage/authentication failure, or a host Skip/Stop action.
- Save only `main/codex/prompt_N.html` and `main/cursor/prompt_N.html`. Completion requires successful CLI termination, stopped containers, a regular HTML file, visible content and no JavaScript loading error. Timeouts/cancellations remain labelled unfinished even if a partial file exists.
- Results stay for 30 seconds after both attempts settle. Pause prevents new rounds and lets current work finish. A private rehearsal runs one round, then pauses, unless a prompt list is active. A prompt list keeps launching the next file task after the result hold and ends the show after the last one. Restart always pauses, recovers labelled containers and never relaunches a persisted job.
- Codex quota comes from official app-server `account/rateLimits/read`, using the reported 300-minute window. Missing usage data pauses instead of guessing. At zero, the overlay plays the configured MP3 and pixel-eye visual for up to ten minutes. Verified recovery resumes the show unless the host paused it. Otherwise, the controller ends the show and stops OBS. A reported future reset is shown as data; it is not treated as proof that quota recovered.

## Isolation and privacy

Arena Codex sessions use fresh `HOME` and `CODEX_HOME` folders with only the project's private Codex login copied in. Personal config, skills, plugins, hooks and rules are not copied. Apps/plugins/hooks and automatic `AGENTS.md` loading are disabled; built-in coding tools remain available. The launcher requires the CLI's config/rule isolation flags and pauses if its effective configuration exposes extra integrations. This also applies to native Codex: sign in once with `npm run sandbox:login:codex` for the arena instead of relying on your personal CLI profile. Normal Codex sessions and connected services are unchanged. Native mode still has host filesystem access; Docker is the execution boundary.

The preview controller uses a localhost relay over Docker exec streams instead of publishing a container port. This supports Docker versions that do not publish ports for internal networks, while Chromium keeps only its isolated network.

By default, each agent gets a non-root Docker container with read-only root filesystem, one workspace mount, no Docker socket, removed capabilities and resource limits. Credentials copied into that agent's private workspace support its saved subscription. Only that workspace is persistently writable. CLI internal bypass flags apply **inside this Docker boundary**; they do not give the agent host access. An internal network and HTTPS allowlist proxy permit provider traffic, not arbitrary Internet or host-control access. If a CLI version ignores proxy configuration, startup fails; native execution is a separate explicit host choice, never an automatic fallback.

Generated pages run in a separate Chromium container on an internal network with **no egress proxy and external DNS disabled**. Its Playwright connection never exposes the host network. Initial documents are fulfilled from memory without rewriting generated HTML; all other browser requests are aborted, and CSP adds another layer. Pages containing known credential values or recognizable credential tokens are refused before rendering, without changing the saved file. Variable names such as `secret` and `password` do not trigger rewriting or rejection by themselves. Generated JavaScript does not run in OBS or the host browser: a trusted sandboxed iframe receives JPEG frames and forwards bounded click, hover, key and wheel input to the isolated page. Frames refresh at roughly five per second; this favours isolation over full-rate animation and does not forward generated-page audio. The saved HTML remains the actual agent output.

CLI adapters publish assistant messages/public summaries, command/tool names, file basenames and output counts. Partial messages are assembled before redaction and published at message/tool boundaries, so split credentials cannot reappear when fragments are joined. Tool argument bodies, file-read results, full command output and raw stderr remain private. Known credentials, token-shaped strings and private home paths are redacted. SQLite contains eligible candidates, evaluation cache, decisions, rounds and sanitized event history. Refresh receives a snapshot with the recent 160 events.

## Verify

```sh
npm run check
npm test
npm run build
npm run replay
# After Docker images/networks exist; no subscriptions or platform secrets needed:
STRAM_SANDBOX_TEST=1 npx tsx --test tests/sandbox.test.ts
```

The replay fixtures are representative documentation-shaped samples, **not recordings from your live accounts**. Unit/controller/browser checks cover filtering, metadata bonuses, cache/replacement, partial JSON, duplicate events, WAIT/extension/continued collection, paired timestamps, host cancellation, faster previews, usage interruption, restart, WebSocket reconnect, protected controls, rendering/input and unsafe/missing outputs. The Docker test is skipped by default until the daemon and images exist. Run the real private OBS rehearsal and collect real event recordings before public automation.

Code lives in `server/` (controller, adapters, database, runners, preview isolation), `shared/` (shared event/state types), `web/` (React overlay and host desk), `sandbox/` (containers/network policy), and `tests/` (focused acceptance checks). The original project brief is in `initial_plan.md`; generated HTML examples are included in `main/`. Provider images live in `assets/chatgpt/`, `assets/codex/`, `assets/grok/`, and `assets/cursor/`.

Official references: [TypeSafe Jev](https://docs.typesafe.ai/introduction), [Jev coding-agent boundary](https://docs.typesafe.ai/introduction/coding-agents), [Codex exec JSON](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex models/quota protocol](https://learn.chatgpt.com/docs/app-server), [Cursor CLI output](https://cursor.com/docs/cli/reference/output-format), [YouTube streaming](https://developers.google.com/youtube/v3/live/streaming-live-chat), [Twitch EventSub](https://dev.twitch.tv/docs/chat/send-receive-messages/), [Kick events](https://github.com/KickEngineering/KickDevDocs/blob/main/events/event-types.md), [Playwright Docker](https://playwright.dev/docs/docker).
