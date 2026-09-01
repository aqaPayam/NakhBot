# Local infrastructure and images

Start dependencies from the repository root:

```sh
docker compose -f deploy/docker/compose.yml up -d postgres redis
cp .env.example .env
pnpm db:migrate
pnpm db:verify
```

Build one production image by passing `APP` as `api`, `telegram-gateway`, `worker`, or `scheduler`:

```sh
docker build -f deploy/docker/Dockerfile --build-arg APP=api -t nakh-api:dev .
```

The Compose credentials are local-only. Production uses managed PostgreSQL/Redis and secret references.
