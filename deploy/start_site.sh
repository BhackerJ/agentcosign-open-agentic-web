#!/usr/bin/env bash
# Starts one site with its settings from AWS Systems Manager Parameter Store.
# Usage: start_site.sh store|buyer
set -euo pipefail
site="$1"
cd /opt/agentcosign-oaw
path="${PARAMETER_PATH:-/agentcosign-oaw}"
region="${AWS_REGION:-us-east-1}"

# Each parameter becomes an environment variable: shopify-domain -> SHOPIFY_DOMAIN.
while IFS=$'\t' read -r name value; do
  [ -n "$name" ] || continue
  key="$(basename "$name" | tr 'a-z-' 'A-Z_')"
  export "$key=$value"
done < <(aws ssm get-parameters-by-path --path "$path" --with-decryption --region "$region" \
  --query 'Parameters[].[Name,Value]' --output text)

if [ "$site" = store ]; then
  if [ -n "${SHOPIFY_CLIENT_SECRET:-}" ]; then
    exec node store/server.mjs --port 8801
  fi
  echo "No Shopify secret set: serving the sample catalog." >&2
  exec node store/server.mjs --port 8801 --catalog store/catalog.sample.json
fi
exec node buyer/server.mjs --port 8802
