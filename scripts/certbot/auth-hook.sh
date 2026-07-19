#!/usr/bin/env bash
# Certbot DNS-01 auth hook — creates TXT record via Cloudflare API through OneCLI proxy.
# No plaintext API tokens on disk. OneCLI injects the Authorization header.
#
# Certbot sets these env vars:
#   CERTBOT_DOMAIN    — domain being validated
#   CERTBOT_VALIDATION — the validation string to put in the TXT record

set -euo pipefail

ZONE_ID="213cfcd76b0d180c78f981fa9f83e7d9"  # shearer.live
ONECLI_TOKEN="${ONECLI_AGENT_TOKEN:?ONECLI_AGENT_TOKEN is required; see docs/ONECLI_AGENT_CREDENTIALS.md}"
CA_CERT="/Users/nanoclaw/nanoclaw/certs/onecli-ca.pem"
RECORD_NAME="_acme-challenge.${CERTBOT_DOMAIN}"

onecli_curl() {
  # Keep the bearer credential out of argv. curl reads proxy authentication
  # from its stdin config and the config is never written to disk.
  {
    printf '%s\n' 'proxy = "http://localhost:10255"'
    printf 'proxy-user = "x:%s"\n' "$ONECLI_TOKEN"
  } | curl --config - "$@"
}

# Create the TXT record
if ! RESPONSE=$(onecli_curl -sS --fail-with-body --cacert "$CA_CERT" \
  -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  -H "Content-Type: application/json" \
  --data "{\"type\":\"TXT\",\"name\":\"${RECORD_NAME}\",\"content\":\"${CERTBOT_VALIDATION}\",\"ttl\":120}"); then
  echo "ERROR: OneCLI-proxied Cloudflare request failed" >&2
  exit 1
fi

RECORD_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('id',''))" 2>/dev/null)

if [ -z "$RECORD_ID" ]; then
  echo "ERROR: Failed to create DNS record (provider response omitted)" >&2
  exit 1
fi

# Store record ID for cleanup hook
echo "$RECORD_ID" > "/tmp/certbot_cf_record_${CERTBOT_DOMAIN}"

# Wait for DNS propagation
sleep 15
