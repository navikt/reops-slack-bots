# syntax=docker/dockerfile:1

# Stage 1: build — Chainguard Node via Nav pull-through (pinned major, no latest)
FROM europe-north1-docker.pkg.dev/cgr-nav/pull-through/nav.no/node:22-dev AS builder
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

USER root
# pnpm 12 is a native binary. Wolfi base has no curl/wget, so fetch the
# standalone binary from GitHub releases via node. Keep packageManager in
# package.json in sync with this version.
COPY scripts/install-pnpm.mjs /tmp/install-pnpm.mjs
RUN node /tmp/install-pnpm.mjs 12.11.1 /opt/pnpm /usr/local/bin/pnpm && \
    rm /tmp/install-pnpm.mjs && \
    pnpm --version
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# minimumReleaseAge policy queries the registry for every package; @navikt/*
# lives on GitHub Packages, which 401s without a token -> policy would fail.
RUN --mount=type=secret,id=NODE_AUTH_TOKEN,uid=65532 \
    pnpm config set "//npm.pkg.github.com/:_authToken" "$(cat /run/secrets/NODE_AUTH_TOKEN)" && \
    pnpm install --frozen-lockfile

COPY --chown=node:node . .

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

RUN pnpm run build

# Stage 2: distroless runtime
FROM europe-north1-docker.pkg.dev/cgr-nav/pull-through/nav.no/node:22-slim AS runner
WORKDIR /app

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production
ENV PORT=9092
ENV HOSTNAME="0.0.0.0"
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# Migration .sql files are read at runtime via readdir — standalone tracing
# doesn't include them, so copy them explicitly.
COPY --from=builder --chown=node:node /app/src/lib/migrations ./src/lib/migrations

EXPOSE 9092
CMD ["server.js"]
