"use client";

import { useEffect, useState, useRef } from "react";
import { Card, CardHeader } from "@/components/Card";
import { fmt12, timeAgo } from "@/lib/dates";
import { WebexMeeting } from "@/lib/webex";
import { NotionPage } from "@/lib/notion";
import ReplyDrafter from "@/components/ReplyDrafter";
import TaskDetail from "@/components/TaskDetail";

/** Inline-editable task title. Click to edit, Enter/blur to save. Calls corrections API. */
function EditableTitle({
  taskId,
  title,
  onSaved,
}: {
  taskId: string;
  title: string;
  onSaved: (newTitle: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function save() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === title) {
      setEditing(false);
      setValue(title);
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch("/api/corrections", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, oldTitle: title, newTitle: trimmed }),
      });
      if (resp.ok) {
        onSaved(trimmed);
        setFlash(true);
        setTimeout(() => setFlash(false), 1200);
      }
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") { setEditing(false); setValue(title); }
        }}
        onBlur={save}
        onClick={(e) => e.stopPropagation()}
        disabled={saving}
        className="text-sm flex-1 bg-[var(--bg)] border border-[var(--accent)] rounded px-2 py-0.5 text-[var(--text)] focus:outline-none"
        autoFocus
      />
    );
  }

  return (
    <span
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      className={`text-sm flex-1 cursor-text hover:underline hover:decoration-dotted hover:decoration-[var(--text-dim)] ${
        flash ? "text-[var(--green)]" : ""
      } ${saving ? "opacity-50" : ""}`}
      title="Click to edit"
    >
      {title}{flash && " ✓"}
    </span>
  );
}

/** Build a minimal NotionPage from prep task data so TaskDetail can render it. */
function prepTaskToPage(t: { id: string; title: string; status?: string; priority?: string; delegated?: string }): NotionPage {
  return {
    id: t.id,
    url: `https://notion.so/${t.id.replace(/-/g, "")}`,
    last_edited_time: new Date().toISOString(),
    properties: {
      Task: { type: "title", title: [{ plain_text: t.title }] },
      Status: { type: "status", status: { name: t.status || "Not started" } },
      Priority: { type: "select", select: t.priority ? { name: t.priority } : null },
      "Delegated To": { type: "select", select: t.delegated ? { name: t.delegated } : null },
    },
  } as unknown as NotionPage;
}

interface PrepData {
  meetingTitle: string;
  personName: string | null;
  personEmail: string | null;
  personAvatar: string | null;
  recentMessages?: { text: string; date: string }[];
  previousMeetings?: { topic: string; date: string }[];
  transcriptHighlights?: { topic: string; date: string; snippets: string[] }[];
  stats?: { meetings: number; transcripts: number; messages: number; tasks: number };
  matchedTopics?: { name: string; taskCount: number; meetingCount: number; people: string[] }[];
  openTasks?: { id: string; title: string; status: string; priority: string; delegated: string }[];
  followUpsOwed?: { id: string; title: string; priority: string }[];
  candidates?: { key: string; name: string; email?: string; avatar?: string; meetingCount: number; messageCount: number }[];
}

