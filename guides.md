# Prompt Arena practical guide

This file collects the simple answers for checking, rehearsing and running Prompt Arena. Start with rehearsal mode. It uses real Codex and Cursor sessions but does not start a public broadcast.

## Which command should I use?

| Goal | Command |
|---|---|
| Check everything without starting agents | `./check_stream_start.sh --mode rehearsal --runner docker --verify` |
| Run one safe private round | `./start_stream.sh --mode rehearsal --runner docker` |
| Run agents directly on the Mac | `./start_stream.sh --mode rehearsal --runner native` |
| Simulate recorded audience and CLI events | `npm run replay` |
| Check public-stream readiness without going live | `./check_stream_start.sh --mode live --runner docker --verify` |

`check_stream_start.sh` does not start a coding round or OBS broadcast. `start_stream.sh` asks before starting anything important.

## First-time Docker setup

Open Docker Desktop and wait until its engine is running. Then run:

```sh
npm run sandbox:build
npm run sandbox:build:preview
docker compose -f sandbox/compose.yml up -d
docker network inspect stram_previews >/dev/null 2>&1 || docker network create --internal stram_previews
npm run sandbox:login:codex
npm run sandbox:login:cursor
```

The login commands use your subscriptions. Enter credentials yourself. Never paste credentials into chat, prompts or command arguments.

## Test everything without streaming

### 1. Prepare OBS

Open OBS, but do not press **Start Streaming**.

1. Enable **Tools → WebSocket Server Settings**.
2. Put the OBS WebSocket password in `.env.local`.
3. Add a Browser Source with URL `http://127.0.0.1:3210/overlay`.
4. Set the Browser Source size to 1920 × 1080.
5. You may press **Start Recording** for a local video. Recording is not streaming.

### 2. Run the readiness check

```sh
./check_stream_start.sh --mode rehearsal --runner docker --verify
```

It checks Docker, images, internal networks, CLI logins, exact models, Codex quota, Jev when configured, media files, OBS, the overlay source, preview isolation, tests, fixture replay and the frontend build.

If something fails, it prints `Fix:` followed by the action to take. A successful run ends with:

```text
READY: rehearsal prerequisites passed
```

### 3. Run one complete private round

```sh
./start_stream.sh --mode rehearsal --runner docker
```

Answer yes when it asks to start a private round. Enter a test task such as:

```text
Build a colourful interactive aquarium with animated fish and feeding controls
```

Open:

- Control panel: `http://127.0.0.1:3210/control`
- OBS overlay: `http://127.0.0.1:3210/overlay`

Check that both agents start together, show real activity, produce separate HTML pages and load their results. The faster result should remain visible while the other agent continues.

### 4. Check controls

Use separate rehearsal rounds to check:

- **Pause:** current work finishes, while future automatic rounds stay paused.
- **Resume:** collection continues.
- **Skip:** unfinished agents stop and show a cancelled state.
- **Stop:** active agents and the controller stop.
- Refreshing `/overlay`: the current round and recent activity remain visible.
- Restarting the app: it starts paused and does not repeat an interrupted job.
- Clicking finished results: interaction reaches the isolated page.

After checking your local OBS recording, press **I checked the private OBS rehearsal** in `/control`. Rehearsal confirmation is stored separately for Docker and native-agent modes.

## Simulate audience chat without YouTube, Twitch or Kick

Run:

```sh
npm run replay
```

This replays sample chat and CLI events. The automated tests also cover short prompts, missing `!prompt`, emoji-only content, blocked words, duplicates, viewer replacement, membership bonuses, partial CLI messages and duplicate events.

For the complete automated suite:

```sh
npm run check
npm test
npm run build
npm run replay
```

When Docker images and networks are ready, test the real Docker boundary:

```sh
STRAM_SANDBOX_TEST=1 npx tsx --test tests/sandbox.test.ts
```

## Get the Kick access token and broadcaster ID

Prompt Arena can use a Kick **App Access Token**. This is the simpler server-to-server token; Kick allows it for channel lookup and event subscriptions. With an app token, `KICK_BROADCASTER_ID` is required.

### 1. Create a Kick developer app

1. Enable 2FA in your Kick account settings.
2. Open <https://kick.com/settings/developer>.
3. Select **Create App**.
4. For **Redirect URL**, enter:

   ```text
   http://localhost:3212/oauth/callback
   ```

   Prompt Arena currently uses an App Access Token, so this callback is not used during normal startup. It satisfies the app's redirect setting and gives you a local address if a user OAuth flow is added later. Redirect URL and webhook URL are different fields.

5. Under **Scopes Requested**, select:

   ```text
   channel:read
   events:subscribe
   ```

6. If you do not yet have a public HTTPS tunnel, leave **Enable webhooks** off while creating the app. You can still generate the App Access Token and find the broadcaster ID.
7. Before using Kick chat in a real show, create a public HTTPS URL that forwards only to local port `3212`. Turn **Enable webhooks** on and enter the public URL ending in `/kick`, for example:

   ```text
   https://your-public-tunnel-host.example/kick
   ```

   Put that exact URL in `settings.json` as `kickWebhookUrl`. Do not enter `localhost` in the webhook field because Kick's servers cannot reach your Mac through localhost. Do not expose ports `3210`, `3211`, or `3213`.
