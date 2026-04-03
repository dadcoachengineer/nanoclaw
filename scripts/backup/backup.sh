#!/usr/bin/env bash
# NanoClaw Daily Backup Script
#
# Backs up all critical data stores, configs, secrets, and state.
# Destination: /Users/nanoclaw/backups/nanoclaw/YYYY-MM-DD/
#
# Usage:
#   ./scripts/backup/backup.sh          # full backup
#   ./scripts/backup/backup.sh --dry-run # show what would be backed up
#
# Retention: keeps 14 daily backups, 4 weekly (Sunday), 3 monthly (1st).

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

BACKUP_ROOT="/Users/nanoclaw/backups/nanoclaw"
NANOCLAW_DIR="/Users/nanoclaw/nanoclaw"
HOME_DIR="/Users/nanoclaw"
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)
BACKUP_DIR="${BACKUP_ROOT}/${DATE}"
LOG_FILE="${NANOCLAW_DIR}/logs/backup.log"
DRY_RUN=false
ERRORS=0

# Retention policy
DAILY_KEEP=14
WEEKLY_KEEP=4
MONTHLY_KEEP=3

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# ── Helpers ────────────────────────────────────────────────────────────────────

log() {
  local msg="[${TIMESTAMP}] $1"
  echo "$msg"
  if [[ "$DRY_RUN" == false ]]; then
    echo "$msg" >> "$LOG_FILE"
  fi
}

fail() {
  log "ERROR: $1"
  ERRORS=$((ERRORS + 1))
}

backup_dir() {
  local src="$1"
  local dest="$2"
  local label="$3"

  if [[ ! -d "$src" ]]; then
    fail "$label: source directory not found: $src"
    return
  fi

  log "Backing up $label: $src -> $dest"
  if [[ "$DRY_RUN" == false ]]; then
    mkdir -p "$dest"
    rsync -a --delete "$src/" "$dest/" 2>> "$LOG_FILE" || fail "$label rsync failed"
  fi
}

backup_file() {
  local src="$1"
  local dest="$2"
  local label="$3"

  if [[ ! -f "$src" ]]; then
    fail "$label: source file not found: $src"
    return
  fi

  log "Backing up $label: $src -> $dest"
  if [[ "$DRY_RUN" == false ]]; then
    mkdir -p "$(dirname "$dest")"
    cp -p "$src" "$dest" 2>> "$LOG_FILE" || fail "$label copy failed"
  fi
}

# ── Start ──────────────────────────────────────────────────────────────────────

log "=== NanoClaw backup started ($DATE) ==="
if [[ "$DRY_RUN" == true ]]; then
  log "DRY RUN — no files will be written"
fi

if [[ "$DRY_RUN" == false ]]; then
  mkdir -p "$BACKUP_DIR"
  mkdir -p "$(dirname "$LOG_FILE")"
fi

# ── 1. PostgreSQL (nanoclaw database) ─────────────────────────────────────────

log "--- PostgreSQL dump ---"
PG_DUMP_FILE="${BACKUP_DIR}/postgresql/nanoclaw.sql.gz"
if [[ "$DRY_RUN" == false ]]; then
  mkdir -p "${BACKUP_DIR}/postgresql"
  if /opt/homebrew/bin/pg_dump -d nanoclaw --no-owner --no-acl 2>> "$LOG_FILE" | gzip > "$PG_DUMP_FILE"; then
    PG_SIZE=$(du -sh "$PG_DUMP_FILE" 2>/dev/null | cut -f1)
    log "PostgreSQL dump complete: $PG_SIZE"
  else
    fail "PostgreSQL pg_dump failed"
  fi
else
  log "Would dump: pg_dump -d nanoclaw | gzip -> $PG_DUMP_FILE"
fi

# ── 2. SQLite databases ──────────────────────────────────────────────────────

log "--- SQLite databases ---"
SQLITE_DIR="${BACKUP_DIR}/sqlite"

# messages.db — the WhatsApp message bus
backup_file "${NANOCLAW_DIR}/store/messages.db" "${SQLITE_DIR}/messages.db" "SQLite messages.db"

# vectors.db — local vector search index
backup_file "${NANOCLAW_DIR}/store/vectors.db" "${SQLITE_DIR}/vectors.db" "SQLite vectors.db"

# nanoclaw.db — legacy (may be empty but preserve it)
backup_file "${NANOCLAW_DIR}/store/nanoclaw.db" "${SQLITE_DIR}/nanoclaw.db" "SQLite nanoclaw.db"

# DefenseClaw audit database
backup_file "${HOME_DIR}/.defenseclaw/audit.db" "${SQLITE_DIR}/defenseclaw-audit.db" "DefenseClaw audit.db"

# ── 3. WhatsApp auth state ────────────────────────────────────────────────────

log "--- WhatsApp auth state ---"
backup_dir "${NANOCLAW_DIR}/store/auth" "${BACKUP_DIR}/whatsapp-auth" "WhatsApp auth"

