FROM node:26.11.1-bookworm-slim AS build

ARG APP
WORKDIR /workspace
RUN corepack enable \
    && for pnpm_attempt in 1 2 3; do \
         if timeout --kill-after=10s 120s corepack prepare pnpm@11.19.0 --activate; then break; fi; \
         if [ "$pnpm_attempt" = "3" ]; then exit 1; fi; \
         sleep 5; \
       done
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter "@nakh/${APP}" --prod deploy /out

FROM node:26.11.1-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 nakh && useradd --system --uid 10001 --gid nakh nakh
COPY --from=build --chown=nakh:nakh /out/ ./
COPY --from=build --chown=nakh:nakh /workspace/migrations ./migrations
USER nakh
CMD ["node", "dist/main.js"]
