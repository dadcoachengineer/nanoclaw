#!/usr/bin/env bash
# Certbot DNS-01 cleanup hook — removes TXT record via Cloudflare API through OneCLI proxy.
#
# Certbot sets: CERTBOT_DOMAIN

set -euo pipefail

ZONE_ID="213cfcd76b0d180c78f981fa9f83e7d9"  # shearer.live
ONECLI_TOKEN="${ONECLI_AGENT_TOKEN:-aoc_181429a83379e2122e9e0b6cde6eefd6b897809b92c08cc4bc788816e26e399a}"
PROXY="http://x:${ONECLI_TOKEN}@localhost:10255"
CA_CERT="/Users/nanoclaw/nanoclaw/certs/onecli-ca.pem"
RECORD_FILE="/tmp/certbot_cf_record_${CERTBOT_DOMAIN}"

if [ ! -f "$RECORD_FILE" ]; then
  echo "WARN: No record file found for ${CERTBOT_DOMAIN}" >&2
  exit 0
fi

RECORD_ID=$(cat "$RECORD_FILE")

# Delete the TXT record
curl -s --cacert "$CA_CERT" -x "$PROXY" \
  -X DELETE "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}" \
  > /dev/null

rm -f "$RECORD_FILE"
