# Linux runtime used to rehearse the server setup on the laptop (ADR-0017). Not a deployment target:
# production is bare systemd on the VPS (ADR-0015). Holds no secrets; state lives in compose volumes.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# git, gh (GitHub CLI) and curl as on the server; no Docker CLI (Postgres is a sibling compose service).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends gh nodejs \
 && corepack enable \
 && curl -fsSL https://artifacts-cli.infisical.com/setup.deb.sh | bash \
 && apt-get install -y --no-install-recommends infisical \
 && rm -rf /var/lib/apt/lists/*

# ADR-0022: Chromium plus its system libraries for the UI check's Playwright MCP. Installed as root,
# into a shared path both root and jarvis can read, so the MCP server (a grandchild of the engine)
# finds a browser without downloading one per run. Adds roughly 400 MB to the image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@1.64.1 install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# Ubuntu 24.04 ships a user with uid 1000 ("ubuntu"); replace it so the server user is jarvis (uid 1000).
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd -m -u 1000 -s /bin/bash jarvis

# Mount points are created here, owned by jarvis, so the named volumes mounted over them are writable.
RUN mkdir -p /home/jarvis/.jarvis /home/jarvis/.claude /home/jarvis/jarvis/node_modules \
      /home/jarvis/jarvis/shared/node_modules /home/jarvis/jarvis/engine/node_modules \
      /home/jarvis/jarvis/web/node_modules /work/repo \
 && chown -R jarvis:jarvis /home/jarvis /work

USER jarvis
ENV HOME=/home/jarvis \
    PATH=/home/jarvis/.local/bin:$PATH \
    CLAUDE_CONFIG_DIR=/home/jarvis/.claude \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Claude Code from the official installer, as the server does it.
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /home/jarvis/jarvis
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
