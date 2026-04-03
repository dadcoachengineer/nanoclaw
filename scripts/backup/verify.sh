#!/usr/bin/env bash
# NanoClaw Backup Verification
#
# Validates the most recent backup by checking that all expected components
# exist and have reasonable sizes.
#
# Usage:
#   ./scripts/backup/verify.sh                   # verify latest backup
#   ./scripts/backup/verify.sh 2026-04-02        # verify specific date

set -euo pipefail

BACKUP_ROOT="/Users/nanoclaw/backups/nanoclaw"
DATE="${1:-$(ls -d "${BACKUP_ROOT}"/20??-??-?? 2>/dev/null | sort -r | head -1 | xargs basename 2>/dev/null)}"
BACKUP_DIR="${BACKUP_ROOT}/${DATE}"
ERRORS=0

if [[ -z "$DATE" ]] || [[ ! -d "$BACKUP_DIR" ]]; then
  echo "ERROR: No backup found for date '${DATE}'"
  echo "Available backups:"
  ls -d "${BACKUP_ROOT}"/20??-??-?? 2>/dev/null | sort -r | while read d; do
    echo "  $(basename "$d") — $(du -sh "$d" 2>/dev/null | cut -f1)"
  done
  exit 1
fi

echo "=== Verifying backup: ${DATE} ==="
echo ""

check_file() {
  local path="$1"
  local label="$2"
  local min_bytes="${3:-1}"

  if [[ ! -f "$path" ]]; then
    echo "FAIL  $label — file missing: $path"
    ERRORS=$((ERRORS + 1))
    return
  fi

  local size
  size=$(stat -f%z "$path" 2>/dev/null || echo 0)
  if [[ "$size" -lt "$min_bytes" ]]; then
    echo "FAIL  $label — file too small: ${size} bytes (expected >= ${min_bytes})"
    ERRORS=$((ERRORS + 1))
    return
  fi

  local human_size
  human_size=$(du -sh "$path" 2>/dev/null | cut -f1)
  echo "OK    $label ($human_size)"
}

check_dir() {
  local path="$1"
  local label="$2"
  local min_files="${3:-1}"

  if [[ ! -d "$path" ]]; then
    echo "FAIL  $label — directory missing: $path"
    ERRORS=$((ERRORS + 1))
    return
  fi

  local count
  count=$(find "$path" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -lt "$min_files" ]]; then
    echo "FAIL  $label — too few files: ${count} (expected >= ${min_files})"
    ERRORS=$((ERRORS + 1))
    return
  fi

  local human_size
  human_size=$(du -sh "$path" 2>/dev/null | cut -f1)
  echo "OK    $label (${count} files, ${human_size})"
}

# PostgreSQL dump
check_file "${BACKUP_DIR}/postgresql/nanoclaw.sql.gz" "PostgreSQL dump" 10000

# SQLite databases
check_file "${BACKUP_DIR}/sqlite/messages.db" "SQLite messages.db" 50000
check_file "${BACKUP_DIR}/sqlite/vectors.db" "SQLite vectors.db" 1000
check_file "${BACKUP_DIR}/sqlite/defenseclaw-audit.db" "DefenseClaw audit.db" 1000

# WhatsApp auth
check_dir "${BACKUP_DIR}/whatsapp-auth" "WhatsApp auth state" 10

# Groups
check_dir "${BACKUP_DIR}/groups" "Group memory" 3

# Store state
check_dir "${BACKUP_DIR}/store-state" "Store state files" 5

# Session data
check_dir "${BACKUP_DIR}/data" "Session/IPC data" 1

# Config
check_file "${BACKUP_DIR}/config/nanoclaw.env" "NanoClaw .env" 10
check_file "${BACKUP_DIR}/config/nginx-nanoclaw.conf" "Nginx config" 100

# DefenseClaw
check_file "${BACKUP_DIR}/defenseclaw/config.yaml" "DefenseClaw config" 100
check_file "${BACKUP_DIR}/defenseclaw/firewall.yaml" "DefenseClaw firewall" 100
check_file "${BACKUP_DIR}/defenseclaw/device.key" "DefenseClaw device key" 10

# Certbot
check_dir "${BACKUP_DIR}/certbot" "Certbot directory" 3

# Certs
check_dir "${BACKUP_DIR}/certs" "NanoClaw certs" 1

# LaunchAgent plists
check_dir "${BACKUP_DIR}/launchagents" "LaunchAgent plists" 10

# OneCLI
check_file "${BACKUP_DIR}/onecli/onecli-pgdata.tar.gz" "OneCLI pgdata volume" 10000
check_file "${BACKUP_DIR}/onecli/onecli-appdata.tar.gz" "OneCLI app-data volume" 100
check_file "${BACKUP_DIR}/onecli/secrets-inventory.json" "OneCLI secrets inventory" 50

# Manifest
check_file "${BACKUP_DIR}/manifest.json" "Backup manifest" 100

echo ""
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
if [[ "$ERRORS" -eq 0 ]]; then
  echo "=== ALL CHECKS PASSED (total backup size: ${TOTAL_SIZE}) ==="
else
  echo "=== ${ERRORS} CHECK(S) FAILED (total backup size: ${TOTAL_SIZE}) ==="
fi

exit $ERRORS