# ── 4. Group memory and state ────────────────────────────────────────────────

log "--- Group memory (CLAUDE.md files + state) ---"
backup_dir "${NANOCLAW_DIR}/groups" "${BACKUP_DIR}/groups" "Group memory"

# ── 5. Store state files (pipeline state, summaries, etc.) ───────────────────

log "--- Store state files ---"
STATE_DIR="${BACKUP_DIR}/store-state"
for f in "${NANOCLAW_DIR}"/store/*.json "${NANOCLAW_DIR}"/store/*.txt "${NANOCLAW_DIR}"/store/profile.md; do
  if [[ -f "$f" ]]; then
    backup_file "$f" "${STATE_DIR}/$(basename "$f")" "Store: $(basename "$f")"
  fi
done

# auth.json (WhatsApp connection state)
backup_file "${NANOCLAW_DIR}/store/auth.json" "${STATE_DIR}/auth.json" "Store: auth.json"

# ── 6. Session data ──────────────────────────────────────────────────────────

log "--- Session data ---"
backup_dir "${NANOCLAW_DIR}/data" "${BACKUP_DIR}/data" "Session/IPC data"

# ── 7. NanoClaw configuration files ──────────────────────────────────────────

log "--- Configuration files ---"
CONFIG_DIR="${BACKUP_DIR}/config"

# .env — local environment overrides
backup_file "${NANOCLAW_DIR}/.env" "${CONFIG_DIR}/nanoclaw.env" "NanoClaw .env"

# Mount allowlist
backup_file "${HOME_DIR}/.config/nanoclaw/mount-allowlist.json" "${CONFIG_DIR}/mount-allowlist.json" "Mount allowlist"

# Nginx config
backup_file "/opt/homebrew/etc/nginx/servers/nanoclaw.conf" "${CONFIG_DIR}/nginx-nanoclaw.conf" "Nginx config"

# ── 8. DefenseClaw configs ───────────────────────────────────────────────────

log "--- DefenseClaw ---"
DC_DIR="${BACKUP_DIR}/defenseclaw"
backup_file "${HOME_DIR}/.defenseclaw/config.yaml" "${DC_DIR}/config.yaml" "DefenseClaw config"
backup_file "${HOME_DIR}/.defenseclaw/firewall.yaml" "${DC_DIR}/firewall.yaml" "DefenseClaw firewall"
backup_file "${HOME_DIR}/.defenseclaw/device.key" "${DC_DIR}/device.key" "DefenseClaw device key"
backup_file "${HOME_DIR}/.defenseclaw/guardrail_runtime.json" "${DC_DIR}/guardrail_runtime.json" "DefenseClaw guardrail runtime"

# DefenseClaw policies
backup_dir "${HOME_DIR}/defenseclaw/policies" "${DC_DIR}/policies" "DefenseClaw policies"

# ── 9. TLS certificates ─────────────────────────────────────────────────────

log "--- TLS certificates ---"
backup_dir "${HOME_DIR}/.certbot" "${BACKUP_DIR}/certbot" "Certbot (TLS certs)"

# NanoClaw internal certs (OneCLI CA, etc.)
backup_dir "${NANOCLAW_DIR}/certs" "${BACKUP_DIR}/certs" "NanoClaw certs"

# ── 10. Certbot hooks (contain Cloudflare zone ID) ──────────────────────────

log "--- Certbot hooks ---"
backup_dir "${NANOCLAW_DIR}/scripts/certbot" "${BACKUP_DIR}/certbot-hooks" "Certbot DNS hooks"

# ── 11. LaunchAgent plists ───────────────────────────────────────────────────

log "--- LaunchAgent plists ---"
PLIST_DIR="${BACKUP_DIR}/launchagents"
if [[ "$DRY_RUN" == false ]]; then
  mkdir -p "$PLIST_DIR"
fi
for plist in "${HOME_DIR}"/Library/LaunchAgents/com.nanoclaw*.plist \
             "${HOME_DIR}"/Library/LaunchAgents/homebrew.mxcl.nginx.plist \
             "${HOME_DIR}"/Library/LaunchAgents/homebrew.mxcl.postgresql@17.plist; do
  if [[ -f "$plist" ]]; then
    backup_file "$plist" "${PLIST_DIR}/$(basename "$plist")" "Plist: $(basename "$plist")"
  fi
done

# ── 12. OneCLI Docker volumes ───────────────────────────────────────────────

log "--- OneCLI data (Docker volume export) ---"
ONECLI_DIR="${BACKUP_DIR}/onecli"
if [[ "$DRY_RUN" == false ]]; then
  mkdir -p "$ONECLI_DIR"

  # Export OneCLI postgres data (contains secrets vault)
  if docker run --rm -v onecli_pgdata:/data -v "${ONECLI_DIR}:/backup" alpine \
    tar czf /backup/onecli-pgdata.tar.gz -C /data . 2>> "$LOG_FILE"; then
    log "OneCLI pgdata volume exported"
  else
    fail "OneCLI pgdata volume export failed"
  fi

  # Export OneCLI app data
  if docker run --rm -v onecli_app-data:/data -v "${ONECLI_DIR}:/backup" alpine \
    tar czf /backup/onecli-appdata.tar.gz -C /data . 2>> "$LOG_FILE"; then
    log "OneCLI app-data volume exported"
  else
    fail "OneCLI app-data volume export failed"
  fi

  # Also dump OneCLI secrets list (metadata only, not values)
  if /Users/nanoclaw/.local/bin/onecli secrets list > "${ONECLI_DIR}/secrets-inventory.json" 2>> "$LOG_FILE"; then
    log "OneCLI secrets inventory saved"
  else
    fail "OneCLI secrets inventory export failed"
  fi
else
  log "Would export Docker volumes: onecli_pgdata, onecli_app-data"
fi

# ── 13. Dashboard config ────────────────────────────────────────────────────

log "--- Dashboard config ---"
backup_file "${NANOCLAW_DIR}/dashboard/next.config.ts" "${BACKUP_DIR}/dashboard/next.config.ts" "Dashboard next.config.ts"

# ── 14. Backup manifest ─────────────────────────────────────────────────────

log "--- Writing backup manifest ---"
if [[ "$DRY_RUN" == false ]]; then
  MANIFEST="${BACKUP_DIR}/manifest.json"
  TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
  cat > "$MANIFEST" << MANIFEST_EOF
{
  "date": "${DATE}",
  "timestamp": "${TIMESTAMP}",
  "hostname": "$(hostname)",
  "total_size": "${TOTAL_SIZE}",
  "components": {
    "postgresql": "nanoclaw.sql.gz",
    "sqlite": ["messages.db", "vectors.db", "nanoclaw.db", "defenseclaw-audit.db"],
    "whatsapp_auth": "whatsapp-auth/",
    "groups": "groups/",
    "store_state": "store-state/",
    "session_data": "data/",
    "config": "config/",
    "defenseclaw": "defenseclaw/",
    "certbot": "certbot/",
    "certs": "certs/",
    "launchagents": "launchagents/",
    "onecli": "onecli/",
    "dashboard": "dashboard/"
  },
  "errors": ${ERRORS}
}
MANIFEST_EOF
  log "Manifest written: $MANIFEST"
fi

# ── 15. Retention cleanup ───────────────────────────────────────────────────

log "--- Applying retention policy ---"
if [[ "$DRY_RUN" == false ]]; then
  # Build list of backups to KEEP
  KEEP_LIST=$(mktemp)

  # Keep last N daily backups
  ls -d "${BACKUP_ROOT}"/20??-??-?? 2>/dev/null | sort -r | head -n "$DAILY_KEEP" >> "$KEEP_LIST"

  # Keep last N weekly backups (Sundays)
  WEEKLY_COUNT=0
  for dir in $(ls -d "${BACKUP_ROOT}"/20??-??-?? 2>/dev/null | sort -r); do
    dir_date=$(basename "$dir")
    day_of_week=$(date -j -f "%Y-%m-%d" "$dir_date" "+%u" 2>/dev/null || echo "")
    if [[ "$day_of_week" == "7" ]]; then
      echo "$dir" >> "$KEEP_LIST"
      WEEKLY_COUNT=$((WEEKLY_COUNT + 1))
      [[ "$WEEKLY_COUNT" -ge "$WEEKLY_KEEP" ]] && break
    fi
  done

  # Keep last N monthly backups (1st of month)
  MONTHLY_COUNT=0
  for dir in $(ls -d "${BACKUP_ROOT}"/20??-??-01 2>/dev/null | sort -r); do
    echo "$dir" >> "$KEEP_LIST"
    MONTHLY_COUNT=$((MONTHLY_COUNT + 1))
    [[ "$MONTHLY_COUNT" -ge "$MONTHLY_KEEP" ]] && break
  done

  # Deduplicate keep list
  KEEP_UNIQUE=$(sort -u "$KEEP_LIST")

  # Remove backups not in keep list
  for dir in "${BACKUP_ROOT}"/20??-??-??; do
    if [[ -d "$dir" ]] && ! echo "$KEEP_UNIQUE" | grep -q "^${dir}$"; then
      log "Retention: removing old backup $(basename "$dir")"
      rm -rf "$dir"
    fi
  done

  rm -f "$KEEP_LIST"
else
  log "Would apply retention: keep ${DAILY_KEEP} daily, ${WEEKLY_KEEP} weekly (Sun), ${MONTHLY_KEEP} monthly (1st)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" == false ]]; then
  TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
  BACKUP_COUNT=$(ls -d "${BACKUP_ROOT}"/20??-??-?? 2>/dev/null | wc -l | tr -d ' ')
  log "=== Backup complete: ${TOTAL_SIZE} in ${BACKUP_DIR} (${BACKUP_COUNT} backups retained, ${ERRORS} errors) ==="
else
  log "=== Dry run complete (${ERRORS} potential issues) ==="
fi

exit $ERRORS
