# PostgreSQL Migration Plan

## Overview
Migrate from Notion + SQLite + 14 JSON files to PostgreSQL + pgvector as single system of record.

## Phases
- **Phase 0**: Foundation — install PG, create schema, add config (today)
- **Phase 1**: Dual-write for messages.db
- **Phase 2**: Migrate JSON stores (team, people, topics, initiatives, etc.)
- **Phase 3**: Migrate vectors to pgvector
- **Phase 4**: Migrate archive to PG
- **Phase 5**: Tasks become local-first (Notion becomes sync target)
- **Phase 6**: Switchover reads from SQLite to PG
- **Phase 7**: Cleanup

## Key Principles
- Never lose data — backfill scripts are idempotent
- Keep platform functional throughout — DATA_BACKEND flag controls routing
- Reversible at each phase
- JSON/SQLite files remain on disk as backup

See the full schema and implementation details in this file.
