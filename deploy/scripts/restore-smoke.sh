#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

restore_database="nakh_restore_smoke"
dump_path="${RUNNER_TEMP}/nakh-foundation.dump"

pg_dump --format=custom --file="${dump_path}" "${PGDATABASE}"
dropdb --if-exists "${restore_database}"
createdb "${restore_database}"
pg_restore --exit-on-error --dbname="${restore_database}" "${dump_path}"
psql --dbname="${restore_database}" --set=ON_ERROR_STOP=1 --command="SELECT count(*) FROM platform.schema_migrations"
dropdb "${restore_database}"
