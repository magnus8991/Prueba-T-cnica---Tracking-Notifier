#!/bin/sh
# Crea la base de datos de pruebas (usada por `docker compose --profile test run --rm tests`).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE DATABASE tracking_notifier_test OWNER "$POSTGRES_USER";
SQL
