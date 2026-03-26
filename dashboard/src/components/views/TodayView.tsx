"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, StatCard, GroupHeader } from "@/components/Card";
import TaskItem from "@/components/TaskItem";
import MeetingItem, { findConflicts, findGaps, scheduleInsights, isAllDay } from "@/components/MeetingItem";
import MeetingPrep from "@/components/MeetingPrep";
import TaskDetail from "@/components/TaskDetail";
import { NotionPage, prop, priorityRank, queryNotion } from "@/lib/notion";
import { WebexMeeting, fetchMeetings } from "@/lib/webex";
import { isoDate, timeAgo } from "@/lib/dates";
import { NOTION_DB } from "@/lib/notion";

/** Check if a task is a briefing/prep page (not an actionable task) */
function isBriefingPage(page: NotionPage): boolean {
  const title = prop(page, "Task") || prop(page, "Name") || "";
  return /daily briefing|meeting prep|weekly review|transcript summary/i.test(title);
}

/** Extract plain text from Notion rich_text */
function richText(rt: { plain_text: string }[] | undefined): string {
  return (rt || []).map((t) => t.plain_text).join("");
}

interface RunLog {
  task_id: string;
  run_at: string;
  status: string;
  result?: string;
}

export default function TodayView() {
  const [tasks, setTasks] = useState<NotionPage[]>([]);
  const [meetings, setMeetings] = useState<WebexMeeting[]>([]);
  const [runs, setRuns] = useState<RunLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<WebexMeeting | null>(null);
  const [selectedTask, setSelectedTask] = useState<NotionPage | null>(null);
  const [briefingBlocks, setBriefingBlocks] = useState<any[] | null>(null);
  const [briefingUrl, setBriefingUrl] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      // Use local midnight boundaries (not UTC) so the calendar matches the user's day
      const now = new Date();
      const localStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const localEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

      // Fetch today's briefing page
      const todayStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      fetch("/api/notion/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          database_id: NOTION_DB,
          filter: { and: [
            { property: "Task", title: { contains: "Daily Briefing" } },
            { property: "Task", title: { contains: todayStr.split(",")[0] } },
          ]},
          page_size: 1,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          const page = data.results?.[0];
          if (page) {
            setBriefingUrl(page.url);
            return fetch(`/api/notion/blocks?page_id=${page.id}`).then((r) => r.json());
          }
          return null;
        })
        .then((data) => { if (data?.blocks) setBriefingBlocks(data.blocks); })
        .catch(() => {});

      // Fetch independently so one failure doesn't block the others
      const [taskResult, mtgResult, runResult] = await Promise.allSettled([
        queryNotion({
          and: [
            { property: "Status", status: { does_not_equal: "Done" } },
            {
              or: [
                { property: "Priority", select: { equals: "P0 \u2014 Today" } },
                { property: "Priority", select: { equals: "P1 \u2014 This Week" } },
                { property: "Priority", select: { equals: "P2 \u2014 This Month" } },
              ],
            },
          ],
        }),
        fetchMeetings(localStart.toISOString(), localEnd.toISOString()),
        fetch(`/api/system?path=${encodeURIComponent("/api/runs/recent?limit=10")}`).then((r) =>
          r.json()
        ),
      ]);

      const errors: string[] = [];
      if (taskResult.status === "fulfilled") {
        setTasks(taskResult.value.sort((a: NotionPage, b: NotionPage) => priorityRank(prop(a, "Priority")) - priorityRank(prop(b, "Priority"))));
      } else {
        errors.push(`Tasks: ${taskResult.reason}`);
      }
      if (mtgResult.status === "fulfilled") {
        setMeetings(mtgResult.value.sort((a: WebexMeeting, b: WebexMeeting) => a.start.localeCompare(b.start)));
      } else {
        errors.push(`Calendar: ${mtgResult.reason}`);
      }
      if (runResult.status === "fulfilled") {
        setRuns(runResult.value);
      } else {
        errors.push(`Runs: ${runResult.reason}`);
      }
      if (errors.length > 0) setError(errors.join(" | "));
      setLoading(false);
    }
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  // Filter out briefing/prep pages from actionable tasks
  const actionableTasks = tasks.filter((t) => !isBriefingPage(t));
  const p0 = actionableTasks.filter((t) => prop(t, "Priority").includes("P0"));
  const p1 = actionableTasks.filter((t) => prop(t, "Priority").includes("P1"));
  const p2 = actionableTasks.filter((t) => prop(t, "Priority").includes("P2"));
  const activeMeetings = meetings.filter((m) => m.state !== "missed");

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      {error && (
        <div className="mb-4 p-3 bg-[rgba(248,81,73,0.1)] border border-[var(--red)] rounded-lg text-sm text-[var(--red)]">
          {error}
        </div>
      )}
      {/* Daily Briefing */}
      <Card>
        <div className="px-5 py-4">
          {/* Compact stat bar */}
          <div className="flex items-center gap-6 mb-3">
            <span className="text-sm font-semibold text-[var(--text-bright)]">Daily Briefing</span>
            <div className="flex items-center gap-4 text-xs">
              <span><span className="font-bold text-[var(--red)]">{p0.length}</span> <span className="text-[var(--text-dim)]">P0</span></span>
              <span><span className="font-bold text-[var(--orange)]">{p1.length}</span> <span className="text-[var(--text-dim)]">P1</span></span>
              <span><span className="font-bold text-[var(--accent)]">{activeMeetings.length}</span> <span className="text-[var(--text-dim)]">meetings</span></span>
              <span><span className="font-bold text-[var(--text-dim)]">{actionableTasks.length}</span> <span className="text-[var(--text-dim)]">open</span></span>
            </div>
            {briefingUrl && (
              <a href={briefingUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-[var(--accent)] hover:underline ml-auto">
                Open in Notion ↗
              </a>
            )}
          </div>

          {/* Briefing content */}
          {briefingBlocks && briefingBlocks.length > 0 ? (
            <div className="max-h-[180px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden bg-[var(--bg)] rounded-lg px-4 py-3 space-y-1">
              {briefingBlocks.map((block, i) => {
                const type = block.type;
                if (type === "heading_1") return <div key={i} className="text-xs font-bold text-[var(--text-bright)] mt-2">{richText(block.heading_1?.rich_text)}</div>;
                if (type === "heading_2") return <div key={i} className="text-xs font-bold text-[var(--text)] mt-1.5">{richText(block.heading_2?.rich_text)}</div>;
                if (type === "heading_3") return <div key={i} className="text-xs font-semibold text-[var(--text)] mt-1">{richText(block.heading_3?.rich_text)}</div>;
                if (type === "callout") return (
                  <div key={i} className="text-xs bg-[rgba(88,166,255,0.06)] rounded px-2 py-1.5 my-1">
                    <span>{block.callout?.icon?.emoji || "💡"} </span>
                    <span className="text-[var(--text)]">{richText(block.callout?.rich_text)}</span>
                  </div>
                );
                if (type === "to_do") {
                  const checked = block.to_do?.checked;
                  return (
                    <div key={i} className="flex items-start gap-1.5 text-xs">
                      <span className={checked ? "text-[var(--green)]" : "text-[var(--text-dim)]"}>{checked ? "☑" : "☐"}</span>
                      <span className={checked ? "text-[var(--text-dim)] line-through" : "text-[var(--text)]"}>{richText(block.to_do?.rich_text)}</span>
                    </div>
                  );
                }
                if (type === "bulleted_list_item") return (
                  <div key={i} className="flex gap-1.5 text-xs text-[var(--text)]">
                    <span className="text-[var(--text-dim)]">•</span>
                    <span>{richText(block.bulleted_list_item?.rich_text)}</span>
                  </div>
                );
                if (type === "paragraph") {
                  const text = richText(block.paragraph?.rich_text);
                  if (!text) return null;
                  return <p key={i} className="text-xs text-[var(--text)]">{text}</p>;
                }
                if (type === "divider") return <hr key={i} className="border-[var(--border)] my-1" />;
                return null;
              })}
            </div>
          ) : !loading ? (
            <div className="text-xs text-[var(--text-dim)] italic py-2">
              No briefing available yet — the morning agent runs at 7:03 AM
            </div>
          ) : null}
        </div>
      </Card>

      <div className="h-4" />

      {/* Two columns */}
      <div className="grid grid-cols-[1fr_380px] gap-6">
        {/* Left: Tasks */}
        <div>
          <Card>
            <CardHeader
              title="Action Items"
              right={
                <span className="text-xs text-[var(--accent)] bg-[rgba(88,166,255,0.08)] px-2 py-0.5 rounded-full">
                  {actionableTasks.length} open
                </span>
              }
            />
            <div>
              {loading && (
                <div className="p-6 text-center text-[var(--text-dim)]">
                  Loading tasks...
                </div>
              )}
              {error && (
                <div className="p-6 text-center text-[var(--red)] text-sm">
                  {error}
                </div>
              )}
              {!loading && !error && actionableTasks.length === 0 && (
                <div className="p-6 text-center text-[var(--text-dim)] italic">
                  No open tasks
                </div>
              )}
              {p0.length > 0 && (
                <>
                  <GroupHeader title="P0 — Today" />
                  {p0.map((t) => (
                    <TaskItem key={t.id} page={t} onClick={setSelectedTask} />
                  ))}
                </>
              )}
              {p1.length > 0 && (
                <>
                  <GroupHeader title="P1 — This Week" />
                  {p1.map((t) => (
                    <TaskItem key={t.id} page={t} onClick={setSelectedTask} />
                  ))}
                </>
              )}
              {p2.length > 0 && (
                <>
                  <GroupHeader title="P2 — This Month" />
                  {p2.map((t) => (
                    <TaskItem key={t.id} page={t} onClick={setSelectedTask} />
                  ))}
                </>
              )}
            </div>
          </Card>
        </div>

        {/* Right: Calendar + Activity */}
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Today's Calendar"
              right={
                activeMeetings.length > 0 ? (
                  <span className="text-xs text-[var(--text-dim)]">
                    {activeMeetings.length} meetings
                  </span>
                ) : null
              }
            />
            {/* Schedule insights */}
            {(() => {
              const insights = scheduleInsights(meetings);
              return insights.length > 0 ? (
                <div className="px-4 py-2 border-b border-[var(--border)] bg-[rgba(210,153,34,0.04)] space-y-1">
                  {insights.map((text, i) => (
                    <div key={i} className="text-[11px] text-[var(--text-dim)]">{text}</div>
                  ))}
                </div>
              ) : null;
            })()}
            {/* Scrollable meeting list — hidden scrollbar */}
            <div className="max-h-[60vh] overflow-y-auto [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
              {meetings.length === 0 && !loading && (
                <div className="p-6 text-center text-[var(--text-dim)] italic">
                  No meetings today
                </div>
              )}
              {(() => {
                const now = new Date();
                const conflicts = findConflicts(meetings);
                const gaps = findGaps(meetings);
                const sorted = [...meetings].sort((a, b) => a.start.localeCompare(b.start));
                const gapMap = new Map(gaps.map((g) => [g.after, g]));

                const allDay = sorted.filter((m) => isAllDay(m));
                const timed = sorted.filter((m) => !isAllDay(m));
                const upcoming = timed.filter((m) => new Date(m.end) > now);
                const past = timed.filter((m) => new Date(m.end) <= now);

                // Find the next meeting for highlighting
                const nextMeeting = upcoming.find((m) => new Date(m.start) > now);

                return (
                  <>
                    {/* All-day events always shown */}
                    {allDay.map((m) => (
                      <MeetingItem key={m.id} meeting={m} onClick={setSelectedMeeting} />
                    ))}

                    {/* Next up label */}
                    {nextMeeting && upcoming.length > 0 && (
                      <div className="px-4 py-1.5 bg-[rgba(63,185,80,0.06)] border-b border-[var(--border)]">
                        <span className="text-[10px] uppercase tracking-wider text-[var(--green)] font-medium">
                          Up Next
                        </span>
                      </div>
                    )}

                    {/* Upcoming / in-progress meetings */}
                    {upcoming.map((m) => (
                      <MeetingItem
                        key={m.id}
                        meeting={m}
                        onClick={setSelectedMeeting}
                        isConflict={conflicts.has(m.id)}
                        gap={gapMap.get(m.id) || null}
                      />
                    ))}

                    {/* Past meetings — collapsed */}
                    {past.length > 0 && (
                      <details className="group/past">
                        <summary className="px-4 py-1.5 border-b border-[var(--border)] cursor-pointer hover:bg-[rgba(88,166,255,0.03)] list-none">
                          <span className="text-[10px] uppercase tracking-wider text-[var(--text-dim)]">
                            Earlier Today ({past.length})
                            <span className="ml-1 group-open/past:hidden">▸</span>
                            <span className="ml-1 hidden group-open/past:inline">▾</span>
                          </span>
                        </summary>
                        <div className="opacity-60">
                          {past.map((m) => (
                            <MeetingItem
                              key={m.id}
                              meeting={m}
                              onClick={setSelectedMeeting}
                              isConflict={conflicts.has(m.id)}
                            />
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                );
              })()}
            </div>
          </Card>

          <Card>
            <CardHeader title="Recent Agent Activity" />
            <div>
              {(runs || []).map((r, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)]"
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      background:
                        r.status === "success"
                          ? "var(--green)"
                          : "var(--red)",
                    }}
                  />
                  <span className="text-[13px] text-[var(--text-dim)] w-16 shrink-0">
                    {timeAgo(r.run_at)}
                  </span>
                  <span className="text-[13px] truncate">{r.task_id}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Task detail modal */}
      {selectedTask && (
        <TaskDetail
          page={selectedTask}
          onClose={() => setSelectedTask(null)}
          onComplete={(id) => {
            setTasks((prev) => prev.filter((p) => p.id !== id));
            setSelectedTask(null);
          }}
        />
      )}

      {/* Meeting prep slide-over */}
      {selectedMeeting && (
        <MeetingPrep
          meeting={selectedMeeting}
          onClose={() => setSelectedMeeting(null)}
        />
      )}
    </div>
  );
}
