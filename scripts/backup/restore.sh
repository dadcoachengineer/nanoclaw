#!/usr/bin/env bash
# NanoClaw Restore Script
#
# Restores specific components from a backup. By default, lists available
# backups and components. Use flags to restore specific parts.
#
# Usage:
#   ./scripts/backup/restore.sh                          # list backups
#   ./scripts/backup/restore.sh 2026-04-02 --list        # list components in backup
#   ./scripts/backup/restore.sh 2026-04-02 --pg          # restore PostgreSQL
#   ./scripts/backup/restore.sh 2026-04-02 --sqlite      # restore SQLite DBs
#   ./scripts/backup/restore.sh 2026-04-02 --whatsapp    # restore WhatsApp auth
#   ./scripts/backup/restore.sh 2026-04-02 --groups      # restore group memory
#   ./scripts/backup/restore.sh 2026-04-02 --config      # restore config files
#   ./scripts/backup/restore.sh 2026-04-02 --defenseclaw # restore DefenseClaw
#   ./scripts/backup/restore.sh 2026-04-02 --certbot     # restore TLS certs
#   ./scripts/backup/restore.sh 2026-04-02 --plists      # restore LaunchAgent plists
#   ./scripts/backup/restore.sh 2026-04-02 --onecli      # restore OneCLI volumes
#   ./scripts/backup/restore.sh 2026-04-02 --all         # restore everything (DANGEROUS)
#
# IMPORTANT: This script will STOP NanoClaw before restoring and restart after.
# Always verify the backup first with verify.sh.

set -euo pipefail

BACKUP_ROOT="/Users/nanoclaw/backups/nanoclaw"
NANOCLAW_DIR="/Users/nanoclaw/nanoclaw"
HOME_DIR="/Users/nanoclaw"

