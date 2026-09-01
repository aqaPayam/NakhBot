FROM node:24.19.0-bookworm-slim AS build

ARG APP
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter "@nakh/${APP}" --prod deploy /out

FROM node:24.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 nakh && useradd --system --uid 10001 --gid nakh nakh
COPY --from=build --chown=nakh:nakh /out/ ./
USER nakh
CMD ["node", "dist/main.js"]
