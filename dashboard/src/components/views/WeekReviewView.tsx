"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, StatCard, GroupHeader } from "@/components/Card";
import TaskItem from "@/components/TaskItem";
import MeetingItem from "@/components/MeetingItem";
import { NotionPage, prop, queryNotion } from "@/lib/notion";
import { WebexMeeting, fetchMeetings, meetingDurationHours } from "@/lib/webex";
import { isoDate, addDays, startOfWeek } from "@/lib/dates";

export default function WeekReviewView() {
  const [meetings, setMeetings] = useState<WebexMeeting[]>([]);
  const [completed, setCompleted] = useState<NotionPage[]>([]);
  const [stillOpen, setStillOpen] = useState<NotionPage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const now = new Date();
      const monday = startOfWeek(now);
      const friday = addDays(monday, 4);

      const [mtgData, doneData, openData] = await Promise.all([
        fetchMeetings(
          `${isoDate(monday)}T00:00:00Z`,
          `${isoDate(friday)}T23:59:59Z`
        ),
        queryNotion({
          and: [
            { property: "Status", status: { equals: "Done" } },
            {
              timestamp: "last_edited_time",
              last_edited_time: { on_or_after: isoDate(monday) },
            },
          ],
        }),
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

      setMeetings(mtgData);
      setCompleted(doneData);
      setStillOpen(openData);
      setLoading(false);
    }
    load();
  }, []);

  const attended = meetings.filter((m) => m.state === "ended");
  const missed = meetings.filter((m) => m.state === "missed");
  const attendedHours = attended.reduce(
    (s, m) => s + meetingDurationHours(m),
    0
  );
  const attendanceRate = meetings.length
    ? Math.round((attended.length / meetings.length) * 100)
    : 0;

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard value={completed.length} label="Completed" color="var(--green)" />
        <StatCard value={stillOpen.length} label="Still Open" color="var(--orange)" />
        <StatCard value={attended.length} label="Attended" color="var(--accent)" />
        <StatCard
          value={missed.length}
          label="Missed"
          color={missed.length > 5 ? "var(--red)" : "var(--text-dim)"}
        />
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <Card>
          <div className="p-4">
            <h3 className="text-xs font-semibold text-[var(--text-dim)] uppercase tracking-wider mb-3">
              Meeting Load
            </h3>
            <div className="space-y-1 text-sm">
              <div>Total scheduled: {meetings.length}</div>
              <div>Hours in meetings: {Math.round(attendedHours)}h</div>
              <div>Attendance rate: {attendanceRate}%</div>
            </div>
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <h3 className="text-xs font-semibold text-[var(--text-dim)] uppercase tracking-wider mb-3">
              Task Throughput
            </h3>
            <div className="space-y-1 text-sm">
              <div className="text-[var(--green)]">
                Completed: {completed.length}
              </div>
              <div className="text-[var(--orange)]">
                Still open: {stillOpen.length}
              </div>
              <div>
                Net:{" "}
                <span
                  style={{
                    color:
                      completed.length >= stillOpen.length
                        ? "var(--green)"
                        : "var(--red)",
                  }}
                >
                  {completed.length >= stillOpen.length ? "+" : ""}
                  {completed.length - stillOpen.length}
                </span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Two columns */}
      <div className="grid grid-cols-[1fr_380px] gap-6">
        {/* Left: Completed */}
        <Card>
          <CardHeader title="Completed This Week" />
          <div>
            {loading ? (
              <div className="p-6 text-center text-[var(--text-dim)]">
                Loading...
              </div>
            ) : completed.length === 0 ? (
              <div className="p-6 text-center text-[var(--text-dim)] italic">
                Nothing completed yet
              </div>
            ) : (
              completed.map((p) => (
                <div
                  key={p.id}
                  className="flex items-start gap-3 px-4 py-2.5 border-b border-[var(--border)]"
                >
                  <div className="flex-1">
                    <div className="text-sm text-[var(--text-dim)] line-through">
                      {prop(p, "Task") || prop(p, "Name")}
                    </div>
                    {prop(p, "Project") && (
                      <span className="text-xs text-[var(--text-dim)]">
                        {prop(p, "Project")}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Right: Open + Meetings */}
        <div className="space-y-6">
          <Card>
            <CardHeader title="Still Open" />
            <div>
              {stillOpen.length === 0 && !loading ? (
                <div className="p-4 text-center text-[var(--text-dim)] italic text-sm">
                  All clear
                </div>
              ) : (
                stillOpen.map((t) => <TaskItem key={t.id} page={t} />)
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Meetings Attended vs Missed" />
            <div>
              {attended.length > 0 && (
                <>
                  <GroupHeader title={`Attended (${attended.length})`} />
                  {attended
                    .sort((a, b) => a.start.localeCompare(b.start))
                    .slice(0, 15)
                    .map((m) => (
                      <MeetingItem key={m.id} meeting={m} />
                    ))}
                </>
              )}
              {missed.length > 0 && (
                <>
                  <GroupHeader title={`Missed (${missed.length})`} />
                  {missed
                    .sort((a, b) => a.start.localeCompare(b.start))
                    .slice(0, 10)
                    .map((m) => (
                      <MeetingItem key={m.id} meeting={m} />
                    ))}
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
