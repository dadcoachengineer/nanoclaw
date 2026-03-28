"use client";

import { useEffect, useState, useRef } from "react";
import { Card, CardHeader, StatCard } from "@/components/Card";
import { timeAgo } from "@/lib/dates";
import VoteButtons from "@/components/VoteButtons";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface InitiativeSummary {
  slug: string;
  name: string;
  description: string;
  status: "active" | "paused" | "complete";
  taskCount: number;
  peopleCount: number;
  meetingCount: number;
}

interface ActivityItem {
  type: "task" | "meeting" | "summary" | "message";
  date: string;
  title: string;
  detail?: string;
  id?: string;
}

interface InitiativeTask {
  id: string;
  title: string;
  priority?: string;
  status: string;
  source?: string;
  pinned?: boolean;
}

interface InitiativePerson {
  name: string;
  email?: string | null;
  avatar?: string | null;
  meetingCount: number;
  pinned?: boolean;
}

interface InitiativeMeeting {
  title: string;
  date: string;
  hasSummary?: boolean;
  pinned?: boolean;
}

interface InitiativeDetail {
  slug: string;
  name: string;
  description: string;
  status: "active" | "paused" | "complete";
  keywords: string[];
  owner?: string;
  activity: ActivityItem[];
  tasks: InitiativeTask[];
  people: InitiativePerson[];
  meetings: InitiativeMeeting[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  active:   { bg: "rgba(63,185,80,0.15)",  text: "var(--green)",    label: "Active" },
  paused:   { bg: "rgba(210,153,34,0.15)", text: "var(--yellow)",   label: "Paused" },
  complete: { bg: "rgba(139,148,158,0.15)", text: "var(--text-dim)", label: "Complete" },
};

const ACTIVITY_STYLES: Record<string, { color: string; icon: string }> = {
  task:    { color: "var(--yellow)", icon: "T" },
  meeting: { color: "var(--accent)", icon: "M" },
  summary: { color: "var(--green)",  icon: "S" },
  message: { color: "var(--purple)", icon: "C" },
};

const STATUS_CYCLE: Array<"active" | "paused" | "complete"> = ["active", "paused", "complete"];

function Avatar({ name, avatar, size = "sm" }: { name: string; avatar?: string | null; size?: "sm" | "lg" }) {
  const initials = name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
  const cls = size === "lg" ? "w-12 h-12 text-lg" : "w-8 h-8 text-xs";

  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name}
        className={`${cls} rounded-full object-cover shrink-0`}
      />
    );
  }

  return (
    <div className={`${cls} rounded-full bg-[var(--surface2)] border border-[var(--border)] flex items-center justify-center font-medium text-[var(--accent)] shrink-0`}>
      {initials}
    </div>
  );
}

