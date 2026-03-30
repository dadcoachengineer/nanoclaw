"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, StatCard, GroupHeader } from "@/components/Card";
import TaskItem from "@/components/TaskItem";
import MeetingItem from "@/components/MeetingItem";
import MeetingPrep from "@/components/MeetingPrep";
import PrepWorkspace from "@/components/PrepWorkspace";
import { NotionPage, queryNotion } from "@/lib/notion";
import { WebexMeeting, fetchMeetings, meetingDurationHours, timedMeetings } from "@/lib/webex";
import { isoDate, addDays, startOfWeek, DAYS, fmt12, SHORT_DAYS } from "@/lib/dates";

interface PrepArtifact {
  id: string;
  title: string;
  createdAt: string;
}

export default function WeekAheadView() {
  const [meetings, setMeetings] = useState<WebexMeeting[]>([]);
  const [carryover, setCarryover] = useState<NotionPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMeeting, setSelectedMeeting] = useState<WebexMeeting | null>(null);
  const [prepMeeting, setPrepMeeting] = useState<WebexMeeting | null>(null);
  const [prepArtifacts, setPrepArtifacts] = useState<Record<string, PrepArtifact>>({});
  const [viewingArtifact, setViewingArtifact] = useState<{ id: string; content: string } | null>(null);

  useEffect(() => {
    async function load() {
      const now = new Date();
      const monday = startOfWeek(now);
      // If Fri-Sun, show next week; otherwise show this week
      const target = now.getDay() >= 5 || now.getDay() === 0
        ? addDays(monday, 7) : monday;
      const friday = addDays(target, 4);

      const [mtgResult, taskResult] = await Promise.allSettled([
        fetchMeetings(`${isoDate(target)}T00:00:00Z`, `${isoDate(friday)}T23:59:59Z`),
        queryNotion({
          and: [
            { property: "Status", status: { does_not_equal: "Done" } },
            {
              or: [
                { property: "Priority", select: { equals: "P0 \u2014 Today" } },
                { property: "Priority", select: { equals: "P1 \u2014 This Week" } },
              ],
            },
          ],
        }),
      ]);

      if (mtgResult.status === "fulfilled") setMeetings(mtgResult.value);
      if (taskResult.status === "fulfilled") setCarryover(taskResult.value);
      setLoading(false);

      // Check which meetings have prep artifacts
      try {
        const artResp = await fetch("/api/artifacts");
        const arts = await artResp.json();
        if (Array.isArray(arts)) {
          const map: Record<string, PrepArtifact> = {};
          for (const a of arts) {
            if (a.intent?.toLowerCase().includes("meeting prep") && a.title) {
              // Match artifact to meeting by title substring
              const mtgs = mtgResult.status === "fulfilled" ? mtgResult.value : [];
              for (const m of mtgs) {
                const meetingWords = m.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
                const matchCount = meetingWords.filter((w: string) => a.title.toLowerCase().includes(w)).length;
                if (matchCount >= 2 || a.title.toLowerCase().includes(m.title.toLowerCase().slice(0, 20))) {
                  map[m.id] = { id: a.id, title: a.title, createdAt: a.createdAt };
                }
              }
            }
          }
          setPrepArtifacts(map);
        }
      } catch {}
    }
    load();
  }, []);

  const now = new Date();
  const monday = startOfWeek(now);
  const target = now.getDay() >= 5 || now.getDay() === 0
    ? addDays(monday, 7) : monday;

  const timed = timedMeetings(meetings);
  const totalHours = timed.reduce((s, m) => s + meetingDurationHours(m), 0);
  const hosted = meetings.filter((m) => m.hostEmail === "jasheare@cisco.com");
  const prepped = hosted.filter((m) => prepArtifacts[m.id]);
  const unprepped = hosted.filter((m) => !prepArtifacts[m.id]);

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard value={meetings.length} label="Meetings" color="var(--accent)" />
        <StatCard value={`${Math.round(totalHours)}h`} label="Meeting Hours" color="var(--yellow)" />
        <StatCard value={carryover.length} label="Carryover Tasks" color="var(--orange)" />
        <StatCard
          value={`${prepped.length}/${hosted.length}`}
          label="Prepped / Hosting"
          color={unprepped.length === 0 ? "var(--green)" : "var(--purple)"}
        />
      </div>

      <div className="grid grid-cols-[1fr_380px] gap-6">
        {/* Left: Day-by-day calendar */}
        <div className="space-y-4">
          {[0, 1, 2, 3, 4].map((i) => {
            const day = addDays(target, i);
            const dayStr = isoDate(day);
            const dayMtgs = meetings
              .filter((m) => m.start.startsWith(dayStr))
              .sort((a, b) => a.start.localeCompare(b.start));
            const dayTimed = timedMeetings(dayMtgs);
            const dayHours = dayTimed.reduce(
              (s, m) => s + meetingDurationHours(m), 0
            );
            const heavy = dayHours >= 3;

            return (
              <Card key={i}>
                <CardHeader
                  title={`${DAYS[day.getDay()]}, ${day.toLocaleDateString(
                    "en-US",
                    { month: "short", day: "numeric" }
                  )}`}
                  right={
                    <span
                      className="text-xs"
                      style={{ color: heavy ? "var(--red)" : "var(--text-dim)" }}
                    >
                      {Math.round(dayHours * 10) / 10}h meetings
                      {heavy ? " — heavy day" : ""}
                    </span>
                  }
                />
                <div>
                  {dayMtgs.length === 0 ? (
                    <div className="p-3 text-center text-[var(--text-dim)] italic text-sm">
                      No meetings
                    </div>
                  ) : (
                    dayMtgs.map((m) => (
                      <MeetingItem
                        key={m.id}
                        meeting={m}
                        onClick={setSelectedMeeting}
                        prepArtifact={prepArtifacts[m.id] || null}
                        onPrepClick={async (artifactId) => {
                          try {
                            const resp = await fetch(`/api/artifacts?id=${artifactId}`);
                            const data = await resp.json();
                            if (data.content) setViewingArtifact({ id: artifactId, content: data.content });
                          } catch {}
                        }}
                      />
                    ))
                  )}
                </div>
              </Card>
            );
          })}
        </div>

        {/* Right: Prep + Carryover */}
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Prep Needed"
              right={
                unprepped.length > 0 ? (
                  <span className="text-[11px] text-[var(--yellow)]">{unprepped.length} unprepped</span>
                ) : hosted.length > 0 ? (
                  <span className="text-[11px] text-[var(--green)]">All prepped</span>
                ) : null
              }
            />
            <div>
              {hosted.length === 0 ? (
                <div className="p-4 text-center text-[var(--text-dim)] italic text-sm">
                  Not hosting any meetings this week
                </div>
              ) : (
                hosted.map((m) => {
                  const hasPrep = !!prepArtifacts[m.id];
                  return (
                    <div
                      key={m.id}
                      className={`flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] ${
                        !hasPrep ? "hover:bg-[rgba(88,166,255,0.03)] cursor-pointer" : ""
                      }`}
                      onClick={() => !hasPrep && setPrepMeeting(m)}
                    >
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: hasPrep ? "var(--green)" : "var(--yellow)" }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-[var(--text)]">{m.title}</div>
                        <div className="text-[11px] text-[var(--text-dim)]">
                          {SHORT_DAYS[new Date(m.start).getDay()]} {fmt12(m.start)}
                        </div>
                      </div>
                      {hasPrep ? (
                        <span className="text-[10px] text-[var(--green)] shrink-0">Prepped</span>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setPrepMeeting(m); }}
                          className="text-[11px] px-2 py-1 rounded text-[var(--accent)] hover:bg-[rgba(88,166,255,0.08)] font-medium shrink-0 transition-colors"
                        >
                          Prep Now
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Carryover Tasks" />
            <div className="max-h-[40vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {loading ? (
                <div className="p-4 text-center text-[var(--text-dim)]">
                  Loading...
                </div>
              ) : carryover.length === 0 ? (
                <div className="p-4 text-center text-[var(--text-dim)] italic text-sm">
                  No carryover
                </div>
              ) : (
                carryover.map((t) => <TaskItem key={t.id} page={t} />)
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Meeting Prep slide-over (existing person context view) */}
      {selectedMeeting && (
        <MeetingPrep
          meeting={selectedMeeting}
          onClose={() => setSelectedMeeting(null)}
        />
      )}

      {/* Artifact viewer */}
      {viewingArtifact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setViewingArtifact(null)} />
          <div className="relative w-[600px] max-h-[80vh] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
              <h2 className="text-sm font-semibold text-[var(--text-bright)]">Meeting Prep</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => { try { await navigator.clipboard.writeText(viewingArtifact.content); } catch {} }}
                  className="text-[11px] text-[var(--accent)] hover:underline"
                >
                  Copy
                </button>
                <button onClick={() => setViewingArtifact(null)} className="text-[var(--text-dim)] hover:text-[var(--text)] text-lg leading-none">&times;</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 text-sm text-[var(--text)] leading-relaxed space-y-2">
              {viewingArtifact.content.split("\n").map((line, i) => {
                if (line.startsWith("---") || line.match(/^(title|intent|created|taskId|taskTitle|project|sources|mentionedPeople):/)) return null;
                if (line.startsWith("### ")) return <h3 key={i} className="text-xs font-bold text-[var(--text-bright)] mt-4 mb-1">{line.replace("### ", "")}</h3>;
                if (line.startsWith("## ")) return <h2 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-4 mb-1">{line.replace("## ", "")}</h2>;
                if (line.startsWith("# ")) return <h2 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-4 mb-1">{line.replace("# ", "")}</h2>;
                if (line.startsWith("- ") || line.startsWith("* ")) return <div key={i} className="flex gap-2 text-xs"><span className="text-[var(--text-dim)] shrink-0">&bull;</span><span>{line.slice(2)}</span></div>;
                if (line.match(/^\d+\.\s/)) return <div key={i} className="flex gap-2 text-xs"><span className="text-[var(--accent)] shrink-0 w-4 text-right">{line.match(/^(\d+)\./)?.[1]}.</span><span>{line.replace(/^\d+\.\s/, "")}</span></div>;
                if (line.startsWith("> ")) return <div key={i} className="border-l-2 border-[var(--accent)] pl-3 text-xs italic text-[var(--text-dim)]">{line.slice(2)}</div>;
                if (!line.trim()) return <div key={i} className="h-2" />;
                return <p key={i} className="text-xs">{line}</p>;
              })}
            </div>
          </div>
        </div>
      )}

      {/* Research Workspace for meeting prep */}
      {prepMeeting && (
        <PrepWorkspace
          topic={`Meeting prep: ${prepMeeting.title}`}
          taskNotes={`Meeting: ${prepMeeting.title}\nDate: ${new Date(prepMeeting.start).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at ${fmt12(prepMeeting.start)}\nHost: ${prepMeeting.hostDisplayName || "You"}${prepMeeting.hostEmail ? ` (${prepMeeting.hostEmail})` : ""}`}
          project="Cisco"
          intent="Meeting prep"
          onClose={() => {
            setPrepMeeting(null);
            // Refresh prep artifacts
            fetch("/api/artifacts").then((r) => r.json()).then((arts) => {
              if (!Array.isArray(arts)) return;
              const map: Record<string, PrepArtifact> = {};
              for (const a of arts) {
                if (!a.intent?.toLowerCase().includes("meeting prep")) continue;
                for (const m of meetings) {
                  const words = m.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
                  const matchCount = words.filter((w: string) => a.title.toLowerCase().includes(w)).length;
                  if (matchCount >= 2 || a.title.toLowerCase().includes(m.title.toLowerCase().slice(0, 20))) {
                    map[m.id] = { id: a.id, title: a.title, createdAt: a.createdAt };
                  }
                }
              }
              setPrepArtifacts(map);
            }).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
