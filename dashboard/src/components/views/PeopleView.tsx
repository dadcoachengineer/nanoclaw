"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, StatCard } from "@/components/Card";
import { timeAgo } from "@/lib/dates";
import ReplyDrafter from "@/components/ReplyDrafter";
import VoteButtons from "@/components/VoteButtons";

interface PersonSummary {
  key: string;
  name: string;
  emails: string[];
  avatar: string | null;
  meetings: number;
  transcripts: number;
  messages: number;
  tasks: number;
  total: number;
}

interface PersonDetail {
  name: string;
  emails: string[];
  avatar?: string;
  webexRoomIds: string[];
  meetings: { id: string; topic: string; date: string; role: string }[];
  transcriptMentions: {
    recordingId: string;
    topic: string;
    date: string;
    snippetCount: number;
    snippets: string[];
  }[];
  notionTasks: { id: string; title: string; status: string }[];
  messageExcerpts: { text: string; date: string; roomTitle: string }[];
}

function Avatar({ name, avatar, size = "sm" }: { name: string; avatar?: string | null; size?: "sm" | "lg" }) {
  const initials = name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
  const cls = size === "lg"
    ? "w-12 h-12 text-lg"
    : "w-8 h-8 text-xs";

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

export default function PeopleView() {
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [selected, setSelected] = useState<PersonDetail | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [detailFilter, setDetailFilter] = useState<"all" | "meetings" | "transcripts" | "messages" | "tasks">("all");
  const [replyTo, setReplyTo] = useState<{ text: string; personName: string; personEmail?: string; roomId?: string } | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});

  const voteContext = selectedName ? `person:${selectedName}` : "";
  const updateScore = (itemType: string, itemId: string, s: number) => setScores((prev) => ({ ...prev, [`${itemType}:${itemId}`]: s }));
  const getScore = (itemType: string, itemId: string) => scores[`${itemType}:${itemId}`] ?? 0;
  const isSuppressed = (itemType: string, itemId: string) => getScore(itemType, itemId) <= -2;

  useEffect(() => {
    fetch("/api/people")
      .then((r) => r.json())
      .then((data) => {
        setPeople(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function selectPerson(name: string) {
    setSelectedName(name);
    setDetailFilter("all");
    const [resp, scoresResp] = await Promise.all([
      fetch(`/api/people?name=${encodeURIComponent(name)}`),
      fetch(`/api/relevance?context=${encodeURIComponent(`person:${name}`)}`).then(r => r.ok ? r.json() : { scores: {} }),
    ]);
    const data = await resp.json();
    setSelected(data);
    setScores(scoresResp.scores || {});
  }

  const filtered = filter
    ? people.filter(
        (p) =>
          p.name.toLowerCase().includes(filter.toLowerCase()) ||
          p.emails.some((e) => e.toLowerCase().includes(filter.toLowerCase()))
      )
    : people;

  const withEmail = people.filter((p) => p.emails.length > 0);
  const withTranscripts = people.filter((p) => p.transcripts > 0);
  const withMessages = people.filter((p) => p.messages > 0);

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard value={people.length} label="People" color="var(--accent)" />
        <StatCard value={withEmail.length} label="With Email" color="var(--green)" />
        <StatCard value={withTranscripts.length} label="In Transcripts" color="var(--purple)" />
        <StatCard value={withMessages.length} label="Messaged" color="var(--yellow)" />
      </div>

      <div className="grid grid-cols-[1fr_480px] gap-6">
        {/* Left: People list */}
        <Card>
          <CardHeader
            title="People"
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
                key={p.key}
                className={`flex items-center gap-4 px-4 py-3 border-b border-[var(--border)] cursor-pointer hover:bg-[rgba(88,166,255,0.03)] ${
                  selectedName === p.name ? "bg-[rgba(88,166,255,0.06)]" : ""
                }`}
                onClick={() => selectPerson(p.name)}
              >
                <Avatar name={p.name} avatar={p.avatar} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--text-bright)] truncate">
                    {p.name}
                  </div>
                  <div className="flex gap-3 text-xs text-[var(--text-dim)]">
                    {p.meetings > 0 && <span>{p.meetings} mtg</span>}
                    {p.transcripts > 0 && <span>{p.transcripts} trans</span>}
                    {p.messages > 0 && <span>{p.messages} msg</span>}
                    {p.tasks > 0 && <span>{p.tasks} tasks</span>}
                  </div>
                </div>
                <div className="text-xs text-[var(--text-dim)] tabular-nums shrink-0">
                  {p.total}
                </div>
                <div className="text-[var(--text-dim)] text-xs">›</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Right: Person detail */}
        <div className="space-y-6">
          {!selected && (
            <Card>
              <div className="p-8 text-center text-[var(--text-dim)] italic">
                Select a person to see their full context
              </div>
            </Card>
          )}

          {selected && (
            <>
              {/* Header card */}
              <Card>
                <div className="p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <Avatar name={selected.name} avatar={selected.avatar} size="lg" />
                    <div>
                      <div className="text-base font-semibold text-[var(--text-bright)]">
                        {selected.name}
                      </div>
                      {selected.emails.map((e) => (
                        <div key={e} className="text-xs text-[var(--text-dim)]">{e}</div>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-1 pt-3 border-t border-[var(--border)]">
                    {([
                      { key: "meetings" as const, value: selected.meetings.length, label: "Meetings", color: "var(--accent)" },
                      { key: "transcripts" as const, value: selected.transcriptMentions.length, label: "Transcripts", color: "var(--purple)" },
                      { key: "messages" as const, value: selected.messageExcerpts.length, label: "Messages", color: "var(--green)" },
                      { key: "tasks" as const, value: selected.notionTasks.length, label: "Tasks", color: "var(--yellow)" },
                    ]).map((s) => (
                      <button
                        key={s.key}
                        onClick={() => setDetailFilter(detailFilter === s.key ? "all" : s.key)}
                        className={`flex-1 text-center py-2 rounded-md transition-colors cursor-pointer ${
                          detailFilter === s.key
                            ? "bg-[rgba(88,166,255,0.1)] border border-[var(--border)]"
                            : "hover:bg-[rgba(88,166,255,0.04)]"
                        }`}
                      >
                        <div className="text-lg font-bold" style={{ color: s.color }}>{s.value}</div>
                        <div className="text-[10px] text-[var(--text-dim)] uppercase">{s.label}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </Card>

              {/* Transcript quotes */}
              {selected.transcriptMentions.length > 0 && (detailFilter === "all" || detailFilter === "transcripts") && (
                <Card>
                  <CardHeader title="What They Said" />
                  <div>
                    {selected.transcriptMentions
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .slice(0, detailFilter === "transcripts" ? 20 : 5)
                      .filter((t) => !isSuppressed("transcript", t.recordingId))
                      .map((t, i) => (
                        <div key={i} className="group/row px-4 py-3 border-b border-[var(--border)] last:border-0">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-[var(--purple)]">
                              {t.topic.slice(0, 50)}
                            </span>
                            <div className="flex items-center gap-2">
                              <VoteButtons context={voteContext} itemType="transcript" itemId={t.recordingId} initialScore={getScore("transcript", t.recordingId)} onVoted={(s) => updateScore("transcript", t.recordingId, s)} />
                              <span className="text-xs text-[var(--text-dim)]">
                                {new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              </span>
                            </div>
                          </div>
                          {t.snippets.slice(0, 3).map((s, j) => (
                            <div key={j} className="text-sm text-[var(--text)] bg-[var(--surface2)] rounded px-3 py-1.5 mb-1 italic">
                              &ldquo;{s}&rdquo;
                            </div>
                          ))}
                          {t.snippetCount > 3 && (
                            <div className="text-xs text-[var(--text-dim)] mt-1">
                              +{t.snippetCount - 3} more lines
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* Recent messages */}
              {selected.messageExcerpts.length > 0 && (detailFilter === "all" || detailFilter === "messages") && (
                <Card>
                  <CardHeader title="Recent Messages" />
                  <div>
                    {selected.messageExcerpts
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .slice(0, detailFilter === "messages" ? 30 : 10)
                      .filter((_, i) => !isSuppressed("message", String(i)))
                      .map((m, i) => (
                        <div key={i} className="group/row px-4 py-2.5 border-b border-[var(--border)] last:border-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-[var(--accent)]">
                              {m.roomTitle}
                            </span>
                            <div className="flex items-center gap-2">
                              <VoteButtons context={voteContext} itemType="message" itemId={String(i)} initialScore={getScore("message", String(i))} onVoted={(s) => updateScore("message", String(i), s)} />
                              <button
                                onClick={() => setReplyTo({
                                  text: m.text,
                                  personName: selected.name,
                                  personEmail: selected.emails?.[0],
                                  roomId: selected.webexRoomIds?.[0],
                                })}
                                className="text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] opacity-0 group-hover/row:opacity-100 transition-opacity"
                              >
                                Draft Reply
                              </button>
                              <span className="text-xs text-[var(--text-dim)]">
                                {timeAgo(m.date)}
                              </span>
                            </div>
                          </div>
                          <div className="text-sm text-[var(--text)]">{m.text}</div>
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* Meeting history */}
              {selected.meetings.length > 0 && (detailFilter === "all" || detailFilter === "meetings") && (
                <Card>
                  <CardHeader title="Meeting History" />
                  <div>
                    {selected.meetings
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .slice(0, detailFilter === "meetings" ? 30 : 10)
                      .map((m, i) => (
                        <div key={i} className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0">
                          <div
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ background: m.role === "host" ? "var(--yellow)" : "var(--purple)" }}
                          />
                          <span className="text-sm flex-1 truncate">{m.topic}</span>
                          <span className="text-xs text-[var(--text-dim)]">
                            {new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </span>
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* Related tasks */}
              {selected.notionTasks.length > 0 && (detailFilter === "all" || detailFilter === "tasks") && (
                <Card>
                  <CardHeader title="Related Tasks" />
                  <div>
                    {selected.notionTasks.filter((t) => !isSuppressed("task", t.id)).map((t) => (
                      <div key={t.id} className="group/row flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                            t.status === "Done"
                              ? "bg-[rgba(63,185,80,0.15)] text-[var(--green)]"
                              : "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]"
                          }`}
                        >
                          {t.status}
                        </span>
                        <span className="text-sm flex-1 truncate">{t.title}</span>
                        <VoteButtons context={voteContext} itemType="task" itemId={t.id} initialScore={getScore("task", t.id)} onVoted={(s) => updateScore("task", t.id, s)} />
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {/* Reply drafter modal */}
      {replyTo && (
        <ReplyDrafter
          message={replyTo.text}
          personName={replyTo.personName}
          personEmail={replyTo.personEmail}
          channel="Webex"
          roomId={replyTo.roomId}
          onClose={() => setReplyTo(null)}
        />
      )}
    </div>
  );
}