function StatusBadge({
  status,
  onClick,
}: {
  status: "active" | "paused" | "complete";
  onClick?: () => void;
}) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.active;
  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${onClick ? "cursor-pointer transition-opacity hover:opacity-80" : ""}`}
      style={{ background: s.bg, color: s.text }}
      onClick={onClick}
    >
      {s.label}
    </span>
  );
}

function priorityBadgeCls(priority?: string): string {
  const base = "text-xs px-2 py-0.5 rounded-full shrink-0";
  if (!priority) return `${base} bg-[rgba(139,148,158,0.15)] text-[var(--text-dim)]`;
  if (priority.includes("P0")) return `${base} bg-[rgba(248,81,73,0.15)] text-[var(--red)]`;
  if (priority.includes("P1")) return `${base} bg-[rgba(219,109,40,0.15)] text-[var(--orange)]`;
  if (priority.includes("P2")) return `${base} bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]`;
  return `${base} bg-[rgba(139,148,158,0.15)] text-[var(--text-dim)]`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ */
/*  New Initiative Modal                                                */
/* ------------------------------------------------------------------ */

function NewInitiativeModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const [error, setError] = useState("");

  async function handleCreate() {
    if (!name.trim()) return;
    const kw = keywords.split(",").map((k) => k.trim()).filter(Boolean);
    if (kw.length === 0) { setError("Add at least one keyword"); return; }
    setSaving(true);
    setError("");
    try {
      const resp = await fetch("/api/initiatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || name.trim(),
          keywords: kw,
        }),
      });
      if (resp.ok) {
        onCreated();
        onClose();
      } else {
        const data = await resp.json();
        setError(data.error || "Failed to create");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.6)]">
      <div ref={ref} className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--text-bright)]">New Initiative</h2>
          <button
            onClick={onClose}
            className="text-[var(--text-dim)] hover:text-[var(--text)] text-lg leading-none"
          >
            x
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Initiative name"
              className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description"
              rows={3}
              className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)] resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Keywords</label>
            <input
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="Comma-separated tags"
              className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
          {error && <div className="text-xs text-[var(--red)]">{error}</div>}
          <button
            onClick={handleCreate}
            disabled={saving || !name.trim()}
            className="w-full py-2 rounded-md text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? "Creating..." : "Create Initiative"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main View                                                          */
/* ------------------------------------------------------------------ */

export default function InitiativesView() {
  const [initiatives, setInitiatives] = useState<InitiativeSummary[]>([]);
  const [selected, setSelected] = useState<InitiativeDetail | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [scores, setScores] = useState<Record<string, number>>({});

  const voteContext = selectedSlug ? `initiative:${selectedSlug}` : "";
  const updateScore = (itemType: string, itemId: string, s: number) =>
    setScores((prev) => ({ ...prev, [`${itemType}:${itemId}`]: s }));
  const getScore = (itemType: string, itemId: string) => scores[`${itemType}:${itemId}`] ?? 0;
  const isSuppressed = (itemType: string, itemId: string) => getScore(itemType, itemId) <= -2;

  function loadInitiatives() {
    fetch("/api/initiatives")
      .then((r) => r.json())
      .then((data) => {
        setInitiatives(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    loadInitiatives();
  }, []);

  async function selectInitiative(slug: string) {
    setSelectedSlug(slug);
    const [resp, scoresResp] = await Promise.all([
      fetch(`/api/initiatives?slug=${encodeURIComponent(slug)}`),
      fetch(`/api/relevance?context=${encodeURIComponent(`initiative:${slug}`)}`).then(
        (r) => (r.ok ? r.json() : { scores: {} })
      ),
    ]);
    const data = await resp.json();
    setSelected(data);
    setScores(scoresResp.scores || {});
  }

  async function cycleStatus() {
    if (!selected) return;
    const idx = STATUS_CYCLE.indexOf(selected.status);
    const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
    setSelected({ ...selected, status: next });
    // Optimistic — fire and forget
    fetch("/api/initiatives", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: selectedSlug, status: next }),
    });
  }

  const filtered = filter
    ? initiatives.filter(
        (p) =>
          p.name.toLowerCase().includes(filter.toLowerCase()) ||
          p.description.toLowerCase().includes(filter.toLowerCase())
      )
    : initiatives;

  const activeCount = initiatives.filter((p) => p.status === "active").length;
  const totalTasks = initiatives.reduce((s, p) => s + p.taskCount, 0);
  const totalPeople = initiatives.reduce((s, p) => s + p.peopleCount, 0);

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard value={activeCount} label="Active Initiatives" color="var(--green)" />
        <StatCard value={totalTasks} label="Total Tasks" color="var(--yellow)" />
        <StatCard value={totalPeople} label="Total People" color="var(--accent)" />
      </div>

      <div className="grid grid-cols-[320px_1fr] gap-6">
        {/* Left: Initiative list */}
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Initiatives"
              right={
                <input
                  type="text"
                  placeholder="Filter..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="w-40 bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-xs text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)]"
                />
              }
            />
            <div className="max-h-[70vh] overflow-y-auto">
              {loading && (
                <div className="p-6 text-center text-[var(--text-dim)]">Loading...</div>
              )}
              {filtered.map((p) => (
                <div
                  key={p.slug}
                  className={`px-4 py-3 border-b border-[var(--border)] cursor-pointer hover:bg-[rgba(88,166,255,0.03)] ${
                    selectedSlug === p.slug ? "bg-[rgba(88,166,255,0.06)]" : ""
                  }`}
                  onClick={() => selectInitiative(p.slug)}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-[var(--text-bright)] truncate flex-1">
                      {p.name}
                    </span>
                    <StatusBadge status={p.status} />
                  </div>
                  {p.description && (
                    <div className="text-xs text-[var(--text-dim)] truncate mb-1.5">
                      {p.description}
                    </div>
                  )}
                  <div className="flex gap-3 text-xs text-[var(--text-dim)]">
                    {p.taskCount > 0 && <span>{p.taskCount} tasks</span>}
                    {p.peopleCount > 0 && <span>{p.peopleCount} people</span>}
                    {p.meetingCount > 0 && <span>{p.meetingCount} mtg</span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <button
            onClick={() => setShowModal(true)}
            className="w-full py-2 rounded-lg border border-dashed border-[var(--border)] text-sm text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
          >
            + New Initiative
          </button>
        </div>

        {/* Right: Initiative detail */}
        <div className="space-y-6">
          {!selected && (
            <Card>
              <div className="p-8 text-center text-[var(--text-dim)] italic">
                Select an initiative to see its full context
              </div>
            </Card>
          )}

          {selected && (
            <>
              {/* Header card */}
              <Card>
                <div className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="text-base font-semibold text-[var(--text-bright)]">
                        {selected.name}
                      </div>
                      {selected.description && (
                        <div className="text-sm text-[var(--text)] mt-1">
                          {selected.description}
                        </div>
                      )}
                    </div>
                    <StatusBadge status={selected.status} onClick={cycleStatus} />
                  </div>
                  {(selected.keywords.length > 0 || selected.owner) && (
                    <div className="flex items-center gap-2 pt-3 border-t border-[var(--border)] flex-wrap">
                      {selected.keywords.map((kw) => (
                        <span
                          key={kw}
                          className="text-[11px] px-2 py-0.5 rounded-full bg-[rgba(88,166,255,0.08)] text-[var(--accent)]"
                        >
                          {kw}
                        </span>
                      ))}
                      {selected.owner && (
                        <span className="text-xs text-[var(--text-dim)] ml-auto">
                          Owner: {selected.owner}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </Card>

              {/* Activity Feed */}
              {selected.activity.length > 0 && (
                <Card>
                  <CardHeader
                    title="Activity Feed"
                    right={
                      <span className="text-xs text-[var(--text-dim)]">
                        {selected.activity.length} items
                      </span>
                    }
                  />
                  <div className="max-h-[50vh] overflow-y-auto">
                    {selected.activity
                      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
                      .map((item, i) => {
                        const style = ACTIVITY_STYLES[item.type] || ACTIVITY_STYLES.task;
                        return (
                          <div
                            key={i}
                            className="flex gap-3 px-4 py-2.5 border-b border-[var(--border)] last:border-0"
                          >
                            <div
                              className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5"
                              style={{
                                background: `color-mix(in srgb, ${style.color} 15%, transparent)`,
                                color: style.color,
                              }}
                            >
                              {style.icon}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-[var(--text-bright)] truncate">
                                  {item.title}
                                </span>
                                <span className="text-xs text-[var(--text-dim)] shrink-0">
                                  {item.date ? timeAgo(item.date) : ""}
                                </span>
                              </div>
                              {item.detail && (
                                <div className="text-xs text-[var(--text-dim)] mt-0.5 truncate">
                                  {item.detail}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </Card>
              )}

              {/* Tasks */}
              {selected.tasks.length > 0 && (
                <Card>
                  <CardHeader
                    title="Tasks"
                    right={
                      <span className="text-xs text-[var(--text-dim)]">
                        {selected.tasks.length}
                      </span>
                    }
                  />
                  <div>
                    {selected.tasks
                      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
                      .filter((t) => !isSuppressed("task", t.id))
                      .map((t) => (
                        <div
                          key={t.id}
                          className="group/row flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0"
                        >
                          {t.pinned && (
                            <span className="text-[10px] text-[var(--accent)] shrink-0" title="Pinned">
                              P
                            </span>
                          )}
                          {t.priority && (
                            <span className={priorityBadgeCls(t.priority)}>
                              {t.priority}
                            </span>
                          )}
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                              t.status === "Done"
                                ? "bg-[rgba(63,185,80,0.15)] text-[var(--green)]"
                                : t.status === "In progress"
                                ? "bg-[rgba(88,166,255,0.15)] text-[var(--accent)]"
                                : "bg-[rgba(139,148,158,0.15)] text-[var(--text-dim)]"
                            }`}
                          >
                            {t.status}
                          </span>
                          <span className="text-sm flex-1 truncate">{t.title}</span>
                          <VoteButtons
                            context={voteContext}
                            itemType="task"
                            itemId={t.id}
                            initialScore={getScore("task", t.id)}
                            onVoted={(s) => updateScore("task", t.id, s)}
                          />
                          {t.source && (
                            <span className="text-[10px] text-[var(--text-dim)] shrink-0">
                              {t.source}
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* People */}
              {selected.people.length > 0 && (
                <Card>
                  <CardHeader
                    title="People"
                    right={
                      <span className="text-xs text-[var(--text-dim)]">
                        {selected.people.length}
                      </span>
                    }
                  />
                  <div className="px-4 py-3 flex flex-wrap gap-2">
                    {selected.people
                      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
                      .map((p, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 px-2 py-1 rounded-full bg-[rgba(88,166,255,0.06)] border border-[var(--border)]"
                        >
                          <Avatar name={p.name} avatar={p.avatar} />
                          <span className="text-xs text-[var(--text-bright)]">{p.name}</span>
                          {p.meetingCount > 0 && (
                            <span className="text-[10px] text-[var(--text-dim)]">
                              {p.meetingCount} mtg
                            </span>
                          )}
                          {p.pinned && (
                            <span className="text-[10px] text-[var(--accent)]" title="Pinned">
                              P
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* Meetings & Summaries */}
              {selected.meetings.length > 0 && (
                <Card>
                  <CardHeader
                    title="Meetings & Summaries"
                    right={
                      <span className="text-xs text-[var(--text-dim)]">
                        {selected.meetings.length}
                      </span>
                    }
                  />
                  <div>
                    {selected.meetings
                      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
                      .map((m) => (
                        <div
                          key={m.title}
                          className="px-4 py-3 border-b border-[var(--border)] last:border-0"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--accent)]" />
                            <span className="text-sm flex-1 truncate text-[var(--text-bright)]">
                              {m.title}
                            </span>
                            <span className="text-xs text-[var(--text-dim)] shrink-0">
                              {m.date ? shortDate(m.date) : ""}
                            </span>
                          </div>
                          {m.hasSummary && (
                            <div className="text-[10px] text-[var(--green)] mt-1 ml-[18px]">
                              AI Summary available
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {/* New Initiative modal */}
      {showModal && (
        <NewInitiativeModal
          onClose={() => setShowModal(false)}
          onCreated={() => loadInitiatives()}
        />
      )}
    </div>
  );
}
