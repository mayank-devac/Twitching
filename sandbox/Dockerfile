# Pinned by tag and digest so a rebuild cannot silently pick up a new base.
# Update: curl -s https://hub.docker.com/v2/repositories/library/node/tags/<tag> (read "digest").
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ARG CODEX_VERSION=0.159.2
# Cursor CLI is opt-in: npm run sandbox:build and start_stream.sh ask first and
# pass INSTALL_CURSOR=1 only on yes.
ARG INSTALL_CURSOR=0
# The installer is executed only if it matches this hash; its content pins
# Cursor 2026.10.22-27dcf5f. When Cursor publishes a new installer the build
# fails here: review it, then update with
#   curl -fsS https://cursor.com/install | sha256sum
ARG CURSOR_INSTALLER_SHA256=77d44de2cb8d12245077e290870ca4085644c5cfd534ba96334c4d6eeb8f0a7c
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@${CODEX_VERSION}
ENV HOME=/opt/cursor-install
RUN mkdir -p /opt/cursor-install && if [ "$INSTALL_CURSOR" = "1" ]; then \
      if [ -z "$CURSOR_INSTALLER_SHA256" ]; then echo "CURSOR_INSTALLER_SHA256 is required to install Cursor CLI" >&2; exit 1; fi; \
      curl --fail --silent --show-error https://cursor.com/install -o /tmp/cursor-install.sh && \
      echo "${CURSOR_INSTALLER_SHA256}  /tmp/cursor-install.sh" | sha256sum -c - && \
      bash /tmp/cursor-install.sh && rm /tmp/cursor-install.sh; \
    fi
ENV PATH=/opt/cursor-install/.local/bin:/usr/local/bin:/usr/bin:/bin
ENV HOME=/workspace/.home CODEX_HOME=/workspace/.home/.codex TMPDIR=/workspace/.tmp XDG_CONFIG_HOME=/workspace/.home/.config XDG_CACHE_HOME=/workspace/.home/.cache
WORKDIR /workspace
USER 1000:1000
