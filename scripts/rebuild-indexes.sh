#!/bin/bash
# Rebuild person, topic, and vector indexes.
# Called daily by launchd (com.nanoclaw.person-index).
set -e

cd /Users/nanoclaw/nanoclaw

echo "=== $(date) — Starting index rebuild ==="

echo "--- Person + Topic Index ---"
npx tsx scripts/build-person-index.ts

echo "--- Vector Index ---"
npx tsx scripts/build-vector-index.ts

echo "=== Done ==="
