#!/usr/bin/env bash
# Resolve a real D1 database_id, patch wrangler.jsonc if needed, apply migrations.
# Run from a game directory that may contain wrangler.jsonc + migrations/.
# If the API token cannot access D1, strip the binding so Worker deploy still
# succeeds and the game falls back to bundled arrows.json.
set -euo pipefail

is_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

patch_wrangler() {
  jq "$@" <<<"$json" > wrangler.jsonc.tmp
  mv wrangler.jsonc.tmp wrangler.jsonc
  json=$(cat wrangler.jsonc)
}

skip_d1() {
  echo "Skipping remote D1: $1"
  patch_wrangler 'del(.d1_databases)'
  echo "Removed d1_databases from wrangler.jsonc for this deploy."
  exit 0
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

if ! is_uuid "$db_id"; then
  echo "database_id '${db_id}' is not a UUID; looking up D1 database '${db_name}'"
  set +e
  list_json=$(npx --yes wrangler@4 d1 list --json 2>/tmp/d1-list.err)
  list_status=$?
  set -e
  if [[ $list_status -ne 0 ]]; then
    cat /tmp/d1-list.err || true
    skip_d1 "wrangler d1 list failed (token may lack D1 permission)"
  fi

  db_id=$(jq -r --arg name "$db_name" '
    .[]
    | select(.name == $name)
    | .uuid // .id // empty
  ' <<<"$list_json" | head -n1)

  if [[ -z "$db_id" ]]; then
    echo "Creating D1 database '${db_name}'"
    set +e
    create_out=$(npx --yes wrangler@4 d1 create "$db_name" 2>/tmp/d1-create.err)
    create_status=$?
    set -e
    if [[ $create_status -ne 0 ]]; then
      printf '%s\n' "$create_out"
      cat /tmp/d1-create.err || true
      skip_d1 "wrangler d1 create failed (token may lack D1 permission)"
    fi
    printf '%s\n' "$create_out"
    db_id=$(grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' <<<"$create_out" | tail -n1)
  fi

  if ! is_uuid "$db_id"; then
    skip_d1 "could not resolve a D1 UUID for '${db_name}'"
  fi

  echo "Resolved database_id: $db_id"
  patch_wrangler --arg id "$db_id" '.d1_databases[0].database_id = $id'
fi

npx --yes wrangler@4 d1 migrations apply "$db_name" --remote
