# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Один образ для api і worker: монорепо на TypeScript без збірки (запуск через tsx).
# Контекст збірки — корінь репозиторію; ігнор-файл — docker/Dockerfile.dockerignore.
#   docker compose build            (див. docker-compose.yml)
#   docker build -f docker/Dockerfile .
# Аргументи: SMOKE=0 — не рендерити перевірочний 2-с ролик під час збірки.
# ─────────────────────────────────────────────────────────────────────────────

# ── База: системні залежності Chrome Headless Shell + кириличні шрифти (сніпет B3) ──
FROM node:22-bookworm-slim AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
       libasound2 libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 \
       libpango-1.0-0 libcairo2 libexpat1 \
       fonts-noto-core fonts-dejavu-core fonts-noto-color-emoji \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*

# pnpm — версія з поля packageManager кореневого package.json.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

# Chromium для краулера (Playwright). Версія має збігатися з playwright у pnpm-lock.yaml
# (це перевіряє tests/integration/test/infra.test.ts). Окремий шар — не перезбирається при зміні коду.
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps --only-shell chromium \
  && rm -rf /root/.npm /var/lib/apt/lists/*

WORKDIR /app

# ── Залежності: спершу лише lockfile (шар кешується, поки lockfile не змінився) ──
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=adc-pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

# ── Код + встановлення всередині Linux (linux-бінарники Remotion/rspack/sharp; node_modules з Windows не копіюються) ──
COPY . .
RUN --mount=type=cache,id=adc-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm/store

# Chrome Headless Shell для Remotion у фіксованому місці; рендер бере шлях з env (сніпет B3).
RUN pnpm --filter @adc/render exec remotion browser ensure
ENV REMOTION_BROWSER_EXECUTABLE=/app/packages/render/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell

# Перевірка образу: бандл (rspack) + 2-секундний рендер h264/aac. Шрифти Google Fonts — з мережі.
ARG SMOKE=1
RUN if [ "$SMOKE" = "1" ]; then pnpm smoke && rm -rf packages/render/out; fi

# DATA_DIR — том (див. docker-compose.yml). NODE_ENV=production: промпти не перечитуються на кожен виклик.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
EXPOSE 3000

# Дефолт — API; воркер запускається тим самим образом з іншою командою.
CMD ["/app/node_modules/.bin/tsx", "apps/api/src/server.ts"]
