# Audience-driven Codex vs Cursor livestream

Build a local app that collects audience prompts from YouTube, Twitch, and Kick, uses TypeSafe Jev(https://docs.typesafe.ai/introduction) to select a suitable task, and starts Codex CLI and Cursor CLI together , if the cli is alredy open then create new chat and run new prompr ( new prompt new chat).

Both agents receive the same prompt and independently create a single HTML page. A custom OBS overlay shows their real activity like thinking , tools use , command run  , elapsed timers, output and finished results side by side, following your sketch.

While a round runs, the app collects and selects the next prompt.

## Implementation

### Chat collection and Jev selection

- Connect through the platforms’ official chat/event interfaces. Convert messages into one internal format containing message ID, platform, author, text, timestamp, and verified membership/gift information.
- Accept messages starting with `!prompt`. Remove that prefix before counting words.
- Reject fewer than five words, duplicates, emoji/GIF-only content, blocked abusive slang, and unreadable messages. Use an English dictionary with an allowlist for technical words and names.
- Accept one active suggestion per viewer per collection window. Later submissions replace that viewer’s earlier suggestion.
- Send eligible comments to Jev for separate judgments: safety, relevance to an HTML task, simplicity, clarity, creativity, and visual appeal. Cache each evaluation.
- Keep the best 30 eligible candidates. New stronger suggestions can replace weaker ones.
- Rank using these initial weights: simplicity 40%, clarity 25%, creativity 20%, visual appeal 15%. Add a capped 10-point bonus for verified YouTube/Kick member or gift submissions. Payment does not bypass filtering.
- Ask Jev to choose a candidate or `WAIT`. Jev selects an existing comment; the app attaches fixed coding instructions because Jev does not generate prompts. [TypeSafe documentation](<https://docs.typesafe.ai/introduction/coding-agents>)
- After an initial 60-second collection window, allow one three-minute extension. Continue evaluating incoming comments during that extension. If no suitable candidate exists afterward, use a prewritten fallback task.

### Round controller and CLI runners

- Use Node.js with TypeScript for the controller, React for the overlay/control panel, and SQLite for rounds, candidates, decisions, and event history.
- Store results under `main/codex/prompt_N.html` and `main/cursor/prompt_N.html`. Each round uses a fresh CLI session and a fixed output filename.
- Send identical task instructions to both agents: build one self-contained HTML page with inline CSS/JavaScript, no backend, package installation, external services, or deployment.
- Configure Codex for GPT‑6.1 Sol with high reasoning. Configure Cursor for the model shown in your sketch, Grok 4.7 high, **only if the installed CLI and account expose it**. Startup checks must report unavailable models rather than silently substitute.
- Use saved subscription authentication. Check both CLIs are authenticated before starting the show; pause automatically if authentication or usage limits fail.
- Read Codex JSON events and Cursor stream JSON events through separate adapters. Convert them into shared activity events for the UI. [Codex documentation](<https://learn.chatgpt.com/docs/non-interactive-mode>), [Cursor documentation](<https://cursor.com/docs/cli/reference/output-format>)
- Run each CLI in a separately restricted environment with only its workspace writable. Separate folders alone are not an execution boundary.
- Start both agents together and start their elapsed timers from the controller’s launch timestamp.
- Allow six minutes per round. Stop remaining work at the deadline and label unfinished attempts clearly. Confirm both processes have stopped before launching another round.
- Keep completed results visible for 30 seconds before starting the next prepared task. Maintain only one prepared next task so the queue stays bounded.

### Stream UI and controls

- Provide `/overlay` for OBS and `/control` for the host.
- Each panel shows agent/model name, elapsed timer, actual assistant messages, file-edit activity, and completion/error state.
- Show public reasoning summaries only when exposed by the CLI. Do not invent thinking text or percentage progress.
- Display HTML results after the agent finishes and the page successfully loads in a restricted preview. Show a clear failure card if the output is missing or broken.
- Serve generated pages from a separate preview origin in sandboxed iframes, with external network requests blocked.
- Add a shared strip for the current prompt, selected viewer/platform, candidate count, and next-round countdown.
- The control panel provides Start, Pause, Resume, Skip round, Stop, and candidate rejection. Pausing prevents new rounds while allowing current work to finish.
- Send overlay updates through WebSocket. On reconnect, send the current state and recent events so refreshing OBS does not restart a round.
- Redact credentials and private paths before publishing activity. Never forward raw stderr or full file-read results directly to the overlay.

## Verification and acceptance

- Exercise filtering with short prompts, dictionary exceptions, emojis, abusive text, duplicates, and missing `!prompt`.
- Verify membership/gift bonuses use platform metadata and never bypass rejection.
- Replay recorded chat and CLI events to check selection, candidate replacement, partial messages, errors, and duplicate-event handling.
- Test Jev `WAIT`, API failure, empty chat, the three-minute extension, and fallback selection.
- Verify both agents receive identical tasks and start together; the faster result remains visible while the other continues.
- Test timeout cancellation, usage-limit interruption, overlay reconnect, and controller restart. Restart must pause the show rather than accidentally duplicate a job.
- Verify generated pages cannot access the control panel or external network.
- Run one private OBS rehearsal before enabling automatic public rounds.

## Assumptions and defaults

- This is a personal stream running on your machine with manually authenticated CLI subscriptions.
- YouTube, Twitch, and Kick are included; extra membership/gift weighting initially applies to YouTube and Kick.
- Tasks are small HTML experiences: games, animations, interactive demos, or page designs.
- Jev chooses prompts automatically. The host retains pause and stop controls.
- Jev thresholds and ranking weights are starting settings to check against sample audience comments; they do not guarantee safety or completion speed.
- The six-minute deadline, 60-second collection window, three-minute extension, and 30-second result display are configurable defaults.
- OBS broadcasts the overlay after the host starts streaming.

### Platform support

- **YouTube:** Its official Live Streaming API can stream new chat messages with low latency. [YouTube Live Chat API](<https://developers.google.com/youtube/v3/live/docs/liveChatMessages>)
- **Twitch:** Use EventSub’s `Channel Chat Message` event. Twitch recommends EventSub for receiving chat. [Twitch chat documentation](<https://dev.twitch.tv/docs/chat/send-receive-messages>)
- **Kick:** Its official developer API provides the `chat.message.sent` webhook event. [Kick developer documentation](<https://github.com/KickEngineering/KickDevDocs/blob/main/events/event-types.md>)

YouTube / Twitch / Kick chats
              ↓
      Collect suggestions
              ↓
 Filter spam and unsafe content
              ↓
LLM combines the best ideas
              ↓
revelevant prompt goes to cli harness
              ↓
Show progress and result
         in the livestream

when does the live ends , either me ends the live or when the 5 hr usage of codex drops to 0 and it will take more than 10 mins to recover (while that 10 min time play a music assets/break.mp3 with visual assets/break-visual.html ).

create file where I can paste secrets whic you don't have acces to . 
