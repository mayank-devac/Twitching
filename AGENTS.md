# Twitching project rules

- Never open `.env.local`, `runtime/auth/`, workspace `.home/`, or CLI credential files. Ask Mayank for sanitized diagnostics when needed.
- Keep credentials server-only. Serve only `dist/`; never use the repository as a static root.
- Docker is the default agent boundary. Native agents require explicit opt-in through `start_stream.sh`.
- Tests/builds/type checks require permission unless explicitly included in the current request.
