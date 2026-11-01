# Pinned by tag and digest so a rebuild cannot silently pick up a new base.
# Update: curl -s https://hub.docker.com/v2/repositories/library/node/tags/<tag> (read "digest").
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ARG CODEX_VERSION=0.159.2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@${CODEX_VERSION}
ENV HOME=/opt/cursor-install
RUN mkdir -p /opt/cursor-install && curl --fail --silent --show-error https://cursor.com/install -o /tmp/cursor-install.sh && bash /tmp/cursor-install.sh && rm /tmp/cursor-install.sh
ENV PATH=/opt/cursor-install/.local/bin:/usr/local/bin:/usr/bin:/bin
ENV HOME=/workspace/.home CODEX_HOME=/workspace/.home/.codex TMPDIR=/workspace/.tmp XDG_CONFIG_HOME=/workspace/.home/.config XDG_CACHE_HOME=/workspace/.home/.cache
WORKDIR /workspace
USER 1000:1000
