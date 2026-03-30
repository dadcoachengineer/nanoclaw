-- NanoClaw Mission Control — PostgreSQL Schema
-- Phase 0: Initial schema creation
-- Run: psql nanoclaw -f migrations/001_initial_schema.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- PEOPLE
-- =====================================================

CREATE TABLE IF NOT EXISTS people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    company TEXT,
    job_title TEXT,
    avatar TEXT,
    linkedin_url TEXT,
    linkedin_headline TEXT,
    profile_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS person_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    is_primary BOOLEAN DEFAULT false,
    UNIQUE(person_id, email)
);
CREATE INDEX IF NOT EXISTS idx_person_emails_email ON person_emails(email);

CREATE TABLE IF NOT EXISTS person_webex_rooms (
    person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    room_type TEXT NOT NULL DEFAULT 'direct',
    PRIMARY KEY (person_id, room_id)
);

-- =====================================================
-- MEETINGS
-- =====================================================

CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    host_name TEXT,
    host_email TEXT,
    source TEXT NOT NULL DEFAULT 'webex',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting_participants (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'attendee',
    PRIMARY KEY (meeting_id, person_id)
);

-- =====================================================
-- TRANSCRIPT MENTIONS & MESSAGE EXCERPTS
-- =====================================================

CREATE TABLE IF NOT EXISTS transcript_mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    snippet_count INTEGER NOT NULL DEFAULT 0,
    snippets TEXT[],
    UNIQUE(person_id, meeting_id)
);

CREATE TABLE IF NOT EXISTS message_excerpts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    room_title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_excerpts_person ON message_excerpts(person_id, date DESC);

-- =====================================================
-- TASKS (system of record — replaces Notion)
-- =====================================================

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    priority TEXT,
    status TEXT NOT NULL DEFAULT 'Not started',
    source TEXT,
    project TEXT,
    context TEXT,
    zone TEXT DEFAULT 'Open',
    delegated_to TEXT,
    energy TEXT,
    due_date DATE,
    notes TEXT,
    notion_page_id TEXT,
    notion_synced_at TIMESTAMPTZ,
    notion_sync_status TEXT DEFAULT 'pending',
    triage_status TEXT DEFAULT 'inbox',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_triage ON tasks(triage_status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_delegated ON tasks(delegated_to);

CREATE TABLE IF NOT EXISTS task_people (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL DEFAULT 'mentioned',
    PRIMARY KEY (task_id, person_id, relationship)
);

CREATE TABLE IF NOT EXISTS task_corroborations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    original_title TEXT NOT NULL,
    corroborated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- AI SUMMARIES
-- =====================================================

CREATE TABLE IF NOT EXISTS ai_summaries (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    host TEXT,
    summary TEXT NOT NULL,
    action_items TEXT[] NOT NULL DEFAULT '{}',
    notion_task_ids TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- TOPICS
-- =====================================================

CREATE TABLE IF NOT EXISTS topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topic_meetings (
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    PRIMARY KEY (topic_id, meeting_id)
);

CREATE TABLE IF NOT EXISTS topic_people (
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (topic_id, person_id)
);

CREATE TABLE IF NOT EXISTS topic_tasks (
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (topic_id, task_id)
);

-- =====================================================
-- INITIATIVES
-- =====================================================

CREATE TABLE IF NOT EXISTS initiatives (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    owner TEXT NOT NULL DEFAULT 'Jason',
    notion_project TEXT,
    keywords TEXT[] NOT NULL DEFAULT '{}',
    created_at DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS initiative_pinned_tasks (
    initiative_slug TEXT NOT NULL REFERENCES initiatives(slug) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    pinned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (initiative_slug, task_id)
);

CREATE TABLE IF NOT EXISTS initiative_pinned_people (
    initiative_slug TEXT NOT NULL REFERENCES initiatives(slug) ON DELETE CASCADE,
    person_name TEXT NOT NULL,
    PRIMARY KEY (initiative_slug, person_name)
);

-- =====================================================
-- TEAM
-- =====================================================

CREATE TABLE IF NOT EXISTS team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID REFERENCES people(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- TRIAGE DECISIONS (RLHF log)
-- =====================================================

CREATE TABLE IF NOT EXISTS triage_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source TEXT,
    project TEXT,
    action TEXT NOT NULL,
    priority TEXT,
    delegated_to TEXT,
    merged_into UUID REFERENCES tasks(id),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_triage_decisions_task ON triage_decisions(task_id);

-- =====================================================
-- CHAT / MESSAGING (from messages.db)
-- =====================================================

CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    last_message_time TIMESTAMPTZ,
    channel TEXT,
    is_group BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT NOT NULL,
    chat_jid TEXT NOT NULL REFERENCES chats(jid) ON DELETE CASCADE,
    sender TEXT,
    sender_name TEXT,
    content TEXT,
    timestamp TIMESTAMPTZ NOT NULL,
    is_from_me BOOLEAN DEFAULT false,
    is_bot_message BOOLEAN DEFAULT false,
    PRIMARY KEY (id, chat_jid)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_ts ON chat_messages(timestamp);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    group_folder TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_type TEXT NOT NULL,
    schedule_value TEXT NOT NULL,
    context_mode TEXT DEFAULT 'isolated',
    model TEXT,
    next_run TIMESTAMPTZ,
    last_run TIMESTAMPTZ,
    last_result TEXT,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS task_run_logs (
    id SERIAL PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    run_at TIMESTAMPTZ NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_run_logs_task ON task_run_logs(task_id, run_at);

CREATE TABLE IF NOT EXISTS registered_groups (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT UNIQUE NOT NULL,
    trigger_pattern TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL,
    container_config JSONB,
    requires_trigger BOOLEAN DEFAULT true,
    is_main BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS router_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    group_folder TEXT PRIMARY KEY,
    session_id TEXT NOT NULL
);

-- =====================================================
-- VECTORS (pgvector)
-- =====================================================

CREATE TABLE IF NOT EXISTS vector_chunks (
    id SERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    embedding vector(768),
    embedded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vector_chunks_source ON vector_chunks(source);

-- =====================================================
-- ARTIFACTS
-- =====================================================

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    intent TEXT NOT NULL DEFAULT 'research',
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    task_title TEXT,
    project TEXT,
    sources TEXT[] DEFAULT '{}',
    mentioned_people TEXT[] DEFAULT '{}',
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

-- =====================================================
-- ARCHIVE (original source content)
-- =====================================================

CREATE TABLE IF NOT EXISTS archive_items (
    id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    title TEXT,
    date TIMESTAMPTZ,
    content TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, source_type)
);
CREATE INDEX IF NOT EXISTS idx_archive_source ON archive_items(source_type, date DESC);

-- =====================================================
-- SMALL LOOKUP TABLES
-- =====================================================

CREATE TABLE IF NOT EXISTS corrections (
    wrong TEXT PRIMARY KEY,
    correct TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relevance_scores (
    key TEXT PRIMARY KEY,
    score INTEGER NOT NULL DEFAULT 0,
    last_vote TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_state (
    pipeline TEXT PRIMARY KEY,
    last_check TIMESTAMPTZ,
    state JSONB NOT NULL DEFAULT '{}',
    metrics JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    location TEXT,
    description TEXT,
    calendar TEXT,
    attendees JSONB,
    source TEXT NOT NULL DEFAULT 'google',
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- NOTION SYNC LOG
-- =====================================================

CREATE TABLE IF NOT EXISTS notion_sync_log (
    id SERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- MIGRATION TRACKING
-- =====================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('001_initial_schema')
ON CONFLICT DO NOTHING;
