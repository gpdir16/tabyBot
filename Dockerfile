FROM node:22-bookworm-slim

ARG TABYAGENT_VERSION=dev
ARG BROWSER_USE_VERSION=0.13.3

WORKDIR /app
ENV TABYAGENT_VERSION=${TABYAGENT_VERSION}
ENV TABYAGENT_MODE=docker
RUN printf '%s\n' "${TABYAGENT_VERSION}" > /app/VERSION
LABEL org.opencontainers.image.version="${TABYAGENT_VERSION}"
ENV USER_DIR=/app/user
ENV WORKSPACE_DIR=/workspace
ENV APP_ROOT=/app
ENV CODES_DIR=/app/codes
ENV CONFIG_DIR=/app/codes/config
ENV NODE_ENV=production
ENV HEADLESS=true
# Browser Use package 0.13.3 is the current CLI 3.0 line.
ENV BROWSER_USE_VERSION=${BROWSER_USE_VERSION}
# Browser Use CLI 3.0 connects to a CDP endpoint. In Docker, the entrypoint
# launches the bundled Chromium on :9222 for the daemon to attach to.
ENV BU_CDP_URL=http://127.0.0.1:9222
# Isolate browser-harness daemon sockets under /tmp so they survive restarts
# and don't collide with any host runtime dir bind-mount.
ENV BH_RUNTIME_DIR=/tmp/bh-runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
        fonts-noto-cjk \
        python3 \
        python3-pip \
        xvfb \
        xdotool \
        xterm \
        x11-apps \
        imagemagick \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --upgrade "browser-use==${BROWSER_USE_VERSION}" 'uv' \
    && browser-use install

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY codes ./codes

RUN chmod +x /app/codes/skills/browser-use/install-stealth.sh \
    && /app/codes/skills/browser-use/install-stealth.sh

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh codes/cli.js

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["start"]
