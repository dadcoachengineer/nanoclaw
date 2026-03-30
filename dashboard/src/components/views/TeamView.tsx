"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, StatCard } from "@/components/Card";
import { timeAgo } from "@/lib/dates";
import ArtifactList from "@/components/ArtifactList";
import TaskDetail from "@/components/TaskDetail";
import { NotionPage, queryNotion } from "@/lib/notion";

interface TeamMemberOverview {
  name: string;
  role: string;
  email: string;
  avatar?: string;
  stats: {
    openTasks: number;
    p0Tasks: number;
    meetings: number;
    messages: number;
  };
}

interface MemberDetail {
  name: string;
  role: string;
  email: string;
  avatar?: string;
  jobTitle?: string;
  tasks: {
    id: string;
    title: string;
    priority: string;
    status: string;
    project: string;
    context: string;
    tier?: "delegated" | "tagged" | "mentioned";
  }[];
  stats: { meetings: number; messages: number; transcripts: number; openTasks: number };
  recentMessages: { text: string; date: string }[];
  recentMeetings: { topic: string; date: string }[];
}

function priorityColor(p: string): string {
  if (p.includes("P0")) return "var(--red)";
  if (p.includes("P1")) return "var(--orange)";
  if (p.includes("P2")) return "var(--yellow)";
  return "var(--text-dim)";
}

