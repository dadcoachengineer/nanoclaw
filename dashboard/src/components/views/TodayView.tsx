"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, StatCard, GroupHeader } from "@/components/Card";
import TaskItem from "@/components/TaskItem";
import MeetingItem from "@/components/MeetingItem";
import MeetingPrep from "@/components/MeetingPrep";
import TaskDetail from "@/components/TaskDetail";
import { NotionPage, prop, priorityRank, queryNotion } from "@/lib/notion";
import { WebexMeeting, fetchMeetings } from "@/lib/webex";
import { isoDate, timeAgo } from "@/lib/dates";

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

  useEffect(() => {
    async function load() {
      const today = isoDate(new Date());

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
        fetchMeetings(`${today}T00:00:00Z`, `${today}T23:59:59Z`),
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

  const p0 = tasks.filter((t) => prop(t, "Priority").includes("P0"));
  const p1 = tasks.filter((t) => prop(t, "Priority").includes("P1"));
  const p2 = tasks.filter((t) => prop(t, "Priority").includes("P2"));
  const activeMeetings = meetings.filter((m) => m.state !== "missed");

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      {/* Debug banner — remove after fixing LAN issue */}
      {error && (
        <div className="mb-4 p-3 bg-[rgba(248,81,73,0.1)] border border-[var(--red)] rounded-lg text-sm text-[var(--red)]">
          {error}
        </div>
      )}
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard value={p0.length} label="P0 Today" color="var(--red)" />
        <StatCard value={p1.length} label="P1 This Week" color="var(--orange)" />
        <StatCard value={activeMeetings.length} label="Meetings" color="var(--accent)" />
        <StatCard value={tasks.length} label="Total Open" color="var(--text-dim)" />
      </div>

      {/* Two columns */}
      <div className="grid grid-cols-[1fr_380px] gap-6">
        {/* Left: Tasks */}
        <div>
          <Card>
            <CardHeader
              title="Action Items"
              right={
                <span className="text-xs text-[var(--accent)] bg-[rgba(88,166,255,0.08)] px-2 py-0.5 rounded-full">
                  {tasks.length} open
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
              {!loading && !error && tasks.length === 0 && (
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
            <CardHeader title="Today's Calendar" />
            <div>
              {meetings.length === 0 && !loading && (
                <div className="p-6 text-center text-[var(--text-dim)] italic">
                  No meetings today
                </div>
              )}
              {meetings.map((m) => (
                <MeetingItem key={m.id} meeting={m} onClick={setSelectedMeeting} />
              ))}
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
