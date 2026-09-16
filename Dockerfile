FROM node:22-bookworm-slim

ARG TABYBOT_VERSION=dev
ARG CAMOFOX_VERSION=2.4.7

WORKDIR /app
ENV TABYBOT_VERSION=${TABYBOT_VERSION}
ENV TABYBOT_MODE=docker
RUN printf '%s\n' "${TABYBOT_VERSION}" > /app/VERSION
LABEL org.opencontainers.image.version="${TABYBOT_VERSION}"
ENV USER_DIR=/app/user
ENV HOME=/app/user
ENV APP_ROOT=/app
EXPOSE 8999
ENV CODES_DIR=/app/codes
ENV CONFIG_DIR=/app/codes/config
ENV NODE_ENV=production
ENV HEADLESS=true
ENV CAMOFOX_VERSION=${CAMOFOX_VERSION}
ENV CAMOFOX_HOST=127.0.0.1
ENV CAMOFOX_PORT=9377
ENV CAMOFOX_AUTH_MODE=disabled
ENV CAMOFOX_HUMANIZE=true
ENV CAMOFOX_PROFILES_DIR=/app/user/camofox/profiles
ENV CAMOFOX_COOKIES_DIR=/app/user/camofox/cookies
ENV CAMOFOX_DOWNLOADS_DIR=/app/user/camofox/downloads
ENV CAMOFOX_TRACES_DIR=/app/user/camofox/traces

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        python3-websockify \
        libgtk-3-0 \
        libdbus-glib-1-2 \
        libxt6 \
        libx11-xcb1 \
        libasound2 \
        libdrm2 \
        libgbm1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        libnss3 \
        libnspr4 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libxkbcommon0 \
        libxshmfence1 \
        fonts-freefont-ttf \
        fonts-liberation \
        fonts-noto \
        fonts-noto-color-emoji \
        fontconfig \
        ca-certificates \
        curl \
        python3 \
        git \
        make \
        g++ \
        xdotool \
        xterm \
        x11-apps \
        imagemagick \
        tini \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/user \
    && npm install --global "camofox-browser@${CAMOFOX_VERSION}"

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 공유 X 디스플레이: 웹 "컴퓨터" 뷰가 이 화면을 스트리밍한다.
# DISPLAY/CAMOFOX_HEADLESS는 런타임 전용이라 하단에 두어 앞 레이어 캐시를 보존한다.
ENV DISPLAY=:99
ENV CAMOFOX_HEADLESS=false
# camofox의 유휴 정리는 API 액세스 기준 — 화면 조작(xdotool)은 API를 타지 않아
# 쓰는 중에도 30분 만에 세션 만료/서버 종료가 일어난다. 봇 브라우저가 닫히지 않게 7일로.
ENV CAMOFOX_IDLE_TIMEOUT_MS=3153600000000
ENV CAMOFOX_IDLE_EXIT_TIMEOUT_MS=3153600000000
ENV CAMOFOX_SESSION_TIMEOUT=3153600000000

COPY codes ./codes

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["start"]
