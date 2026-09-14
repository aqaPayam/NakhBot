# Local infrastructure and images

Start dependencies from the repository root:

```sh
docker compose -f deploy/docker/compose.yml up -d postgres redis clamav
cp .env.example .env
pnpm db:migrate
pnpm db:verify
```

Build one production image by passing `APP` as `api`, `telegram-gateway`, `worker`, or `scheduler`:

```sh
docker build -f deploy/docker/Dockerfile --build-arg APP=api -t nakh-api:dev .
```

The Compose credentials are local-only. Production uses managed PostgreSQL/Redis and secret references.
ClamAV runs as a private TCP service on port 3310. The pinned `clamav/clamav-debian:1.5.4` image includes its signature database and uses a named volume for updates. The media worker must wait for its health check before consuming upload jobs; the scanner does not expose a host port in the staging overlay.

Media ingestion is fail-closed with `NAKH_MEDIA_INGESTION_ENABLED=false`. Enable it only after the R2 endpoint/bucket are private and the named environment variables referenced by the Telegram token, R2 credentials, and 32-byte base64url transport key settings are injected by the deployment secret manager. Secret values never belong in Compose files or `NAKH_*_REF` settings.

Media deletion cleanup is independently fail-closed with `NAKH_MEDIA_CLEANUP_ENABLED=false`.
Before enabling it, inject the variables named by `NAKH_R2_CLEANUP_ACCESS_KEY_REF` and
`NAKH_R2_CLEANUP_SECRET_KEY_REF` using credentials scoped to list, head, and delete only the
ordinary media prefixes in the configured private bucket. Do not grant access to moderation evidence.

## Free staging rehearsal

After Docker Desktop is installed, exercise the production images and all M1 reliability checks without buying cloud resources:

```powershell
powershell -ExecutionPolicy Bypass -File deploy/scripts/local-staging-rehearsal.ps1
```

The script uses `compose.yml` plus `compose.staging.yml`, verifies the API and Telegram gateway, checks invalid/valid/duplicate webhook delivery and restart persistence, and runs the PostgreSQL/Redis integration and load suites. It removes its volumes unless `-KeepEnvironment` is supplied. This is preparation only; it cannot replace the real staging acceptance record.
