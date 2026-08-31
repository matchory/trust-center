# syntax=docker/dockerfile:1

# --- production dependencies -------------------------------------------------
# A separate install rather than pruning the build stage's tree: pnpm's default
# symlinked layout does not survive a COPY between stages, so this one asks for
# a hoisted layout that does.
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --config.node-linker=hoisted

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# `--ignore-scripts` above skipped the prepare hook, so the message catalogs are
# compiled explicitly. This is the step that fixes the locale set into the
# image: LOCALES can only ever select a subset of what is compiled here.
RUN pnpm paraglide:compile && pnpm build
# The storage directory is created here so the runtime volume inherits its
# ownership — distroless:nonroot cannot chown anything at start.
RUN mkdir -p /data/storage && chown -R 65532:65532 /data

# --- runtime -----------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/build        ./build
# The migrations travel with the image: the server applies them at start unless
# RUN_MIGRATIONS=false.
COPY --from=build /app/drizzle      ./drizzle
# The agreement typefaces travel with the image too: a missing face is a
# failure that first appears when somebody signs a contract.
COPY --from=build /app/assets       ./assets
COPY --from=build /app/package.json ./package.json
COPY --from=build --chown=65532:65532 /data /data

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/data/storage \
    BODY_SIZE_LIMIT=32M

EXPOSE 3000
USER 65532:65532

CMD ["build/index.js"]
