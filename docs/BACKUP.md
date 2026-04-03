# NanoClaw Backup Strategy

Last updated: 2026-04-02

## Overview

NanoClaw runs across two machines with a mix of databases, credential stores, config files, and ephemeral state. This document inventories every critical data store, defines backup procedures for each, and provides a disaster recovery plan.

**RPO/RTO targets** (appropriate for a personal project):

| Metric | Target | Rationale |
|--------|--------|-----------|
| RPO (Recovery Point Objective) | 24 hours | Daily backups at 02:00; losing one day of data is acceptable |
| RTO (Recovery Time Objective) | 2 hours | Rebuild from backup + git clone + npm install + restore |
| Backup retention | 14 daily, 4 weekly, 3 monthly | ~3 months of history |

---

## 1. Data Inventory

### Mac Mini (dashboard.shearer.live) -- Primary Server

| Component | Location | Size | Criticality | In Git? |
|-----------|----------|------|-------------|---------|
| **PostgreSQL (nanoclaw)** | localhost:5432 | ~59 MB | CRITICAL | No |
| **SQLite messages.db** | `store/messages.db` | ~528 KB | HIGH | No (gitignored) |
| **SQLite vectors.db** | `store/vectors.db` | ~52 KB | LOW (rebuildable) | No |
| **WhatsApp auth state** | `store/auth/` (165 files) | ~700 KB | CRITICAL | No |
| **WhatsApp connection state** | `store/auth.json` | ~330 B | HIGH | No |
| **Group memory** | `groups/*/CLAUDE.md` | ~1.4 MB | CRITICAL | Partially (global/) |
| **Group working files** | `groups/whatsapp_main/*` | ~1 MB | MEDIUM | No |
| **Pipeline state files** | `store/*.json` | ~400 KB | MEDIUM | No |
| **User profile** | `store/profile.md` | ~12 KB | HIGH | No |
| **Session data** | `data/sessions/` | ~52 MB | LOW (rebuildable) | No |
| **IPC state** | `data/ipc/` | ~40 KB | LOW (ephemeral) | No |
| **.env** | `.env` | ~200 B | HIGH | No (gitignored) |
| **Nginx config** | `/opt/homebrew/etc/nginx/servers/nanoclaw.conf` | ~2 KB | HIGH | No |
| **TLS certs (Let's Encrypt)** | `~/.certbot/` | ~72 KB | HIGH (auto-renewable) | No |
| **NanoClaw certs (OneCLI CA)** | `certs/` | ~10 KB | HIGH | No (gitignored) |
| **Certbot DNS hooks** | `scripts/certbot/` | ~2 KB | MEDIUM | Yes |
| **DefenseClaw config** | `~/.defenseclaw/config.yaml` | ~500 B | HIGH | No |
| **DefenseClaw firewall** | `~/.defenseclaw/firewall.yaml` | ~2 KB | HIGH | No |
| **DefenseClaw device key** | `~/.defenseclaw/device.key` | ~1 KB | CRITICAL | No |
| **DefenseClaw audit DB** | `~/.defenseclaw/audit.db` | ~3 MB | LOW | No |
| **DefenseClaw policies** | `~/defenseclaw/policies/` | ~55 MB | MEDIUM | Yes (separate repo) |
| **LaunchAgent plists** | `~/Library/LaunchAgents/com.nanoclaw*.plist` | ~30 KB | HIGH | No |
| **Service plists** | `homebrew.mxcl.{nginx,postgresql@17}.plist` | ~5 KB | MEDIUM | No |
| **OneCLI pgdata volume** | Docker `onecli_pgdata` | varies | CRITICAL | No |
| **OneCLI app-data volume** | Docker `onecli_app-data` | varies | HIGH | No |
| **Mount allowlist** | `~/.config/nanoclaw/mount-allowlist.json` | ~100 B | MEDIUM | No |
| **Dashboard config** | `dashboard/next.config.ts` | ~1 KB | MEDIUM | Yes |

### Mac Studio (studio.shearer.live) -- Inference Server

| Component | Location | Size | Criticality | Backup Strategy |
|-----------|----------|------|-------------|----------------|
| **Ollama models (standard)** | Ollama model store | ~40 GB | LOW | Re-pullable: `gemma3:27b`, `phi4:14b`, `granite3.3:8b` |
| **FinGPT (custom model)** | Ollama model store | ~? | HIGH | NOT re-pullable from public registry; needs explicit backup |

### External Services (Not Backed Up Locally)

| Service | What's There | Recovery Strategy |
|---------|-------------|-------------------|
| **GitHub** (dadcoachengineer/nanoclaw) | All source code, branches, skill PRs | Clone from remote |
| **Notion** | Task database (sync target) | Notion has its own backup; NanoClaw can re-sync |
| **Cloudflare** | DNS records for shearer.live | Recreate manually or via API |
| **Google OAuth** | Consent grant | Re-authorize at localhost:10254/apps |
| **Webex OAuth** | Token in OneCLI | Re-authorize via OneCLI if token expires |

### OneCLI Managed Secrets

These are stored in OneCLI's Docker PostgreSQL volume. The secrets themselves are NOT on disk anywhere else.

| Secret Name | Host Pattern | Type |
|-------------|-------------|------|
| cloudflare | api.cloudflare.com | Generic (Bearer) |
| Webex | webexapis.com | Generic (Bearer) |
| Nextcloud | drive.shearer.live | Generic (Basic) |
| Plaud | api.plaud.ai | Generic (Bearer) |
| Notion | api.notion.com | Generic (Bearer) |
| nanoclaw | api.anthropic.com | Anthropic API Key |
| Demo Secret (httpbin) | httpbin.org | Generic (test) |

---

## 2. Backup Methods

### PostgreSQL (nanoclaw database -- 42 tables, ~59 MB)

**Method:** `pg_dump` with gzip compression, daily at 02:00.

```bash
pg_dump -d nanoclaw --no-owner --no-acl | gzip > nanoclaw.sql.gz
```

**What's in it:** 1787 tasks, 254 people, 3182 vector chunks, 50 meetings, 12 scheduled tasks, observability data, chat history, triage decisions, all schema migrations.

**Restore:**
```bash
dropdb nanoclaw && createdb nanoclaw
gunzip -c nanoclaw.sql.gz | psql -d nanoclaw
```

### SQLite Databases

**Method:** Direct file copy while NanoClaw is running (SQLite handles this safely via WAL mode).

| Database | Frequency | Notes |
|----------|-----------|-------|
| `messages.db` | Daily | WhatsApp message bus; ~500 KB |
| `vectors.db` | Daily | Rebuildable via `rebuild-indexes.sh` but cheap to back up |
| `nanoclaw.db` | Daily | Legacy; currently empty |
| `audit.db` | Daily | DefenseClaw audit trail |

### WhatsApp Auth State

**Location:** `store/auth/` (165 JSON files with Baileys session keys)

**Criticality:** CRITICAL. Losing this requires re-scanning the WhatsApp QR code, which re-links the device. If the auth state is corrupt, WhatsApp will disconnect and require manual intervention.

**Method:** rsync the entire `store/auth/` directory daily.

### OneCLI Secrets Vault

**Location:** Docker volume `onecli_pgdata` (PostgreSQL 17) and `onecli_app-data`.

**Method:** Export Docker volumes as tar.gz archives:
```bash
docker run --rm -v onecli_pgdata:/data -v /backup:/backup alpine \
  tar czf /backup/onecli-pgdata.tar.gz -C /data .
```

**Restore:**
```bash
docker volume rm onecli_pgdata && docker volume create onecli_pgdata
docker run --rm -v onecli_pgdata:/data -v /backup:/backup alpine \
  sh -c "cd /data && tar xzf /backup/onecli-pgdata.tar.gz"
```

**Note:** OneCLI also stores an agent token in the `com.nanoclaw.plist` environment variables. This token (`ONECLI_AGENT_TOKEN`) must match the OneCLI database for authentication to work.

### TLS Certificates

**Location:** `~/.certbot/` (Let's Encrypt certs for dashboard.shearer.live, expires 2026-06-27).

**Method:** Copy the entire `~/.certbot/` directory. Certs auto-renew via the `com.nanoclaw.certbot-renew` plist (runs daily at 03:30 using Cloudflare DNS-01 challenge through the OneCLI proxy).

**Recovery if lost:** Run `certbot certonly` with the DNS-01 auth hook -- requires OneCLI to be running for Cloudflare API access.

### DefenseClaw

**Files to back up:**
- `~/.defenseclaw/config.yaml` -- gateway + guardrail configuration
- `~/.defenseclaw/firewall.yaml` -- egress firewall rules
- `~/.defenseclaw/device.key` -- device identity key (CRITICAL, not regenerable without re-enrollment)
- `~/.defenseclaw/guardrail_runtime.json` -- runtime guardrail state
- `~/defenseclaw/policies/` -- policy definitions (also in git)

### LaunchAgent Plists

16 plists manage the entire service mesh:

| Plist | Service |
|-------|---------|
| `com.nanoclaw.plist` | Core NanoClaw process |
| `com.nanoclaw.dashboard.plist` | Next.js dashboard |
| `com.nanoclaw.boox-local.plist` | Boox notebook processor |
| `com.nanoclaw.calendar-local.plist` | Google Calendar sync |
| `com.nanoclaw.certbot-renew.plist` | TLS cert renewal |
| `com.nanoclaw.defenseclaw-anthropic.plist` | DefenseClaw Anthropic gateway |
| `com.nanoclaw.gmail-local.plist` | Gmail processor |
| `com.nanoclaw.messages-local.plist` | Webex messages processor |
| `com.nanoclaw.person-index.plist` | Person index builder |
| `com.nanoclaw.plaud-local.plist` | Plaud NotePin processor |
| `com.nanoclaw.transcripts-local.plist` | Meeting transcript processor |
| `com.nanoclaw.vector-rebuild.plist` | Vector index rebuilder |
| `com.nanoclaw.webex-refresh.plist` | Webex token refresh |
| `com.nanoclaw.webex-summaries.plist` | Webex summaries processor |
| `com.nanoclaw.backup.plist` | Daily backup (this system) |
| `homebrew.mxcl.nginx.plist` | Nginx reverse proxy |
| `homebrew.mxcl.postgresql@17.plist` | PostgreSQL 17 |

### Ollama Models (Mac Studio)

Standard models are re-pullable:
```bash
ollama pull gemma3:27b
ollama pull phi4:14b
ollama pull granite3.3:8b
```

**FinGPT is custom** and cannot be re-downloaded from a public registry. It must be exported and backed up separately:
```bash
# On Mac Studio:
ollama cp FinGPT FinGPT-backup
# Or export the model blob manually from ~/.ollama/models/
```

---

## 3. What's in Git vs What's Local-Only

### In Git (recoverable via `git clone`)
- All TypeScript source code (`src/`, `dashboard/`, `container/`, `scripts/`)
- Package manifests (`package.json`, `package-lock.json`)
- Container Dockerfile and build scripts
- Certbot hook scripts (`scripts/certbot/`)
- Documentation (`docs/`)
- Global group CLAUDE.md (`groups/global/CLAUDE.md`)
- `.gitignore`, `tsconfig.json`, etc.
- Skill definitions (`.claude/skills/`)

### Local-Only (MUST be backed up)
- PostgreSQL database (all runtime data)
- SQLite databases (`store/`)
- WhatsApp auth state (`store/auth/`)
- `.env` (environment config)
- `store/profile.md` (user profile)
- All `store/*.json` pipeline state files
- `data/` (sessions, IPC state)
- `groups/main/`, `groups/whatsapp_main/` (group memory and working files)
- `certs/` (OneCLI CA cert, NanoClaw TLS keypair)
- `~/.defenseclaw/` (config, keys, audit DB)
- `~/.certbot/` (Let's Encrypt certs)
- `~/.config/nanoclaw/` (mount allowlist)
- `~/Library/LaunchAgents/com.nanoclaw*.plist` (service configs)
- Docker volumes (`onecli_pgdata`, `onecli_app-data`)
- Nginx server config

---

## 4. Backup Automation

### Scripts

| Script | Purpose |
|--------|---------|
| `scripts/backup/backup.sh` | Full daily backup of all components |
| `scripts/backup/verify.sh` | Validate a backup has all expected components |
| `scripts/backup/restore.sh` | Selective or full restore from a backup |

### Schedule

Automated via `com.nanoclaw.backup.plist`:
- **Runs daily at 02:00** (before certbot renewal at 03:30)
- Logs to `logs/backup.log`
- Retention: 14 daily + 4 weekly (Sundays) + 3 monthly (1st of month)

### Backup Destination

**Primary:** `/Users/nanoclaw/backups/nanoclaw/YYYY-MM-DD/`

Each daily backup contains:
```
2026-04-02/
  manifest.json              # backup metadata and error count
  postgresql/
    nanoclaw.sql.gz           # full PostgreSQL dump (~5 MB compressed)
  sqlite/
    messages.db               # WhatsApp message bus
    vectors.db                # vector search index
    nanoclaw.db               # legacy DB
    defenseclaw-audit.db      # DefenseClaw audit trail
  whatsapp-auth/              # 165 Baileys session files
  groups/                     # all group CLAUDE.md + state
  store-state/                # pipeline JSON state + profile.md
  data/                       # sessions and IPC data
  config/
    nanoclaw.env              # .env
    mount-allowlist.json      # container mount security
    nginx-nanoclaw.conf       # nginx config
  defenseclaw/
    config.yaml
    firewall.yaml
    device.key
    guardrail_runtime.json
    policies/                 # policy definitions
  certbot/                    # full ~/.certbot tree
  certs/                      # OneCLI CA, NanoClaw TLS certs
  certbot-hooks/              # DNS auth/cleanup scripts
  launchagents/               # all plist files
  onecli/
    onecli-pgdata.tar.gz      # OneCLI PostgreSQL data
    onecli-appdata.tar.gz     # OneCLI app data
    secrets-inventory.json    # secrets list (metadata, not values)
  dashboard/
    next.config.ts            # dashboard config
```

### Offsite Storage

**Current:** Local disk only (`/Users/nanoclaw/backups/`).

**Recommended additions** (not yet implemented, requires user confirmation):
1. **Nextcloud (drive.shearer.live)** -- rsync daily backup to Nextcloud WebDAV. Already have credentials in OneCLI. Estimated ~70 MB/day compressed.
2. **Mac Studio** -- rsync to `studio.shearer.live` via SSH. Uses the same LAN, provides geographic separation within the home network.
3. **GitHub** -- NOT suitable for database dumps or secrets. Only source code belongs here.

---

## 5. Disaster Recovery Plan

### Scenario A: Data corruption (single component)

1. Identify the corrupted component
2. Run `scripts/backup/verify.sh` on the latest backup
3. Restore the specific component:
   ```bash
   # Example: restore just PostgreSQL
   scripts/backup/restore.sh 2026-04-02 --pg

   # Example: restore just WhatsApp auth
   scripts/backup/restore.sh 2026-04-02 --whatsapp
   ```
4. Restart NanoClaw: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Estimated time:** 5-10 minutes

### Scenario B: Full Mac Mini rebuild (hardware failure or OS reinstall)

**Prerequisites:**
- Fresh macOS install on Mac Mini
- Homebrew installed
- Access to the latest backup (external drive, Nextcloud, or Mac Studio)
- GitHub access for source code

**Step-by-step:**

1. **Install system dependencies:**
   ```bash
   brew install node@22 postgresql@17 nginx certbot docker
   brew services start postgresql@17
   ```

2. **Create the nanoclaw user and directories:**
   ```bash
   # If not using the same user account, create it
   mkdir -p ~/nanoclaw ~/backups ~/.defenseclaw ~/.certbot ~/.config/nanoclaw
   ```

3. **Clone the repository:**
   ```bash
   cd ~
   git clone git@github.com:dadcoachengineer/nanoclaw.git
   cd nanoclaw
   npm install
   npm run build
   ```

4. **Restore from backup:**
   ```bash
   # Copy the backup to the machine first, then:
   scripts/backup/restore.sh YYYY-MM-DD --all
   ```
   This restores: PostgreSQL, SQLite DBs, WhatsApp auth, groups, configs, DefenseClaw, certs, plists, OneCLI volumes.

5. **Start OneCLI (Docker):**
   ```bash
   # OneCLI volumes are restored. Start the containers:
   docker compose up -d  # from the OneCLI project directory
   ```

6. **Restore environment variables:**
   The `.env` is restored by `--config`. The plist files contain `ONECLI_AGENT_TOKEN` and `DATABASE_URL`. Verify they match the restored OneCLI database.

7. **Build the agent container:**
   ```bash
   ./container/build.sh
   ```

8. **Restore TLS certs and nginx:**
   The `--certbot` and `--config` flags restore `~/.certbot/` and `nanoclaw.conf`. Then:
   ```bash
   brew services restart nginx
   ```

9. **Load all LaunchAgent plists:**
   ```bash
   for plist in ~/Library/LaunchAgents/com.nanoclaw*.plist; do
     launchctl load "$plist"
   done
   launchctl load ~/Library/LaunchAgents/homebrew.mxcl.nginx.plist
   launchctl load ~/Library/LaunchAgents/homebrew.mxcl.postgresql@17.plist
   ```

10. **Verify:**
    ```bash
    # Check NanoClaw is running
    curl -s https://dashboard.shearer.live | head -5

    # Check PostgreSQL
    psql -d nanoclaw -c "SELECT count(*) FROM tasks;"

    # Check WhatsApp connection
    tail -20 logs/nanoclaw.log
    ```

**Estimated time:** 1-2 hours

### Scenario C: OneCLI secret loss

If OneCLI's Docker volumes are lost but the backup exists:

1. Stop OneCLI containers
2. Restore volumes from backup: `scripts/backup/restore.sh YYYY-MM-DD --onecli`
3. Restart OneCLI containers
4. Verify: `onecli secrets list`

If backup is also lost, each secret must be manually re-created:
- Anthropic API key: from Anthropic console
- Notion: from Notion integrations page
- Webex: re-authorize OAuth flow
- Plaud: from Plaud account settings
- Nextcloud: generate new app password
- Cloudflare: from Cloudflare dashboard

### Scenario D: WhatsApp disconnection

WhatsApp auth state corruption is common. To recover:

1. Restore auth from backup: `scripts/backup/restore.sh YYYY-MM-DD --whatsapp`
2. Restart NanoClaw
3. If auth is too stale (>14 days), re-scan QR code via the setup flow

### Scenario E: Mac Studio (inference server) failure

The Mac Studio only runs Ollama. Recovery:

1. Install Ollama on replacement hardware
2. Re-pull standard models: `ollama pull gemma3:27b phi4:14b granite3.3:8b`
3. Restore FinGPT from backup (if backed up) or re-create from source
4. Update `OLLAMA_BASE_URL` in `.env` if IP changes

---

## 6. What Is NOT Backed Up (Intentionally)

| Item | Reason |
|------|--------|
| `node_modules/` | Rebuilt by `npm install` |
| `dist/` | Rebuilt by `npm run build` |
| `logs/` | Ephemeral; not needed for recovery |
| Docker images | Rebuilt by `./container/build.sh` or pulled from registry |
| Notion data | Notion is the source of truth; NanoClaw syncs TO it |
| Ollama standard models | Re-pullable from registry |
| `store/qr-auth.html` | One-time QR code page; not needed |

---

## 7. Monitoring and Alerting

**Current:** Check `logs/backup.log` for errors.

**Recommended additions:**
- Add a scheduled task in NanoClaw to verify the backup each morning and send a WhatsApp message if verification fails
- Monitor backup directory size growth

---

## 8. Testing Schedule

| Frequency | Test |
|-----------|------|
| Daily (automated) | `backup.sh` runs and `manifest.json` shows 0 errors |
| Weekly (manual) | Run `verify.sh` and spot-check a random component |
| Monthly | Test restore of PostgreSQL to a temporary database |
| Quarterly | Full DR test: restore everything to a temp directory, verify all configs parse |
