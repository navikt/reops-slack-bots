# syntax=docker/dockerfile:1

# Base stage - Chainguard Node.js image with pnpm
FROM cgr.dev/chainguard/node:latest-dev AS base
USER root
RUN apk update && apk add --no-cache pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN mkdir -p "$PNPM_HOME" && chown -R node:node "$PNPM_HOME"
USER node

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /usr/src/app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store,uid=65532 \
    pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /usr/src/app

COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --chown=node:node . .

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=true

RUN pnpm build

# ── Production image ──────────────────────────────────────────────────────────
FROM cgr.dev/chainguard/node@sha256:c002402b355201714dfbeb3b1a7ca99152cccced4b334496db2442a3a9bf4883 AS runner
WORKDIR /usr/src/app

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /usr/src/app/public ./public
COPY --from=builder --chown=node:node /usr/src/app/.next/standalone ./
COPY --from=builder --chown=node:node /usr/src/app/.next/static ./.next/static

EXPOSE 9092
ENV PORT=9092
ENV HOSTNAME="0.0.0.0"

CMD ["server.js"]