8. Save the app, then copy the **Client ID** and **Client Secret**. The Client Secret is private; never paste it into chat or commit it to Git.

### 2. Generate an App Access Token

Run these commands in Mac Terminal. Pasted values are kept in temporary shell variables; the Client Secret is hidden while typing:

```sh
read -r 'kick_client_id?Paste Kick Client ID: '
read -rs 'kick_client_secret?Paste Kick Client Secret (hidden): '; echo

kick_token_response=$(curl -fsS -X POST 'https://id.kick.com/oauth/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$kick_client_id" \
  --data-urlencode "client_secret=$kick_client_secret")

kick_access_token=$(printf '%s' "$kick_token_response" | \
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const j=JSON.parse(s);if(!j.access_token)process.exit(1);process.stdout.write(j.access_token)})')

printf '%s' "$kick_access_token" | pbcopy
echo 'Kick access token copied to clipboard.'
unset kick_client_secret kick_token_response
```

Open `.env.local` in your editor and paste the copied token:

```text
KICK_ACCESS_TOKEN=paste_the_token_here
```

Do not run `echo $kick_access_token`, because that prints the secret to the terminal. Clear the clipboard after saving the token:

```sh
printf '' | pbcopy
```

### 3. Get the broadcaster ID for `kick.com/lofies`

With `kick_access_token` still available in the same terminal, run:

```sh
kick_channel_response=$(curl -fsS \
  -H "Authorization: Bearer $kick_access_token" \
  'https://api.kick.com/public/v1/channels?slug=lofies')

printf '%s' "$kick_channel_response" | \
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const j=JSON.parse(s);const id=j.data?.[0]?.broadcaster_user_id;if(!id){console.error("Broadcaster ID not found");process.exit(1)}console.log(id)})'
```

Copy the printed number into `.env.local`:

```text
KICK_BROADCASTER_ID=the_number_printed_above
```

Clean the remaining temporary values:

```sh
unset kick_client_id kick_access_token kick_channel_response
```

App access tokens expire. If Kick later returns `401 Unauthorized`, repeat the token-generation step and replace `KICK_ACCESS_TOKEN` in `.env.local`.

