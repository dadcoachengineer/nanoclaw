"use client";

import { useEffect, useState, useRef } from "react";
import { Card, CardHeader, StatCard } from "@/components/Card";
import { timeAgo } from "@/lib/dates";
import VoteButtons from "@/components/VoteButtons";
import ArtifactList from "@/components/ArtifactList";

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

interface InitiativePhase {
  id: string;
  label: string;
  sort_order: number;
  start_date?: string;
  end_date?: string;
}

interface InitiativeArtifact {
  id: string;
  title: string;
  intent: string;
  task_id: string;
  char_count: number;
  created_at: string;
}

interface InitiativeDetail {
  slug: string;
  name: string;
  description: string;
  status: "active" | "paused" | "complete";
  keywords: string[];
  owner?: string;
  target_date?: string;
  activity: ActivityItem[];
  tasks: InitiativeTask[];
  people: (InitiativePerson & { lastMessage?: string })[];
  meetings: InitiativeMeeting[];
  phases: InitiativePhase[];
  artifacts: InitiativeArtifact[];
  taskPhaseMap: Record<string, string>;
  progress: { total: number; done: number };
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
  const [activePhaseFilter, setActivePhaseFilter] = useState<string | null>(null);
  const [editingTargetDate, setEditingTargetDate] = useState(false);
  const [targetDateDraft, setTargetDateDraft] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ id: string; role: string; content: string; created_at: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [expandedArtifact, setExpandedArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  const [addingPhase, setAddingPhase] = useState(false);
  const [newPhaseLabel, setNewPhaseLabel] = useState("");
  const [editingPhase, setEditingPhase] = useState<string | null>(null);
  const [editPhaseLabel, setEditPhaseLabel] = useState("");
  const [phaseMenuOpen, setPhaseMenuOpen] = useState<string | null>(null);

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
    setActivePhaseFilter(null);
    setChatOpen(false);
    setChatMessages([]);
    setExpandedArtifact(null);
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

  // Load chat history when opened
  useEffect(() => {
    if (!chatOpen || !selectedSlug) return;
    fetch(`/api/initiative-chat?slug=${selectedSlug}`)
      .then((r) => r.json())
      .then((data) => { if (data.messages) setChatMessages(data.messages); })
      .catch(() => {});
  }, [chatOpen, selectedSlug]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  async function handleChatSend() {
    const msg = chatInput.trim();
    if (!msg || chatLoading || !selectedSlug) return;
    setChatInput("");
    setChatLoading(true);
    setChatMessages((prev) => [...prev, { id: `tmp-${Date.now()}`, role: "user", content: msg, created_at: new Date().toISOString() }]);
    try {
      const resp = await fetch("/api/initiative-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: selectedSlug, message: msg }),
      });
      if (!resp.ok) throw new Error("Chat failed");
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      setChatMessages((prev) => [...prev, { id: data.id || `msg-${Date.now()}`, role: "assistant", content: data.content, created_at: data.created_at || new Date().toISOString() }]);
    } catch (err: any) {
      setChatMessages((prev) => [...prev, { id: `err-${Date.now()}`, role: "assistant", content: `Error: ${err?.message || "Failed"}`, created_at: new Date().toISOString() }]);
    } finally {
      setChatLoading(false);
    }
  }

  async function handleInlineDone(taskId: string) {
    if (!selected) return;
    await fetch("/api/notion/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_id: taskId, properties: { Status: { status: { name: "Done" } } } }),
    });
    setSelected({
      ...selected,
      tasks: selected.tasks.map((t) => t.id === taskId ? { ...t, status: "Done" } : t),
      progress: { total: selected.progress.total, done: selected.progress.done + 1 },
    });
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
              {/* Header card with progress */}
              <Card>
                <div className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <div className="text-base font-semibold text-[var(--text-bright)]">{selected.name}</div>
                      {selected.description && <div className="text-sm text-[var(--text)] mt-1">{selected.description}</div>}
                    </div>
                    <StatusBadge status={selected.status} onClick={cycleStatus} />
                  </div>
                  {/* Progress bar */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[10px] text-[var(--text-dim)] mb-1">
                      <span>{selected.progress.done} of {selected.progress.total} tasks done</span>
                      <span>{selected.progress.total > 0 ? Math.round((selected.progress.done / selected.progress.total) * 100) : 0}%</span>
                    </div>
                    <div className="h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                      <div className="h-full bg-[var(--green)] rounded-full transition-all" style={{ width: `${selected.progress.total > 0 ? (selected.progress.done / selected.progress.total) * 100 : 0}%` }} />
                    </div>
                  </div>
                  {/* Target date + keywords */}
                  <div className="flex items-center gap-2 pt-3 mt-3 border-t border-[var(--border)] flex-wrap">
                    {editingTargetDate ? (
                      <input type="date" autoFocus value={targetDateDraft}
                        onChange={(e) => setTargetDateDraft(e.target.value)}
                        onBlur={async () => {
                          setEditingTargetDate(false);
                          if (targetDateDraft) {
                            await fetch("/api/initiatives", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: selectedSlug, target_date: targetDateDraft }) });
                            setSelected({ ...selected, target_date: targetDateDraft });
                          }
                        }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingTargetDate(false); }}
                        className="text-[11px] bg-[var(--bg)] border border-[var(--accent)] rounded px-2 py-0.5 text-[var(--text)]"
                      />
                    ) : (
                      <button onClick={() => { setEditingTargetDate(true); setTargetDateDraft(selected.target_date || ""); }}
                        className="text-[11px] px-2 py-0.5 rounded-full bg-[rgba(210,153,34,0.1)] text-[var(--yellow)] hover:bg-[rgba(210,153,34,0.2)]">
                        {selected.target_date ? `Target: ${selected.target_date}` : "+ Set target date"}
                      </button>
                    )}
                    {selected.keywords.map((kw) => (
                      <span key={kw} className="text-[11px] px-2 py-0.5 rounded-full bg-[rgba(88,166,255,0.08)] text-[var(--accent)]">{kw}</span>
                    ))}
                  </div>
                </div>
              </Card>

              {/* Phase bar */}
              {(selected.phases.length > 0 || addingPhase) && (
                <Card>
                  <div className="px-4 py-3">
                    <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {selected.phases.map((ph) => {
                        const today = new Date().toISOString().slice(0, 10);
                        const isCurrent = ph.start_date && ph.end_date ? today >= ph.start_date && today <= ph.end_date : false;
                        const isPast = ph.end_date ? today > ph.end_date : false;
                        const isActive = activePhaseFilter === ph.id;
                        const phaseTasks = selected.tasks.filter((t) => selected.taskPhaseMap[t.id] === ph.id);
                        const phaseDone = phaseTasks.filter((t) => t.status === "Done").length;
                        return (
                          <div key={ph.id} className="relative flex-1 min-w-[100px]">
                              <button
                                onClick={() => setActivePhaseFilter(isActive ? null : ph.id)}
                                className={`w-full px-3 py-2 rounded-lg text-center transition-colors ${
                                  isActive ? "bg-[rgba(88,166,255,0.15)] border border-[var(--accent)]" :
                                  isCurrent ? "bg-[rgba(63,185,80,0.1)] border border-[var(--green)]" :
                                  isPast ? "bg-[rgba(63,185,80,0.05)] border border-transparent" :
                                  "bg-[var(--bg)] border border-[var(--border)]"
                                }`}>
                                <div className={`text-[11px] font-medium ${isCurrent ? "text-[var(--green)]" : isPast ? "text-[var(--text-dim)]" : "text-[var(--text)]"}`}>{ph.label}</div>
                                {phaseTasks.length > 0 && (
                                  <div className="text-[9px] text-[var(--text-dim)] mt-0.5">{phaseDone}/{phaseTasks.length}</div>
                                )}
                                <div className="h-1 bg-[var(--border)] rounded-full mt-1 overflow-hidden">
                                  <div className={`h-full rounded-full ${isPast || (phaseDone === phaseTasks.length && phaseTasks.length > 0) ? "bg-[var(--green)]" : "bg-[var(--accent)]"}`}
                                    style={{ width: `${phaseTasks.length > 0 ? (phaseDone / phaseTasks.length) * 100 : 0}%` }} />
                                </div>
                              </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </Card>
              )}
              {/* Phase actions bar */}
              <div className="flex gap-3 px-1 items-center flex-wrap">
                {!addingPhase ? (
                  <button onClick={() => setAddingPhase(true)} className="text-[10px] text-[var(--accent)] hover:underline">+ Add phase</button>
                ) : (
                  <div className="flex gap-1 items-center">
                    <input autoFocus value={newPhaseLabel} onChange={(e) => setNewPhaseLabel(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter" && newPhaseLabel.trim()) {
                          await fetch("/api/initiatives", { method: "PATCH", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ slug: selectedSlug, addPhase: { label: newPhaseLabel.trim(), sort_order: selected.phases.length } }) });
                          setAddingPhase(false); setNewPhaseLabel("");
                          if (selectedSlug) selectInitiative(selectedSlug);
                        }
                        if (e.key === "Escape") { setAddingPhase(false); setNewPhaseLabel(""); }
                      }}
                      placeholder="Phase name..." className="text-[11px] bg-[var(--bg)] border border-[var(--accent)] rounded px-2 py-0.5 text-[var(--text)] w-32" />
                    <button onClick={() => { setAddingPhase(false); setNewPhaseLabel(""); }} className="text-[10px] text-[var(--text-dim)]">Cancel</button>
                  </div>
                )}
                {/* Show rename/delete when a phase is selected */}
                {activePhaseFilter && (() => {
                  const activePh = selected.phases.find((p) => p.id === activePhaseFilter);
                  if (!activePh) return null;
                  return editingPhase === activePh.id ? (
                    <div className="flex gap-1 items-center">
                      <span className="text-[10px] text-[var(--text-dim)]">|</span>
                      <input autoFocus value={editPhaseLabel} onChange={(e) => setEditPhaseLabel(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === "Enter" && editPhaseLabel.trim()) {
                            await fetch("/api/initiatives", { method: "PATCH", headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ slug: selectedSlug, updatePhase: { id: activePh.id, label: editPhaseLabel.trim() } }) });
                            setEditingPhase(null);
                            if (selectedSlug) selectInitiative(selectedSlug);
                          }
                          if (e.key === "Escape") setEditingPhase(null);
                        }}
                        placeholder={activePh.label}
                        className="text-[11px] bg-[var(--bg)] border border-[var(--accent)] rounded px-2 py-0.5 text-[var(--text)] w-32" />
                      <button onClick={() => setEditingPhase(null)} className="text-[10px] text-[var(--text-dim)]">Cancel</button>
                    </div>
                  ) : (
                    <>
                      <span className="text-[10px] text-[var(--text-dim)]">|</span>
                      <button onClick={() => { setEditingPhase(activePh.id); setEditPhaseLabel(activePh.label); }}
                        className="text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)]">Rename &ldquo;{activePh.label}&rdquo;</button>
                      <button onClick={async () => {
                        if (!confirm(`Delete phase "${activePh.label}"? Tasks assigned to it will be unassigned.`)) return;
                        await fetch("/api/initiatives", { method: "PATCH", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ slug: selectedSlug, removePhase: activePh.id }) });
                        setActivePhaseFilter(null);
                        if (selectedSlug) selectInitiative(selectedSlug);
                      }} className="text-[10px] text-[var(--red)] hover:underline">Delete</button>
                    </>
                  );
                })()}
              </div>

              {/* Plan / Artifacts */}
              {selected.artifacts.length > 0 && (
                <Card>
                  <CardHeader title="Plan & Artifacts" right={<span className="text-xs text-[var(--text-dim)]">{selected.artifacts.length}</span>} />
                  <div>
                    {selected.artifacts.map((a) => (
                      <div key={a.id} className="border-b border-[var(--border)] last:border-0">
                        <button onClick={async () => {
                          if (expandedArtifact === a.id) { setExpandedArtifact(null); return; }
                          setExpandedArtifact(a.id); setArtifactContent(null);
                          try { const r = await fetch(`/api/artifacts?id=${a.id}`); const d = await r.json(); if (d.content) setArtifactContent(d.content); } catch {}
                        }} className="w-full text-left flex items-center gap-2 px-4 py-2.5 hover:bg-[rgba(88,166,255,0.04)]">
                          <div className="w-5 h-5 rounded bg-[rgba(63,185,80,0.12)] flex items-center justify-center text-[9px] font-bold text-[var(--green)] shrink-0">A</div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-[var(--text)] truncate">{a.title}</div>
                            <div className="text-[10px] text-[var(--text-dim)]">{a.created_at?.slice(0, 10)} — {a.char_count?.toLocaleString()} chars</div>
                          </div>
                          <span className="text-[var(--text-dim)] text-xs">{expandedArtifact === a.id ? "\u25BE" : "\u25B8"}</span>
                        </button>
                        {expandedArtifact === a.id && artifactContent && (
                          <div className="px-4 pb-3 text-xs text-[var(--text)] max-h-[300px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden leading-relaxed whitespace-pre-wrap">
                            {artifactContent.split("\n").filter((l) => !l.startsWith("---") && !l.match(/^(title|intent|created|taskId|taskTitle|project|sources):/)).join("\n")}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* People strip */}
              {selected.people.length > 0 && (
                <Card>
                  <CardHeader title="People" right={<span className="text-xs text-[var(--text-dim)]">{selected.people.length}</span>} />
                  <div className="px-4 py-3 space-y-2">
                    {selected.people.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).map((p, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Avatar name={p.name} avatar={p.avatar} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-[var(--text-bright)]">{p.name}</span>
                            {p.email && (
                              <a href={`webexteams://im?email=${encodeURIComponent(p.email)}`} className="text-[10px] text-[var(--green)] hover:underline">Chat</a>
                            )}
                            {p.pinned && <span className="text-[10px] text-[var(--accent)]">P</span>}
                          </div>
                          {(p as any).lastMessage && <div className="text-[10px] text-[var(--text-dim)] truncate">{(p as any).lastMessage}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Tasks */}
              {selected.tasks.length > 0 && (
                <Card>
                  <CardHeader title="Tasks" right={
                    <span className="text-xs text-[var(--text-dim)]">
                      {activePhaseFilter ? selected.tasks.filter((t) => selected.taskPhaseMap[t.id] === activePhaseFilter).length : selected.tasks.length}
                    </span>
                  } />
                  <div>
                    {selected.tasks
                      .filter((t) => !activePhaseFilter || selected.taskPhaseMap[t.id] === activePhaseFilter)
                      .filter((t) => !isSuppressed("task", t.id))
                      .sort((a, b) => {
                        if (a.status === "Done" && b.status !== "Done") return 1;
                        if (a.status !== "Done" && b.status === "Done") return -1;
                        const pOrder = (p?: string) => p?.startsWith("P0") ? 0 : p?.startsWith("P1") ? 1 : p?.startsWith("P2") ? 2 : 3;
                        return pOrder(a.priority) - pOrder(b.priority);
                      })
                      .map((t) => (
                        <div key={t.id} className="group/row flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] last:border-0">
                          {t.status !== "Done" && (
                            <button onClick={() => handleInlineDone(t.id)} className="w-4 h-4 rounded border border-[var(--border)] hover:border-[var(--green)] hover:bg-[rgba(63,185,80,0.1)] shrink-0 flex items-center justify-center text-[8px] text-transparent hover:text-[var(--green)]" title="Mark done">
                              &#x2713;
                            </button>
                          )}
                          {t.status === "Done" && (
                            <div className="w-4 h-4 rounded bg-[rgba(63,185,80,0.15)] flex items-center justify-center text-[8px] text-[var(--green)] shrink-0">&#x2713;</div>
                          )}
                          {t.priority && <span className={priorityBadgeCls(t.priority)}>{t.priority?.replace(/ —.*/, "")}</span>}
                          <span className={`text-sm flex-1 truncate ${t.status === "Done" ? "line-through text-[var(--text-dim)]" : ""}`}>{t.title}</span>
                          {/* Phase assignment */}
                          {selected.phases.length > 0 && (
                            <div className="relative shrink-0">
                              <select
                                value={selected.taskPhaseMap[t.id] || ""}
                                onChange={async (e) => {
                                  const phaseId = e.target.value || null;
                                  await fetch("/api/initiatives", { method: "PATCH", headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ slug: selectedSlug, assignTaskPhase: { taskId: t.id, phaseId } }) });
                                  setSelected({
                                    ...selected,
                                    taskPhaseMap: { ...selected.taskPhaseMap, [t.id]: phaseId as any },
                                  });
                                }}
                                className="text-[9px] bg-[var(--bg)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)] cursor-pointer appearance-none max-w-[80px]"
                              >
                                <option value="">Phase</option>
                                {selected.phases.map((ph) => (
                                  <option key={ph.id} value={ph.id}>{ph.label}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          {t.source && <span className="text-[10px] text-[var(--text-dim)] shrink-0">{t.source}</span>}
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* Initiative Chat */}
              <Card>
                <div className="px-4 py-3">
                  <button onClick={() => setChatOpen(!chatOpen)} className="flex items-center gap-2 text-xs text-[var(--accent)] hover:underline">
                    <span>{chatOpen ? "\u25BE" : "\u25B8"}</span>
                    Chat about this initiative
                    {chatMessages.length > 0 && <span className="bg-[rgba(88,166,255,0.12)] text-[var(--accent)] text-[10px] px-1.5 py-0.5 rounded-full">{chatMessages.length}</span>}
                  </button>
                  {chatOpen && (
                    <div className="mt-3">
                      <div className="max-h-[300px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden space-y-2 mb-3">
                        {chatMessages.length === 0 && <div className="text-[10px] text-[var(--text-dim)] italic py-2">Ask about progress, plan next steps, draft communications, or think strategically.</div>}
                        {chatMessages.map((m) => (
                          <div key={m.id} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}>
                            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${m.role === "user" ? "bg-[rgba(88,166,255,0.08)] text-[var(--accent)]" : "bg-[var(--bg)] text-[var(--text)]"}`}>
                              <div className="whitespace-pre-wrap">{m.content}</div>
                            </div>
                            {m.role === "assistant" && !m.id.startsWith("err-") && (
                              <button onClick={() => navigator.clipboard.writeText(m.content).catch(() => {})} className="text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] mt-0.5">Copy</button>
                            )}
                          </div>
                        ))}
                        <div ref={chatEndRef} />
                      </div>
                      <div className="flex gap-2">
                        <input value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleChatSend()}
                          disabled={chatLoading} placeholder={chatLoading ? "Thinking..." : "Ask about this initiative..."}
                          className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-md px-3 py-1.5 text-xs text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50" />
                        <button onClick={handleChatSend} disabled={chatLoading || !chatInput.trim()}
                          className="px-3 py-1.5 bg-[var(--accent)] text-white text-xs font-medium rounded-md hover:opacity-90 disabled:opacity-50">
                          {chatLoading ? "..." : "Send"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
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
