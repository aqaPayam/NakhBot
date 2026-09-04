#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

restore_database="nakh_restore_smoke"
dump_path="${RUNNER_TEMP}/nakh-foundation.dump"

postgres_client() {
  if [[ -n "${POSTGRES_CONTAINER_ID:-}" ]]; then
    docker exec --env "PGPASSWORD=${PGPASSWORD}" "${POSTGRES_CONTAINER_ID}" "$@"
  else
    "$@"
  fi
}

postgres_client_input() {
  if [[ -n "${POSTGRES_CONTAINER_ID:-}" ]]; then
    docker exec --interactive --env "PGPASSWORD=${PGPASSWORD}" "${POSTGRES_CONTAINER_ID}" "$@"
  else
    "$@"
  fi
}

cleanup() {
  postgres_client dropdb --host="${PGHOST}" --username="${PGUSER}" --if-exists "${restore_database}" >/dev/null 2>&1 || true
  rm -f "${dump_path}"
}
trap cleanup EXIT

postgres_client pg_dump --host="${PGHOST}" --username="${PGUSER}" --format=custom "${PGDATABASE}" >"${dump_path}"
postgres_client dropdb --host="${PGHOST}" --username="${PGUSER}" --if-exists "${restore_database}"
postgres_client createdb --host="${PGHOST}" --username="${PGUSER}" "${restore_database}"
postgres_client_input pg_restore --host="${PGHOST}" --username="${PGUSER}" --exit-on-error --dbname="${restore_database}" <"${dump_path}"
postgres_client psql --host="${PGHOST}" --username="${PGUSER}" --dbname="${restore_database}" --set=ON_ERROR_STOP=1 --command="SELECT count(*) FROM platform.schema_migrations"
