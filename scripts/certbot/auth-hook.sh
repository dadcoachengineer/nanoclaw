#!/usr/bin/env bash
# Certbot DNS-01 auth hook — creates TXT record via Cloudflare API through OneCLI proxy.
# No plaintext API tokens on disk. OneCLI injects the Authorization header.
#
# Certbot sets these env vars:
#   CERTBOT_DOMAIN    — domain being validated
#   CERTBOT_VALIDATION — the validation string to put in the TXT record

set -euo pipefail

ZONE_ID="213cfcd76b0d180c78f981fa9f83e7d9"  # shearer.live
ONECLI_TOKEN="${ONECLI_AGENT_TOKEN:-aoc_181429a83379e2122e9e0b6cde6eefd6b897809b92c08cc4bc788816e26e399a}"
PROXY="http://x:${ONECLI_TOKEN}@localhost:10255"
CA_CERT="/Users/nanoclaw/nanoclaw/certs/onecli-ca.pem"
RECORD_NAME="_acme-challenge.${CERTBOT_DOMAIN}"

# Create the TXT record
RESPONSE=$(curl -s --cacert "$CA_CERT" -x "$PROXY" \
  -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  -H "Content-Type: application/json" \
  --data "{\"type\":\"TXT\",\"name\":\"${RECORD_NAME}\",\"content\":\"${CERTBOT_VALIDATION}\",\"ttl\":120}")

RECORD_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('id',''))" 2>/dev/null)

if [ -z "$RECORD_ID" ]; then
  echo "ERROR: Failed to create DNS record" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

# Store record ID for cleanup hook
echo "$RECORD_ID" > "/tmp/certbot_cf_record_${CERTBOT_DOMAIN}"

# Wait for DNS propagation
sleep 15