Kick references: [App setup](https://github.com/KickEngineering/KickDevDocs/blob/main/getting-started/kick-apps-setup.md), [OAuth token flow](https://github.com/KickEngineering/KickDevDocs/blob/main/getting-started/generating-tokens-oauth2-flow.md), and [Channels API](https://api.kick.com/swagger/doc.yaml).

## Run agents without the Docker sandbox

Native-agent mode runs Codex and Cursor directly on your Mac. Preview pages still run in the isolated Docker browser.

Prepare only the preview side:

```sh
npm run sandbox:build:preview
docker network inspect stram_previews >/dev/null 2>&1 || docker network create --internal stram_previews
codex login
cursor-agent login
```

Check native mode without starting agents:

```sh
./check_stream_start.sh --mode rehearsal --runner native --verify
```

Run a private native round:

```sh
./start_stream.sh --mode rehearsal --runner native
```

The script asks you to type exactly:

```text
NATIVE
```

This confirmation is required for each launched app process and is not stored in `settings.json`.

### Native-mode risk

Native agents have the permissions of your Mac user. Their terminal commands may read, change or delete files outside this project. Process groups help Stop/Skip terminate normal child processes, but they are not a security boundary. A deliberately detached process may require manual cleanup.

Use Docker-agent mode for real audience prompts. If you must use native mode, the safer approach is a separate macOS user account without personal files, cloud drives or private accounts.

## What protection does Docker-agent mode provide?

Each agent receives a separate temporary workspace. The container has a read-only base filesystem, no Docker socket, removed Linux capabilities, resource limits and an internal network that reaches only approved provider services through a proxy.

Normally an agent cannot read your Documents/Desktop, control OBS, access the control panel, reach other devices or edit the other agent's workspace.

Remaining risks still exist:

- The container receives a copy of its CLI subscription authentication.
- A bad prompt can waste Codex/Cursor usage allowance.
- Temporary files can consume host disk space; there is no strict workspace disk quota.
- Generated content may be offensive, disturbing or flashing if moderation misses it.
- A page may freeze its preview, which should become a failure card.
- Docker or browser security vulnerabilities are rare but not impossible.

Keep Docker Desktop and both CLIs updated.

## Generated-page safety

Generated HTML is not rewritten. The app renders the exact saved HTML inside the isolated preview browser.

Before rendering, it refuses pages containing a known credential value or a recognizable credential token. Harmless JavaScript such as `const secret = 'blue'` remains unchanged. Generated JavaScript never runs directly inside OBS; OBS receives rendered image frames and forwards limited mouse/keyboard input.

## Prompt filtering behaviour

A suggestion must:

- Start with `!prompt`.
- Contain at least five words after the prefix.
- Be mostly readable English, common technical terms or numbers.
- Avoid blocked abusive words.
- Avoid repeated-word spam.
- Avoid emoji/symbol-only content.

The filter joins disguised split abuse such as `fuc k` and `chu tiya`. Hinglish or romanized-language support is not provided. The configured blocked-word list is applied as written, including words that may also have an innocent meaning.

## Slow Internet while building the preview image

The Playwright preview image is large. Its first download can take a long time. This is a one-time cost; Docker reuses downloaded layers later.

Docker normally downloads three image layers together. On a slow or unstable connection, you can make Docker pull one layer at a time.

### Download one layer at a time

If the current download is still moving, letting it finish is usually fastest. If it keeps timing out, press `Ctrl+C` and do this:

1. Open **Docker Desktop → Settings → Docker Engine**.
2. Add `"max-concurrent-downloads": 1` to the existing JSON. Do not remove its other settings.

If the editor is currently empty except for `{}`, it should look like:

```json
{
  "max-concurrent-downloads": 1
}
```

If it already contains settings, add the new entry with the required comma. Invalid JSON can prevent Docker from restarting.

3. Press **Apply & Restart**.
4. Pull the large base image separately:

```sh
docker pull mcr.microsoft.com/playwright:v1.63.0-noble
```

5. After the pull finishes, build the small project-specific layer:

```sh
npm run sandbox:build:preview
```

The separate pull is useful because completed image layers are stored in Docker's local cache. If the connection fails, rerun the same `docker pull` command; Docker can reuse layers that finished successfully. The later build should reuse the downloaded base image.

Docker's official documentation says pulls use three concurrent layer downloads by default and recommends lowering `max-concurrent-downloads` on low-bandwidth connections: <https://docs.docker.com/reference/cli/docker/image/pull/>. Docker Desktop exposes daemon JSON under **Settings → Docker Engine**: <https://docs.docker.com/desktop/settings-and-maintenance/settings/#docker-engine>.

After the download is complete, you can remove `max-concurrent-downloads` or change it back to `3` for normal Docker use.

Best options:

1. Let the download finish.
2. Switch to a faster Wi-Fi connection or mobile hotspot.
3. Press `Ctrl+C` and rerun the pull/build later. Docker keeps completed layers, although an incomplete layer may download again.
4. Pull/build on another machine with the same CPU architecture, transfer it using `docker save`, then load it using `docker load`.

You cannot run the complete visual rehearsal without the preview image. You can skip it only for non-visual checks:

```sh
npm run check
npm test
npm run replay
npm run build
```

There is currently no native-preview option because generated pages would then execute on the Mac with weaker protection.

## Common errors and fixes

### Docker Desktop is not ready

Open Docker Desktop and wait until it reports that the engine is running. Rerun the check file.

### Preview image is missing

```sh
npm run sandbox:build:preview
```

### Agent image is missing

Required only for Docker agents:

```sh
npm run sandbox:build
```

### Provider proxy is not running

```sh
docker compose -f sandbox/compose.yml up -d
```

### Preview network is missing

```sh
docker network create --internal stram_previews
```

If the network already exists but is not internal, stop containers using it and fix it manually. The scripts will not delete an existing network automatically.

### Codex or Cursor login failed

Docker agents:

```sh
npm run sandbox:login:codex
npm run sandbox:login:cursor
```

Native agents:

```sh
codex login
cursor-agent login
```

### Requested model is unavailable

Check the model list provided by that CLI/account. The app will not silently select a different model. Update `settings.json` only after choosing an available model intentionally.

### OBS overlay source is missing

Add `http://127.0.0.1:3210/overlay` as a 1920 × 1080 OBS Browser Source and enable OBS WebSocket.

### A different or old app is already running

Use its `/control` page to Stop it, close the terminal that launched it, then rerun `start_stream.sh`. The script does not kill an unknown app.

### Live readiness says rehearsal is missing

Run a rehearsal using the same runner mode you plan to use live:

```sh
./start_stream.sh --mode rehearsal --runner docker
```

or:

```sh
./start_stream.sh --mode rehearsal --runner native
```

Finish the round, inspect OBS and confirm the rehearsal in `/control`.

## What cannot be fully simulated without streaming?

Offline/rehearsal tests cannot prove:

- Real YouTube and Twitch token permissions and live chat delivery.
- Kick's public HTTPS webhook and signed delivery from Kick.
- Actual platform reconnect behaviour during a broadcast.
- What viewers receive from the final streaming platform.
- Real audio balance after platform encoding.

Testing those items requires a private/unlisted test broadcast. The app does not claim they passed during offline simulation.

## Stop and clean up

Keep the `start_stream.sh` terminal open. Press `Ctrl+C` to stop the show started by that session. In rehearsal mode it does not start a public broadcast.

To stop the provider proxy after testing:

```sh
docker compose -f sandbox/compose.yml down
```

Generated results are saved under `main/codex/` and `main/cursor/`. Runtime state and temporary native workspaces are under `runtime/`; both locations are ignored by Git.
