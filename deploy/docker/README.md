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

## Free staging rehearsal

After Docker Desktop is installed, exercise the production images and all M1 reliability checks without buying cloud resources:

```powershell
powershell -ExecutionPolicy Bypass -File deploy/scripts/local-staging-rehearsal.ps1
```

The script uses `compose.yml` plus `compose.staging.yml`, verifies the API and Telegram gateway, checks invalid/valid/duplicate webhook delivery and restart persistence, and runs the PostgreSQL/Redis integration and load suites. It removes its volumes unless `-KeepEnvironment` is supplied. This is preparation only; it cannot replace the real staging acceptance record.
