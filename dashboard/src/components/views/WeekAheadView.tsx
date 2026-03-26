"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, StatCard, GroupHeader } from "@/components/Card";
import TaskItem from "@/components/TaskItem";
import MeetingItem from "@/components/MeetingItem";
import { NotionPage, queryNotion } from "@/lib/notion";
import { WebexMeeting, fetchMeetings, meetingDurationHours } from "@/lib/webex";
import { isoDate, addDays, startOfWeek, DAYS, fmt12, SHORT_DAYS } from "@/lib/dates";

export default function WeekAheadView() {
  const [meetings, setMeetings] = useState<WebexMeeting[]>([]);
  const [carryover, setCarryover] = useState<NotionPage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const now = new Date();
      const monday = startOfWeek(now);
      // If Fri-Sun, show next week; otherwise show this week
      const target = now.getDay() >= 5 || now.getDay() === 0
        ? addDays(monday, 7) : monday;
      const friday = addDays(target, 4);

      const [mtgData, taskData] = await Promise.all([
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

      setMeetings(mtgData);
      setCarryover(taskData);
      setLoading(false);
    }
    load();
  }, []);

  const now = new Date();
  const monday = startOfWeek(now);
  const target = now.getDay() >= 5 || now.getDay() === 0
    ? addDays(monday, 7) : monday;

  const totalHours = meetings.reduce((s, m) => s + meetingDurationHours(m), 0);
  const hosted = meetings.filter((m) => m.hostEmail === "jasheare@cisco.com");

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard value={meetings.length} label="Meetings" color="var(--accent)" />
        <StatCard value={`${Math.round(totalHours)}h`} label="Meeting Hours" color="var(--yellow)" />
        <StatCard value={carryover.length} label="Carryover Tasks" color="var(--orange)" />
        <StatCard value={hosted.length} label="Hosting" color="var(--purple)" />
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
            const dayHours = dayMtgs.reduce(
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
                    dayMtgs.map((m) => <MeetingItem key={m.id} meeting={m} />)
                  )}
                </div>
              </Card>
            );
          })}
        </div>

        {/* Right: Prep + Carryover */}
        <div className="space-y-6">
          <Card>
            <CardHeader title="Prep Needed" />
            <div>
              {hosted.length === 0 ? (
                <div className="p-4 text-center text-[var(--text-dim)] italic text-sm">
                  No prep needed
                </div>
              ) : (
                hosted.slice(0, 10).map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)]"
                  >
                    <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--accent)]" />
                    <span className="text-[13px] text-[var(--text-dim)] w-16 shrink-0">
                      {SHORT_DAYS[new Date(m.start).getDay()]} {fmt12(m.start)}
                    </span>
                    <div className="flex-1 text-sm">
                      {m.title}
                      <div className="text-[11px] text-[var(--yellow)]">
                        You&apos;re hosting
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Carryover Tasks" />
            <div>
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
    </div>
  );
}