# No arguments — list backups
if [[ $# -eq 0 ]]; then
  echo "Available backups:"
  echo ""
  for dir in $(ls -d "${BACKUP_ROOT}"/20??-??-?? 2>/dev/null | sort -r); do
    date=$(basename "$dir")
    size=$(du -sh "$dir" 2>/dev/null | cut -f1)
    errors="OK"
    if [[ -f "${dir}/manifest.json" ]]; then
      err_count=$(python3 -c "import json; print(json.load(open('${dir}/manifest.json'))['errors'])" 2>/dev/null || echo "?")
      [[ "$err_count" != "0" ]] && errors="${err_count} errors"
    fi
    echo "  ${date}  ${size}  ${errors}"
  done
  echo ""
  echo "Usage: $0 <date> <--component>"
  exit 0
fi

DATE="$1"
shift
BACKUP_DIR="${BACKUP_ROOT}/${DATE}"

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "ERROR: No backup found for ${DATE}"
  exit 1
fi

if [[ "${1:-}" == "--list" ]]; then
  echo "Components in ${DATE} backup:"
  echo ""
  for item in "${BACKUP_DIR}"/*/; do
    if [[ -d "$item" ]]; then
      name=$(basename "$item")
      size=$(du -sh "$item" 2>/dev/null | cut -f1)
      echo "  ${name}/  ${size}"
    fi
  done
  for item in "${BACKUP_DIR}"/*.json; do
    if [[ -f "$item" ]]; then
      echo "  $(basename "$item")"
    fi
  done
  exit 0
fi

# Confirm before restoring
echo "WARNING: Restoring from backup ${DATE}"
echo "This will overwrite current data. NanoClaw will be stopped during restore."
echo ""
read -p "Continue? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

stop_nanoclaw() {
  echo "Stopping NanoClaw..."
  launchctl bootout gui/$(id -u)/com.nanoclaw 2>/dev/null || true
  sleep 2
}

start_nanoclaw() {
  echo "Starting NanoClaw..."
  launchctl bootstrap gui/$(id -u) "${HOME_DIR}/Library/LaunchAgents/com.nanoclaw.plist" 2>/dev/null || \
    launchctl load "${HOME_DIR}/Library/LaunchAgents/com.nanoclaw.plist" 2>/dev/null || true
}

RESTORE_ALL=false
[[ "${1:-}" == "--all" ]] && RESTORE_ALL=true

restore_pg() {
  echo "--- Restoring PostgreSQL ---"
  local dump="${BACKUP_DIR}/postgresql/nanoclaw.sql.gz"
  if [[ ! -f "$dump" ]]; then
    echo "ERROR: PostgreSQL dump not found"
    return 1
  fi

  echo "Dropping and recreating nanoclaw database..."
  dropdb nanoclaw 2>/dev/null || true
  createdb nanoclaw
  echo "Restoring from dump..."
  gunzip -c "$dump" | psql -d nanoclaw -q 2>/dev/null
  echo "PostgreSQL restored."
}

restore_sqlite() {
  echo "--- Restoring SQLite databases ---"
  for db in messages.db vectors.db nanoclaw.db; do
    local src="${BACKUP_DIR}/sqlite/${db}"
    local dest="${NANOCLAW_DIR}/store/${db}"
    if [[ -f "$src" ]]; then
      cp -p "$src" "$dest"
      echo "Restored ${db}"
    fi
  done

  local dc_src="${BACKUP_DIR}/sqlite/defenseclaw-audit.db"
  if [[ -f "$dc_src" ]]; then
    cp -p "$dc_src" "${HOME_DIR}/.defenseclaw/audit.db"
    echo "Restored DefenseClaw audit.db"
  fi
}

restore_whatsapp() {
  echo "--- Restoring WhatsApp auth ---"
  if [[ -d "${BACKUP_DIR}/whatsapp-auth" ]]; then
    rsync -a --delete "${BACKUP_DIR}/whatsapp-auth/" "${NANOCLAW_DIR}/store/auth/"
    echo "WhatsApp auth restored."
  else
    echo "ERROR: WhatsApp auth backup not found"
  fi
}

restore_groups() {
  echo "--- Restoring group memory ---"
  if [[ -d "${BACKUP_DIR}/groups" ]]; then
    rsync -a --delete "${BACKUP_DIR}/groups/" "${NANOCLAW_DIR}/groups/"
    echo "Groups restored."
  else
    echo "ERROR: Groups backup not found"
  fi
}

restore_config() {
  echo "--- Restoring config files ---"
  local cfg="${BACKUP_DIR}/config"
  [[ -f "${cfg}/nanoclaw.env" ]] && cp -p "${cfg}/nanoclaw.env" "${NANOCLAW_DIR}/.env"
  [[ -f "${cfg}/mount-allowlist.json" ]] && cp -p "${cfg}/mount-allowlist.json" "${HOME_DIR}/.config/nanoclaw/mount-allowlist.json"
  [[ -f "${cfg}/nginx-nanoclaw.conf" ]] && cp -p "${cfg}/nginx-nanoclaw.conf" /opt/homebrew/etc/nginx/servers/nanoclaw.conf
  echo "Config restored. Run 'brew services restart nginx' to reload nginx."
}

restore_defenseclaw() {
  echo "--- Restoring DefenseClaw ---"
  local dc="${BACKUP_DIR}/defenseclaw"
  [[ -f "${dc}/config.yaml" ]] && cp -p "${dc}/config.yaml" "${HOME_DIR}/.defenseclaw/config.yaml"
  [[ -f "${dc}/firewall.yaml" ]] && cp -p "${dc}/firewall.yaml" "${HOME_DIR}/.defenseclaw/firewall.yaml"
  [[ -f "${dc}/device.key" ]] && cp -p "${dc}/device.key" "${HOME_DIR}/.defenseclaw/device.key"
  [[ -f "${dc}/guardrail_runtime.json" ]] && cp -p "${dc}/guardrail_runtime.json" "${HOME_DIR}/.defenseclaw/guardrail_runtime.json"
  if [[ -d "${dc}/policies" ]]; then
    rsync -a --delete "${dc}/policies/" "${HOME_DIR}/defenseclaw/policies/"
  fi
  echo "DefenseClaw restored."
}

restore_certbot() {
  echo "--- Restoring Certbot/TLS certs ---"
  if [[ -d "${BACKUP_DIR}/certbot" ]]; then
    rsync -a --delete "${BACKUP_DIR}/certbot/" "${HOME_DIR}/.certbot/"
    echo "Certbot restored."
  fi
  if [[ -d "${BACKUP_DIR}/certs" ]]; then
    rsync -a --delete "${BACKUP_DIR}/certs/" "${NANOCLAW_DIR}/certs/"
    echo "NanoClaw certs restored."
  fi
}

restore_plists() {
  echo "--- Restoring LaunchAgent plists ---"
  if [[ -d "${BACKUP_DIR}/launchagents" ]]; then
    for plist in "${BACKUP_DIR}"/launchagents/*.plist; do
      if [[ -f "$plist" ]]; then
        cp -p "$plist" "${HOME_DIR}/Library/LaunchAgents/$(basename "$plist")"
        echo "Restored $(basename "$plist")"
      fi
    done
  fi
}

restore_onecli() {
  echo "--- Restoring OneCLI Docker volumes ---"
  echo "WARNING: This will stop OneCLI containers and replace volume data."
  read -p "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Skipped OneCLI restore."
    return
  fi

  # Stop OneCLI
  local compose_dir
  compose_dir=$(docker inspect onecli-app-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || echo "")
  if [[ -n "$compose_dir" ]]; then
    docker compose -f "${compose_dir}/docker-compose.yml" down 2>/dev/null || true
  else
    docker stop onecli-app-1 onecli-postgres-1 2>/dev/null || true
  fi

  # Restore pgdata
  if [[ -f "${BACKUP_DIR}/onecli/onecli-pgdata.tar.gz" ]]; then
    docker volume rm onecli_pgdata 2>/dev/null || true
    docker volume create onecli_pgdata
    docker run --rm -v onecli_pgdata:/data -v "${BACKUP_DIR}/onecli:/backup" alpine \
      sh -c "cd /data && tar xzf /backup/onecli-pgdata.tar.gz"
    echo "OneCLI pgdata restored."
  fi

  # Restore app-data
  if [[ -f "${BACKUP_DIR}/onecli/onecli-appdata.tar.gz" ]]; then
    docker volume rm onecli_app-data 2>/dev/null || true
    docker volume create onecli_app-data
    docker run --rm -v onecli_app-data:/data -v "${BACKUP_DIR}/onecli:/backup" alpine \
      sh -c "cd /data && tar xzf /backup/onecli-appdata.tar.gz"
    echo "OneCLI app-data restored."
  fi

  # Restart OneCLI
  if [[ -n "$compose_dir" ]]; then
    docker compose -f "${compose_dir}/docker-compose.yml" up -d 2>/dev/null || true
  fi
  echo "OneCLI restored and restarted."
}

# Execute requested restores
NEED_STOP=false

for arg in "$@"; do
  case "$arg" in
    --pg|--sqlite|--whatsapp|--groups|--all)
      NEED_STOP=true
      ;;
  esac
done

if [[ "$NEED_STOP" == true ]]; then
  stop_nanoclaw
fi

for arg in "$@"; do
  case "$arg" in
    --pg)          restore_pg ;;
    --sqlite)      restore_sqlite ;;
    --whatsapp)    restore_whatsapp ;;
    --groups)      restore_groups ;;
    --config)      restore_config ;;
    --defenseclaw) restore_defenseclaw ;;
    --certbot)     restore_certbot ;;
    --plists)      restore_plists ;;
    --onecli)      restore_onecli ;;
    --all)
      restore_pg
      restore_sqlite
      restore_whatsapp
      restore_groups
      restore_config
      restore_defenseclaw
      restore_certbot
      restore_plists
      restore_onecli
      ;;
    *)
      echo "Unknown option: $arg"
      exit 1
      ;;
  esac
done

if [[ "$NEED_STOP" == true ]]; then
  start_nanoclaw
fi

echo ""
echo "=== Restore complete ==="
