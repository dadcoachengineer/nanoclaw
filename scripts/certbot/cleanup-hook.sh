#!/usr/bin/env bash
# Certbot DNS-01 cleanup hook — removes TXT record via Cloudflare API through OneCLI proxy.
#
# Certbot sets: CERTBOT_DOMAIN

set -euo pipefail

ZONE_ID="213cfcd76b0d180c78f981fa9f83e7d9"  # shearer.live
ONECLI_TOKEN="${ONECLI_AGENT_TOKEN:?ONECLI_AGENT_TOKEN is required; see docs/ONECLI_AGENT_CREDENTIALS.md}"
CA_CERT="/Users/nanoclaw/nanoclaw/certs/onecli-ca.pem"
RECORD_FILE="/tmp/certbot_cf_record_${CERTBOT_DOMAIN}"

onecli_curl() {
  # Keep the bearer credential out of argv. curl reads proxy authentication
  # from its stdin config and the config is never written to disk.
  {
    printf '%s\n' 'proxy = "http://localhost:10255"'
    printf 'proxy-user = "x:%s"\n' "$ONECLI_TOKEN"
  } | curl --config - "$@"
}

if [ ! -f "$RECORD_FILE" ]; then
  echo "WARN: No record file found for ${CERTBOT_DOMAIN}" >&2
  exit 0
fi

RECORD_ID=$(cat "$RECORD_FILE")

# Delete the TXT record
onecli_curl -sS --fail-with-body --cacert "$CA_CERT" \
  -X DELETE "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}" \
  > /dev/null

rm -f "$RECORD_FILE"
