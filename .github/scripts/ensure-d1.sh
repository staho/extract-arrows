#!/usr/bin/env bash
# Resolve a real D1 database_id, patch wrangler.jsonc if needed, apply migrations.
# Run from a game directory that may contain wrangler.jsonc + migrations/.
set -euo pipefail

is_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

if [[ ! -d migrations ]]; then
  echo "No D1 migrations; skipping."
  exit 0
fi

json=$(sed 's|//.*||' wrangler.jsonc)
db_name=$(jq -r '.d1_databases[0].database_name // empty' <<<"$json")
db_id=$(jq -r '.d1_databases[0].database_id // empty' <<<"$json")

if [[ -z "$db_name" ]]; then
  echo "migrations/ is present but wrangler.jsonc has no d1_databases[0].database_name"
  exit 1
fi

if is_uuid "$db_id"; then
  echo "Using database_id from wrangler.jsonc: $db_id"
else
  echo "database_id '${db_id}' is not a UUID; looking up D1 database '${db_name}'"
  list_json=$(npx --yes wrangler@4 d1 list --json)
  db_id=$(jq -r --arg name "$db_name" '
    .[]
    | select(.name == $name)
    | .uuid // .id // empty
  ' <<<"$list_json" | head -n1)

  if [[ -z "$db_id" ]]; then
    echo "Creating D1 database '${db_name}'"
    create_out=$(npx --yes wrangler@4 d1 create "$db_name")
    printf '%s\n' "$create_out"
    db_id=$(grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' <<<"$create_out" | tail -n1)
  fi

  if ! is_uuid "$db_id"; then
    echo "Could not resolve a D1 database UUID for '${db_name}'"
    exit 1
  fi

  echo "Resolved database_id: $db_id"
  jq --arg id "$db_id" '.d1_databases[0].database_id = $id' <<<"$json" > wrangler.jsonc.tmp
  mv wrangler.jsonc.tmp wrangler.jsonc
fi

npx --yes wrangler@4 d1 migrations apply "$db_name" --remote