export default function TeamView() {
  const [team, setTeam] = useState<TeamMemberOverview[]>([]);
  const [selected, setSelected] = useState<MemberDetail | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [memberArtifacts, setMemberArtifacts] = useState<{ id: string; title: string; createdAt: string; charCount: number }[]>([]);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<NotionPage | null>(null);
  const [dismissedTasks, setDismissedTasks] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/team")
      .then((r) => r.json())
      .then((data) => { setTeam(data.team || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function selectMember(name: string, section?: string) {
    setSelectedName(name);
    setSelected(null);
    setMemberArtifacts([]);
    setScrollTo(section || null);
    const [resp, artResp] = await Promise.all([
      fetch(`/api/team?member=${encodeURIComponent(name)}`),
      fetch(`/api/artifacts?person=${encodeURIComponent(name)}`),
    ]);
    const data = await resp.json();
    setSelected(data);
    try {
      const arts = await artResp.json();
      if (Array.isArray(arts)) setMemberArtifacts(arts);
    } catch {}
  }

  const totalTasks = team.reduce((s, m) => s + m.stats.openTasks, 0);
  const totalP0 = team.reduce((s, m) => s + m.stats.p0Tasks, 0);

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard value={team.length} label="Team Members" color="var(--accent)" />
        <StatCard value={totalTasks} label="Open Tasks" color="var(--yellow)" />
        <StatCard value={totalP0} label="P0 — Urgent" color="var(--red)" />
        <StatCard
          value={team.filter((m) => m.stats.openTasks > 10).length}
          label="Overloaded"
          color={team.filter((m) => m.stats.openTasks > 10).length > 0 ? "var(--red)" : "var(--green)"}
        />
      </div>

      <div className="grid grid-cols-[340px_1fr] gap-6">
        {/* Left: Team roster */}
        <div>
          <Card>
            <CardHeader title="My Team" />
            <div>
              {loading ? (
                <div className="p-4 text-center text-[var(--text-dim)]">Loading...</div>
              ) : (
                team.map((m) => (
                  <button
                    key={m.name}
                    onClick={() => selectMember(m.name)}
                    className={`w-full text-left flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] transition-colors ${
                      selectedName === m.name ? "bg-[rgba(88,166,255,0.06)]" : "hover:bg-[rgba(88,166,255,0.03)]"
                    }`}
                  >
                    {m.avatar ? (
                      <img src={m.avatar} className="w-9 h-9 rounded-full shrink-0 object-cover" alt="" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-[rgba(88,166,255,0.12)] flex items-center justify-center text-xs font-bold text-[var(--accent)] shrink-0">
                        {m.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--text)]">{m.name}</div>
                      <div className="text-[10px] text-[var(--text-dim)]">{m.role}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`text-sm font-bold ${m.stats.openTasks > 10 ? "text-[var(--red)]" : m.stats.openTasks > 5 ? "text-[var(--yellow)]" : "text-[var(--green)]"}`}>
                        {m.stats.openTasks}
                      </div>
                      <div className="text-[9px] text-[var(--text-dim)]">tasks</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Right: Member detail */}
        <div className="space-y-4">
          {!selected && !selectedName && (
            <div className="text-center text-[var(--text-dim)] py-12 italic">
              Select a team member to see their workload
            </div>
          )}

          {selectedName && !selected && (
            <div className="text-center text-[var(--text-dim)] py-12 animate-pulse">
              Loading {selectedName}&apos;s data...
            </div>
          )}

          {selected && (
            <>
              {/* Header */}
              <Card>
                <div className="p-4">
                  <div className="flex items-center gap-3">
                    {selected.avatar ? (
                      <img src={selected.avatar} className="w-12 h-12 rounded-full object-cover" alt="" />
                    ) : (
                      <div className="w-12 h-12 rounded-full bg-[rgba(88,166,255,0.12)] flex items-center justify-center text-sm font-bold text-[var(--accent)]">
                        {selected.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div className="text-base font-semibold text-[var(--text-bright)]">{selected.name}</div>
                      <div className="text-xs text-[var(--text-dim)]">{selected.jobTitle || selected.role} &middot; {selected.email}</div>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3 pt-3 border-t border-[var(--border)]">
                    {[
                      { key: "tasks", value: selected.stats.openTasks, label: "Tasks", color: "var(--yellow)" },
                      { key: "meetings", value: selected.stats.meetings, label: "Meetings", color: "var(--accent)" },
                      { key: "messages", value: selected.stats.messages, label: "Messages", color: "var(--green)" },
                      { key: "transcripts", value: selected.stats.transcripts, label: "Transcripts", color: "var(--purple)" },
                      { key: "artifacts", value: memberArtifacts.length, label: "Artifacts", color: "#38b2ac" },
                    ].map((s) => (
                      <button
                        key={s.key}
                        onClick={() => {
                          setScrollTo(s.key);
                          document.getElementById(`team-section-${s.key}`)?.scrollIntoView({ behavior: "smooth" });
                        }}
                        className={`text-center flex-1 py-1.5 rounded-md transition-colors ${
                          scrollTo === s.key ? "bg-[rgba(88,166,255,0.08)]" : "hover:bg-[rgba(88,166,255,0.04)]"
                        }`}
                      >
                        <div className="text-lg font-bold" style={{ color: s.color }}>{s.value}</div>
                        <div className="text-[9px] text-[var(--text-dim)] uppercase tracking-wider">{s.label}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </Card>

              {/* Their task queue */}
              <Card><div id="team-section-tasks" />
                <CardHeader
                  title={`${selected.name.split(" ")[0]}'s Tasks`}
                  right={<span className="text-xs text-[var(--text-dim)]">{selected.tasks.length} open</span>}
                />
                <div className="max-h-[400px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {selected.tasks.length === 0 ? (
                    <div className="p-4 text-center text-[var(--text-dim)] italic text-sm">No delegated tasks</div>
                  ) : (
                    (() => {
                      const visible = selected.tasks.filter((t) => !dismissedTasks.has(`${selectedName}:${t.id}`));
                      let lastTier = "";
                      return visible.map((t) => {
                        const tier = t.tier || "mentioned";
                        const showHeader = tier !== lastTier;
                        lastTier = tier;
                        return (<div key={t.id}>{showHeader && (
                          <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium bg-[var(--bg)] border-b border-[var(--border)]">
                            {tier === "delegated" ? "Delegated" : tier === "tagged" ? "Tagged" : "Mentioned"}
                          </div>
                        )}
                        <div
                          key={t.id}
                          className="group/task flex items-start gap-2 px-4 py-2.5 border-b border-[var(--border)] hover:bg-[rgba(88,166,255,0.03)] cursor-pointer"
                          onClick={async () => {
                            // Fetch full Notion page for the modal
                            try {
                              const resp = await fetch("/api/notion/query", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  database_id: "5b4e1d2d7259496ea237ef0525c3ce78",
                                  filter: { property: "Task", title: { equals: t.title } },
                                  page_size: 1,
                                }),
                              });
                              const data = await resp.json();
                              if (data.results?.[0]) setSelectedTask(data.results[0]);
                            } catch {}
                          }}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-[var(--text)]">{t.title}</div>
                            <div className="flex gap-2 mt-1 flex-wrap">
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{
                                background: `color-mix(in srgb, ${priorityColor(t.priority)} 15%, transparent)`,
                                color: priorityColor(t.priority),
                              }}>
                                {t.priority.split(" ")[0]}
                              </span>
                              {t.context && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[rgba(188,140,255,0.12)] text-[var(--purple)]">
                                  {t.context}
                                </span>
                              )}
                              <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                                (t.tier || "mentioned") === "delegated" ? "bg-[rgba(88,166,255,0.1)] text-[var(--accent)]"
                                : (t.tier || "mentioned") === "tagged" ? "bg-[rgba(56,178,172,0.1)] text-[#38b2ac]"
                                : "bg-[rgba(139,148,158,0.1)] text-[var(--text-dim)]"
                              }`}>
                                {(t.tier || "mentioned") === "delegated" ? "Delegated" : (t.tier || "mentioned") === "tagged" ? "Tagged" : "Mentioned"}
                              </span>
                              {t.project && (
                                <span className="text-[10px] text-[var(--text-dim)]">{t.project}</span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDismissedTasks((prev) => new Set([...prev, `${selectedName}:${t.id}`]));
                            }}
                            className="opacity-0 group-hover/task:opacity-100 text-[var(--text-dim)] hover:text-[var(--red)] text-xs shrink-0 mt-1 transition-opacity"
                            title="Remove from this member's view"
                          >
                            &times;
                          </button>
                        </div>
                      </div>);
                      });
                    })()
                  )}
                </div>
              </Card>

              {/* Recent conversations */}
              {selected.recentMessages.length > 0 && (
                <Card><div id="team-section-messages" />
                  <CardHeader title="Recent Messages" />
                  <div>
                    {selected.recentMessages.map((m, i) => (
                      <div key={i} className="px-4 py-2 border-b border-[var(--border)] last:border-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-[10px] text-[var(--accent)]">{selected.name.split(" ")[0]}</span>
                          <span className="text-[10px] text-[var(--text-dim)]">{timeAgo(m.date)}</span>
                        </div>
                        <div className="text-xs text-[var(--text)] line-clamp-2">{m.text}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Recent meetings */}
              {selected.recentMeetings.length > 0 && (
                <Card><div id="team-section-meetings" />
                  <CardHeader title="Recent Meetings" />
                  <div>
                    {selected.recentMeetings.map((m, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0">
                        <span className="text-[10px] text-[var(--text-dim)] w-16 shrink-0">
                          {new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                        <span className="text-xs text-[var(--text)]">{m.topic}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Artifacts */}
              {memberArtifacts.length > 0 && (
                <Card>
                  <div id="team-section-artifacts" />
                  <CardHeader
                    title="Artifacts"
                    right={<span className="text-xs text-[var(--text-dim)]">{memberArtifacts.length}</span>}
                  />
                  <div className="px-4 py-2">
                    <ArtifactList person={selected.name} label="" />
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {selectedTask && (
        <TaskDetail
          page={selectedTask}
          onClose={() => setSelectedTask(null)}
          onComplete={(id) => {
            if (selected) {
              setSelected({ ...selected, tasks: selected.tasks.filter((t) => t.id !== id) });
            }
            setSelectedTask(null);
          }}
        />
      )}
    </div>
  );
}
