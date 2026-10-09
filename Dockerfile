# syntax=docker/dockerfile:1

# Stage 1: build — Chainguard Node via Nav pull-through (pinned major, no latest)
FROM europe-north1-docker.pkg.dev/cgr-nav/pull-through/nav.no/node:22-dev AS builder
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

USER root
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

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

EXPOSE 9092
CMD ["server.js"]
