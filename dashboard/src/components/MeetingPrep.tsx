"use client";

import { useEffect, useState, useRef } from "react";
import { Card, CardHeader } from "@/components/Card";
import { fmt12, timeAgo } from "@/lib/dates";
import { WebexMeeting } from "@/lib/webex";
import { NotionPage } from "@/lib/notion";
import ReplyDrafter from "@/components/ReplyDrafter";
import TaskDetail from "@/components/TaskDetail";
import VoteButtons from "@/components/VoteButtons";
import ArtifactList from "@/components/ArtifactList";

interface QuickAttendee {
  name: string;
  emails: string[];
  meetings: number;
  messages: number;
  transcripts: number;
}

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
  const [scores, setScores] = useState<Record<string, number>>({});
  const [attendees, setAttendees] = useState<QuickAttendee[]>([]);
  const [quickBrief, setQuickBrief] = useState<string | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);

  const voteContext = `prep:${meeting.title}`;
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
        const [data, scoresResp] = await Promise.all([
          fetchPrep(cached),
          fetch(`/api/relevance?context=${encodeURIComponent(voteContext)}`).then(r => r.ok ? r.json() : { scores: {} }),
        ]);
        setPrep(data);
        setScores(scoresResp.scores || {});
        // If no person-specific context, fetch attendee quick-briefs from meeting title keywords
        const hasCtx = data && (
          (data.recentMessages?.length || 0) > 0 ||
          (data.previousMeetings?.length || 0) > 0 ||
          (data.openTasks?.length || 0) > 0
        );
        // Fetch real invitees from Webex API
        if (meeting.id && !meeting.id.startsWith("gcal-")) {
          fetch(`/api/webex/invitees?meetingId=${encodeURIComponent(meeting.id)}`)
            .then((r) => r.json())
            .then((data) => { if (data.invitees) setAttendees(data.invitees); })
            .catch(() => {});
        }
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

  const updateScore = (itemType: string, itemId: string, newScore: number) => {
    setScores((prev) => ({ ...prev, [`${itemType}:${itemId}`]: newScore }));
  };
  const getScore = (itemType: string, itemId: string) => scores[`${itemType}:${itemId}`] ?? 0;
  const isSuppressed = (itemType: string, itemId: string) => getScore(itemType, itemId) <= -2;

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

          {/* Attendees — always show if available */}
          {!loading && attendees.length > 0 && (
            <Card>
              <CardHeader
                title="Attendees"
                right={<span className="text-xs text-[var(--text-dim)]">{attendees.length}</span>}
              />
              <div className="max-h-[300px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {attendees.map((a) => (
                  <div
                    key={a.name}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] last:border-0 hover:bg-[rgba(88,166,255,0.03)] cursor-pointer"
                    onClick={() => {
                      handleCandidateSelect(a.name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim());
                    }}
                  >
                    {(a as any).avatar ? (
                      <img src={(a as any).avatar} className="w-8 h-8 rounded-full shrink-0 object-cover" alt="" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-[rgba(88,166,255,0.12)] flex items-center justify-center text-xs font-bold text-[var(--accent)] shrink-0">
                        {a.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--text)]">{a.name}</div>
                      <div className="text-[10px] text-[var(--text-dim)]">
                        {(a as any).jobTitle ? `${(a as any).jobTitle}${(a as any).company ? ` · ${(a as any).company}` : ""}` : (a as any).email || ""}
                      </div>
                    </div>
                    <div className="flex gap-2 text-[10px] text-[var(--text-dim)] shrink-0">
                      {a.meetings > 0 && <span>{a.meetings} mtg</span>}
                      {a.messages > 0 && <span>{a.messages} msg</span>}
                      {a.transcripts > 0 && <span>{a.transcripts} tr</span>}
                    </div>
                    <span className="text-[var(--text-dim)] text-xs">&rsaquo;</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {!loading && !hasContext && attendees.length === 0 && (
            <div className="text-center text-[var(--text-dim)] py-4 italic text-sm">
              No attendee or topic context found
            </div>
          )}

          {/* Quick brief — synthesized from attendees + meeting topic */}
          {!loading && attendees.length > 0 && (
            <Card>
              <CardHeader
                title="Meeting Brief"
                right={
                  !quickBrief ? (
                    <button
                      disabled={briefLoading}
                      onClick={async () => {
                        setBriefLoading(true);
                        try {
                          const attendeeList = attendees.map((a) => {
                            let desc = a.name;
                            if ((a as any).jobTitle) desc += ` (${(a as any).jobTitle})`;
                            if (a.meetings > 0 || a.messages > 0) desc += ` — ${a.meetings} meetings, ${a.messages} messages`;
                            return desc;
                          }).join("\n");
                          // Fetch related conversations from vector DB
                          let vectorContext = "";
                          try {
                            const searchResp = await fetch(`/api/search?q=${encodeURIComponent(meeting.title)}&limit=5`);
                            if (searchResp.ok) {
                              const searchData = await searchResp.json();
                              if (searchData.results?.length) {
                                vectorContext = "\n\nRelated conversations from history:\n" +
                                  searchData.results.map((r: any) => `- [${r.source}] ${(r.text || "").slice(0, 200)}`).join("\n");
                              }
                            }
                          } catch {}

                          const resp = await fetch("/api/synthesize", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              prompt: `You are preparing a quick meeting brief for Jason Shearer.

Meeting: "${meeting.title}"
Host: ${meeting.hostDisplayName || "Unknown"}
Time: ${new Date(meeting.start).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}

Attendees:
${attendeeList}
${vectorContext}

Provide a concise meeting brief (200 words max). Use plain text, no markdown formatting, no asterisks:

1) PURPOSE: What is this meeting about? Infer from the title, attendee roles, and any conversation history.
2) KEY PEOPLE: Who should Jason pay attention to? Highlight anyone with high interaction counts or relevant context from conversations.
3) YOUR ANGLE: One sentence on what Jason should be ready to contribute or discuss.
4) OPEN ITEMS: Any action items or follow-ups from conversation history that are relevant to this meeting.

Be direct and specific. No filler. No markdown bold/italic — use plain text only.`,
                            }),
                          });
                          if (resp.ok) {
                            const { content } = await resp.json();
                            setQuickBrief(content || null);
                          }
                        } catch {}
                        setBriefLoading(false);
                      }}
                      className="text-[11px] px-2 py-1 font-medium text-[var(--accent)] border border-[var(--border)] rounded hover:border-[var(--accent)] hover:bg-[rgba(88,166,255,0.06)] disabled:opacity-50 transition-colors"
                    >
                      {briefLoading ? "Generating..." : "Generate Brief"}
                    </button>
                  ) : (
                    <button
                      onClick={() => { setQuickBrief(null); }}
                      className="text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)]"
                    >
                      Regenerate
                    </button>
                  )
                }
              />
              {quickBrief ? (
                <div className="px-4 py-3 text-xs text-[var(--text)] leading-relaxed space-y-2">
                  {quickBrief.split("\n").map((line, i) => {
                    if (!line.trim()) return <div key={i} className="h-1.5" />;
                    // Render inline bold **text** and strip raw markdown
                    const renderLine = (text: string) => {
                      const parts = text.split(/\*\*([^*]+)\*\*/g);
                      return parts.map((part, j) => j % 2 === 1
                        ? <strong key={j} className="text-[var(--text-bright)] font-semibold">{part}</strong>
                        : <span key={j}>{part}</span>
                      );
                    };
                    if (line.match(/^\d+[\)\.]/)) return <div key={i} className="flex gap-2"><span className="text-[var(--accent)] shrink-0 w-5 text-right font-medium">{line.match(/^(\d+)/)?.[1]}.</span><span>{renderLine(line.replace(/^\d+[\)\.]\s*/, ""))}</span></div>;
                    if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("• ")) return <div key={i} className="flex gap-2"><span className="text-[var(--text-dim)] shrink-0">&bull;</span><span>{renderLine(line.replace(/^[-*•]\s*/, ""))}</span></div>;
                    if (line.match(/^[A-Z\s]{4,}:/)) return <div key={i} className="font-semibold text-[var(--text-bright)] mt-2">{renderLine(line)}</div>;
                    return <p key={i}>{renderLine(line)}</p>;
                  })}
                </div>
              ) : !briefLoading ? (
                <div className="px-4 py-3 text-xs text-[var(--text-dim)] italic">
                  Click Generate to synthesize attendee context and meeting topic
                </div>
              ) : (
                <div className="px-4 py-3 text-xs text-[var(--text-dim)] animate-pulse">
                  Analyzing attendees and meeting context...
                </div>
              )}
            </Card>
          )}

          {/* Follow-ups owed — most important, show first */}
          {prep?.followUpsOwed && prep.followUpsOwed.length > 0 && (
            <Card>
              <CardHeader title="⚠️ Follow-ups You Owe" />
              <div>
                {prep.followUpsOwed.filter((t) => !isSuppressed("task", t.id)).map((t) => (
                  <button key={t.id} onClick={() => setSelectedTask(prepTaskToPage(t))}
                    className="group/row flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface2)] transition-colors cursor-pointer w-full text-left">
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                      t.priority?.includes("P0") ? "bg-[rgba(248,81,73,0.15)] text-[var(--red)]" :
                      t.priority?.includes("P1") ? "bg-[rgba(219,109,40,0.15)] text-[var(--orange)]" :
                      "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]"
                    }`}>{t.priority?.split(" ")[0] || "P2"}</span>
                    <EditableTitle taskId={t.id} title={t.title} onSaved={(newTitle) => { t.title = newTitle; setPrep({ ...prep! }); }} />
                    <VoteButtons context={voteContext} itemType="task" itemId={t.id} initialScore={getScore("task", t.id)} onVoted={(s) => updateScore("task", t.id, s)} />
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
                {prep.openTasks.filter((t) => !prep.followUpsOwed?.some((f) => f.id === t.id) && !isSuppressed("task", t.id)).map((t) => (
                  <button key={t.id} onClick={() => setSelectedTask(prepTaskToPage(t))}
                    className="group/row flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface2)] transition-colors cursor-pointer w-full text-left">
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                      t.priority?.includes("P0") ? "bg-[rgba(248,81,73,0.15)] text-[var(--red)]" :
                      t.priority?.includes("P1") ? "bg-[rgba(219,109,40,0.15)] text-[var(--orange)]" :
                      "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]"
                    }`}>{t.priority?.split(" ")[0] || "P2"}</span>
                    <EditableTitle taskId={t.id} title={t.title} onSaved={(newTitle) => { t.title = newTitle; setPrep({ ...prep! }); }} />
                    <VoteButtons context={voteContext} itemType="task" itemId={t.id} initialScore={getScore("task", t.id)} onVoted={(s) => updateScore("task", t.id, s)} />
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
                {prep.recentMessages.filter((_, i) => !isSuppressed("message", String(i))).map((m, i) => (
                  <div key={i} className="group/row px-4 py-2.5 border-b border-[var(--border)] last:border-0">
                    <div className="flex items-center justify-between mb-1">
                      {prep.personEmail ? (
                        <a href={`mailto:${prep.personEmail}`} className="text-xs text-[var(--accent)] hover:underline">{prep.personName}</a>
                      ) : (
                        <span className="text-xs text-[var(--accent)]">{prep.personName}</span>
                      )}
                      <div className="flex items-center gap-2">
                        <VoteButtons context={voteContext} itemType="message" itemId={String(i)} initialScore={getScore("message", String(i))} onVoted={(s) => updateScore("message", String(i), s)} />
                        <button
                          onClick={() => setReplyTo({
                            text: m.text,
                            personName: prep.personName || "",
                            personEmail: prep.personEmail || undefined,
                          })}
                          className="text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] opacity-0 group-hover/row:opacity-100 transition-opacity"
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
                {prep.transcriptHighlights.filter((_, i) => !isSuppressed("transcript", String(i))).map((t, i) => (
                  <div key={i} className="group/row px-4 py-3 border-b border-[var(--border)] last:border-0">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-[var(--purple)]">{t.topic.slice(0, 50)}</span>
                      <div className="flex items-center gap-2">
                        <VoteButtons context={voteContext} itemType="transcript" itemId={String(i)} initialScore={getScore("transcript", String(i))} onVoted={(s) => updateScore("transcript", String(i), s)} />
                        <span className="text-xs text-[var(--text-dim)]">
                          {new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      </div>
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
                {prep.matchedTopics.filter((t) => !isSuppressed("topic", t.name)).map((t, i) => (
                  <div key={i} className="group/row flex items-center justify-between mb-2 last:mb-0">
                    <div>
                      <span className="text-sm font-medium text-[var(--accent)]">{t.name}</span>
                      <span className="text-xs text-[var(--text-dim)] ml-2">
                        {t.meetingCount} meetings, {t.taskCount} tasks, {t.people.length} people
                      </span>
                    </div>
                    <VoteButtons context={voteContext} itemType="topic" itemId={t.name} initialScore={getScore("topic", t.name)} onVoted={(s) => updateScore("topic", t.name, s)} />
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
