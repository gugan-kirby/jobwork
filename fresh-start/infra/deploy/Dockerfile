# One image holds all four deployables; compose picks the process (ADR-0008).
# Build context is the fresh-start directory.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .

# The web apps' /api rewrite is compiled into their build, so API_URL is a build value.
ARG API_URL=http://api:4000
RUN pnpm install --frozen-lockfile && API_URL="$API_URL" pnpm build

RUN chown -R node:node apps/portal-web/.next apps/operations-web/.next
USER node