export default function MeetingPrep({
  meeting,
  onClose,
}: {
  meeting: WebexMeeting;
  onClose: () => void;
}) {
  const [prep, setPrep] = useState<PrepData | null>(null);
  const [loading, setLoading] = useState(true);
  const [replyTo, setReplyTo] = useState<{ text: string; personName: string; personEmail?: string } | null>(null);
  const [selectedTask, setSelectedTask] = useState<NotionPage | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>(null);

  const disambigKey = `mc:disambig:${meeting.title}`;

  const fetchPrep = async (personKey?: string) => {
    const params = new URLSearchParams({
      title: meeting.title,
      host: meeting.hostDisplayName || "",
      hostEmail: meeting.hostEmail || "",
    });
    if (personKey) params.set("selectedPerson", personKey);
    try {
      const resp = await fetch(`/api/meeting-prep?${params}`);
      return (await resp.json()) as PrepData;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    async function load() {
      const cached = localStorage.getItem(disambigKey) || undefined;
      if (cached) setSelectedCandidate(cached);
      try {
        const data = await fetchPrep(cached);
        setPrep(data);
      } catch {
        setPrep(null);
      } finally {
        setLoading(false);
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting]);

  const handleCandidateSelect = async (key: string) => {
    setSelectedCandidate(key);
    localStorage.setItem(disambigKey, key);
    setLoading(true);
    try {
      const data = await fetchPrep(key);
      setPrep(data);
    } catch {
      // keep existing prep on error
    } finally {
      setLoading(false);
    }
  };

  const hasContext = prep && (
    (prep.recentMessages?.length || 0) > 0 ||
    (prep.previousMeetings?.length || 0) > 0 ||
    (prep.openTasks?.length || 0) > 0 ||
    (prep.matchedTopics?.length || 0) > 0
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative w-[520px] h-full bg-[var(--bg)] border-l border-[var(--border)] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-[var(--bg)] border-b border-[var(--border)] px-5 py-4 z-10">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              {prep?.personAvatar ? (
                <img src={prep.personAvatar} alt="" className="w-10 h-10 rounded-full object-cover" />
              ) : prep?.personName ? (
                <div className="w-10 h-10 rounded-full bg-[var(--surface2)] border border-[var(--border)] flex items-center justify-center text-sm font-medium text-[var(--accent)]">
                  {prep.personName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
                </div>
              ) : null}
              <div>
                <h2 className="text-base font-semibold text-[var(--text-bright)]">
                  {meeting.title}
                </h2>
                <div className="text-sm text-[var(--text-dim)]">
                  {fmt12(meeting.start)} - {fmt12(meeting.end)}
                  {prep?.personName && (
                    <span className="ml-2 text-[var(--accent)]">with {prep.personName}</span>
                  )}
                </div>
                {meeting.webLink && (
                  <a href={meeting.webLink} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-1 text-xs text-[var(--green)] hover:underline">
                    Join Meeting ↗
                  </a>
                )}
              </div>
            </div>
            <button onClick={onClose} className="text-[var(--text-dim)] hover:text-[var(--text)] text-lg px-2">&times;</button>
          </div>

          {/* Stats */}
          {prep?.stats && (
            <div className="flex gap-4 mt-3 pt-3 border-t border-[var(--border)]">
              {[
                { v: prep.stats.meetings, l: "Meetings", c: "var(--accent)" },
                { v: prep.stats.transcripts, l: "Transcripts", c: "var(--purple)" },
                { v: prep.stats.messages, l: "Messages", c: "var(--green)" },
                { v: prep.stats.tasks, l: "Tasks", c: "var(--yellow)" },
              ].map((s) => (
                <div key={s.l} className="text-center">
                  <div className="text-lg font-bold" style={{ color: s.c }}>{s.v}</div>
                  <div className="text-[10px] text-[var(--text-dim)] uppercase">{s.l}</div>
                </div>
              ))}
            </div>
          )}

          {/* Disambiguation bar */}
          {prep?.candidates && prep.candidates.length > 1 && !selectedCandidate && (
            <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-[var(--border)]">
              <span className="text-xs text-[var(--text-dim)] self-center mr-1">Match:</span>
              {prep.candidates.map((c) => (
                <button
                  key={c.key}
                  onClick={() => handleCandidateSelect(c.key)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-colors ${
                    c.key === prep.candidates![0].key
                      ? "border-[var(--accent)] text-[var(--accent)]"
                      : "border-[var(--border)] text-[var(--text)] hover:border-[var(--text-dim)]"
                  }`}
                >
                  {c.avatar ? (
                    <img src={c.avatar} alt="" className="w-4 h-4 rounded-full object-cover" />
                  ) : (
                    <span className="w-4 h-4 rounded-full bg-[var(--surface2)] flex items-center justify-center text-[8px] font-medium shrink-0">
                      {c.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span>{c.name}</span>
                  <span className="text-[var(--text-dim)]">({c.meetingCount})</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-5 space-y-5">
          {loading && (
            <div className="text-center text-[var(--text-dim)] py-8">Loading prep...</div>
          )}

          {!loading && !hasContext && (
            <div className="text-center text-[var(--text-dim)] py-8 italic">
              No specific prep needed for this meeting
            </div>
          )}

          {/* Follow-ups owed — most important, show first */}
          {prep?.followUpsOwed && prep.followUpsOwed.length > 0 && (
            <Card>
              <CardHeader title="⚠️ Follow-ups You Owe" />
              <div>
                {prep.followUpsOwed.map((t) => (
                  <button key={t.id} onClick={() => setSelectedTask(prepTaskToPage(t))}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface2)] transition-colors cursor-pointer w-full text-left">
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                      t.priority?.includes("P0") ? "bg-[rgba(248,81,73,0.15)] text-[var(--red)]" :
                      t.priority?.includes("P1") ? "bg-[rgba(219,109,40,0.15)] text-[var(--orange)]" :
                      "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]"
                    }`}>{t.priority?.split(" ")[0] || "P2"}</span>
                    <EditableTitle taskId={t.id} title={t.title} onSaved={(newTitle) => { t.title = newTitle; setPrep({ ...prep! }); }} />
                  </button>
                ))}
              </div>
            </Card>
          )}

          {/* Open tasks related to this meeting (exclude follow-ups already shown above) */}
          {prep?.openTasks && prep.openTasks.filter((t) => !prep.followUpsOwed?.some((f) => f.id === t.id)).length > 0 && (
            <Card>
              <CardHeader title="Open Action Items" right={<span className="text-xs text-[var(--text-dim)]">{prep.openTasks.filter((t) => !prep.followUpsOwed?.some((f) => f.id === t.id)).length}</span>} />
              <div>
                {prep.openTasks.filter((t) => !prep.followUpsOwed?.some((f) => f.id === t.id)).map((t) => (
                  <button key={t.id} onClick={() => setSelectedTask(prepTaskToPage(t))}
                    className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface2)] transition-colors cursor-pointer w-full text-left">
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                      t.priority?.includes("P0") ? "bg-[rgba(248,81,73,0.15)] text-[var(--red)]" :
                      t.priority?.includes("P1") ? "bg-[rgba(219,109,40,0.15)] text-[var(--orange)]" :
                      "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]"
                    }`}>{t.priority?.split(" ")[0] || "P2"}</span>
                    <EditableTitle taskId={t.id} title={t.title} onSaved={(newTitle) => { t.title = newTitle; setPrep({ ...prep! }); }} />
                  </button>
                ))}
              </div>
            </Card>
          )}

          {/* Recent messages — with reply button */}
          {prep?.recentMessages && prep.recentMessages.length > 0 && (
            <Card>
              <CardHeader title="Recent Conversation" />
              <div>
                {prep.recentMessages.map((m, i) => (
                  <div key={i} className="px-4 py-2.5 border-b border-[var(--border)] last:border-0 group/msg">
                    <div className="flex items-center justify-between mb-1">
                      {prep.personEmail ? (
                        <a href={`mailto:${prep.personEmail}`} className="text-xs text-[var(--accent)] hover:underline">{prep.personName}</a>
                      ) : (
                        <span className="text-xs text-[var(--accent)]">{prep.personName}</span>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setReplyTo({
                            text: m.text,
                            personName: prep.personName || "",
                            personEmail: prep.personEmail || undefined,
                          })}
                          className="text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] opacity-0 group-hover/msg:opacity-100 transition-opacity"
                        >
                          Draft Reply
                        </button>
                        <span className="text-xs text-[var(--text-dim)]">{timeAgo(m.date)}</span>
                      </div>
                    </div>
                    <div className="text-sm text-[var(--text)]">{m.text}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Transcript highlights */}
          {prep?.transcriptHighlights && prep.transcriptHighlights.length > 0 && (
            <Card>
              <CardHeader title="What They Said Recently" />
              <div>
                {prep.transcriptHighlights.map((t, i) => (
                  <div key={i} className="px-4 py-3 border-b border-[var(--border)] last:border-0">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-[var(--purple)]">{t.topic.slice(0, 50)}</span>
                      <span className="text-xs text-[var(--text-dim)]">
                        {new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                    </div>
                    {t.snippets.map((s, j) => (
                      <div key={j} className="text-sm text-[var(--text)] bg-[var(--surface2)] rounded px-3 py-1.5 mb-1 italic">
                        &ldquo;{s}&rdquo;
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Previous meetings */}
          {prep?.previousMeetings && prep.previousMeetings.length > 0 && (
            <Card>
              <CardHeader title="Previous Meetings Together" />
              <div>
                {prep.previousMeetings.map((m, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--purple)]" />
                    <span className="text-sm flex-1">{m.topic.slice(0, 55)}</span>
                    <span className="text-xs text-[var(--text-dim)]">
                      {new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Related topics */}
          {prep?.matchedTopics && prep.matchedTopics.length > 0 && (
            <Card>
              <CardHeader title="Related Topics" />
              <div className="px-4 py-3">
                {prep.matchedTopics.map((t, i) => (
                  <div key={i} className="mb-2 last:mb-0">
                    <span className="text-sm font-medium text-[var(--accent)]">{t.name}</span>
                    <span className="text-xs text-[var(--text-dim)] ml-2">
                      {t.meetingCount} meetings, {t.taskCount} tasks, {t.people.length} people
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Task detail modal */}
      {selectedTask && (
        <TaskDetail
          page={selectedTask}
          onClose={() => setSelectedTask(null)}
          onComplete={(id) => {
            // Remove completed task from prep lists
            if (prep) {
              prep.openTasks = prep.openTasks?.filter((t) => t.id !== id);
              prep.followUpsOwed = prep.followUpsOwed?.filter((t) => t.id !== id);
            }
            setSelectedTask(null);
          }}
        />
      )}

      {/* Reply drafter */}
      {replyTo && (
        <ReplyDrafter
          message={replyTo.text}
          personName={replyTo.personName}
          personEmail={replyTo.personEmail}
          channel="Webex"
          onClose={() => setReplyTo(null)}
        />
      )}
    </div>
  );
}
