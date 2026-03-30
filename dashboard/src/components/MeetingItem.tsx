"use client";

import { WebexMeeting } from "@/lib/webex";
import { fmt12 } from "@/lib/dates";

/** Detect all-day or conference events (6+ hours) */
export function isAllDay(m: WebexMeeting): boolean {
  const ms = new Date(m.end).getTime() - new Date(m.start).getTime();
  return ms >= 6 * 60 * 60 * 1000;
}

/** Duration in minutes */
function durationMin(m: WebexMeeting): number {
  return (new Date(m.end).getTime() - new Date(m.start).getTime()) / 60000;
}

/** Time in minutes since midnight (local) */
function minuteOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** Detect overlapping meetings */
export function findConflicts(meetings: WebexMeeting[]): Set<string> {
  const timed = meetings.filter((m) => !isAllDay(m) && m.state !== "missed");
  const conflicts = new Set<string>();
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[i].start < timed[j].end && timed[j].start < timed[i].end) {
        conflicts.add(timed[i].id);
        conflicts.add(timed[j].id);
      }
    }
  }
  return conflicts;
}

// Working hours: 7am–6pm local time
const WORK_START_HOUR = 7;
const WORK_END_HOUR = 18;

/** Clamp a date to working hours. Returns null if entirely outside. */
function clampToWorkHours(start: Date, end: Date): { start: Date; end: Date } | null {
  const dayStart = new Date(start);
  dayStart.setHours(WORK_START_HOUR, 0, 0, 0);
  const dayEnd = new Date(start);
  dayEnd.setHours(WORK_END_HOUR, 0, 0, 0);

  const clampedStart = start < dayStart ? dayStart : start;
  const clampedEnd = end > dayEnd ? dayEnd : end;

  if (clampedStart >= clampedEnd) return null;
  return { start: clampedStart, end: clampedEnd };
}

/** Find gaps ≥ 30min between meetings (within working hours only) */
export function findGaps(meetings: WebexMeeting[]): { after: string; minutes: number; start: string; end: string }[] {
  const timed = meetings
    .filter((m) => !isAllDay(m) && m.state !== "missed")
    .sort((a, b) => a.start.localeCompare(b.start));
  const gaps: { after: string; minutes: number; start: string; end: string }[] = [];
  for (let i = 0; i < timed.length - 1; i++) {
    const clamped = clampToWorkHours(new Date(timed[i].end), new Date(timed[i + 1].start));
    if (!clamped) continue;
    const gapMin = (clamped.end.getTime() - clamped.start.getTime()) / 60000;
    if (gapMin >= 30) {
      gaps.push({
        after: timed[i].id,
        minutes: gapMin,
        start: clamped.start.toISOString(),
        end: clamped.end.toISOString(),
      });
    }
  }
  return gaps;
}

/** Generate schedule insights */
export function scheduleInsights(meetings: WebexMeeting[]): string[] {
  const timed = meetings.filter((m) => !isAllDay(m) && m.state !== "missed");
  const insights: string[] = [];

  // Conflict count
  const conflicts = findConflicts(meetings);
  if (conflicts.size > 0) {
    insights.push(`⚠️ ${conflicts.size / 2} overlapping meetings — consider declining or rescheduling one`);
  }

  // Back-to-back streaks (3+ meetings with no gap)
  let streak = 1;
  const sorted = [...timed].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    const gap = (new Date(sorted[i].start).getTime() - new Date(sorted[i - 1].end).getTime()) / 60000;
    if (gap < 10) {
      streak++;
      if (streak >= 3) {
        const startTime = fmt12(sorted[i - streak + 1].start);
        const endTime = fmt12(sorted[i].end);
        insights.push(`🔥 ${streak} back-to-back meetings ${startTime}–${endTime}`);
      }
    } else {
      streak = 1;
    }
  }

  // Total meeting hours
  const totalMin = timed.reduce((s, m) => s + durationMin(m), 0);
  if (totalMin > 6 * 60) {
    insights.push(`📊 ${Math.round(totalMin / 60)}h of meetings — consider protecting a focus block`);
  }

  // Largest free block
  const gaps = findGaps(meetings);
  if (gaps.length > 0) {
    const largest = gaps.reduce((a, b) => (a.minutes > b.minutes ? a : b));
    if (largest.minutes >= 60) {
      insights.push(`💡 Largest free block: ${Math.round(largest.minutes / 60)}h ${largest.minutes % 60 > 0 ? `${largest.minutes % 60}m` : ""} (${fmt12(largest.start)}–${fmt12(largest.end)})`);
    }
  } else if (timed.length > 0) {
    insights.push("⚡ No gaps ≥30min — solid wall of meetings");
  }

  return insights;
}

export default function MeetingItem({
  meeting,
  onClick,
  isConflict,
  gap,
  prepArtifact,
  onPrepClick,
}: {
  meeting: WebexMeeting;
  onClick?: (meeting: WebexMeeting) => void;
  isConflict?: boolean;
  gap?: { minutes: number; start: string; end: string } | null;
  prepArtifact?: { id: string; title: string } | null;
  onPrepClick?: (artifactId: string) => void;
}) {
  const isActive = meeting.state === "inProgress";
  const isMissed = meeting.state === "missed";
  const allDay = isAllDay(meeting);

  return (
    <>
      {/* All-day / conference banner */}
      {allDay ? (
        <div
          className={`flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[rgba(188,140,255,0.06)] ${
            onClick ? "cursor-pointer hover:bg-[rgba(188,140,255,0.1)]" : ""
          }`}
          onClick={() => onClick?.(meeting)}
        >
          <span className="text-[10px] uppercase tracking-wider text-[var(--purple)] bg-[rgba(188,140,255,0.15)] px-2 py-0.5 rounded-full shrink-0 font-medium">
            All Day
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--purple)]">
              {meeting.title}
            </div>
            <div className="flex items-center gap-2">
              {meeting.hostDisplayName && meeting.hostEmail !== "jasheare@cisco.com" && (
                <span className="text-[11px] text-[var(--text-dim)]">{meeting.hostDisplayName}</span>
              )}
              {meeting.source === "google" && meeting.calendarName && (
                <span className="text-[9px] uppercase tracking-wider text-[var(--green)] bg-[rgba(63,185,80,0.12)] px-1.5 py-0.5 rounded-full">
                  {meeting.calendarName}
                </span>
              )}
            </div>
          </div>
          {onClick && <div className="text-[var(--text-dim)] text-xs shrink-0">›</div>}
        </div>
      ) : (
        /* Regular timed meeting */
        <div
          className={`flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] ${
            isConflict ? "border-l-2 border-l-[var(--red)]" : ""
          } ${onClick ? "cursor-pointer hover:bg-[rgba(88,166,255,0.06)]" : ""}`}
          onClick={() => onClick?.(meeting)}
        >
          <div
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              background: isActive ? "var(--green)" : isConflict ? "var(--red)" : "var(--accent)",
            }}
          />
          <div className="text-[13px] text-[var(--text-dim)] w-[110px] shrink-0 tabular-nums">
            {fmt12(meeting.start)} - {fmt12(meeting.end)}
          </div>
          <div className="flex-1 min-w-0">
            <div
              className={`text-sm ${
                isActive
                  ? "text-[var(--green)] font-medium"
                  : isMissed
                  ? "text-[var(--text-dim)] line-through"
                  : isConflict
                  ? "text-[var(--red)]"
                  : "text-[var(--text)]"
              }`}
            >
              {meeting.title}
            </div>
            <div className="flex items-center gap-2">
              {meeting.hostDisplayName && meeting.hostEmail !== "jasheare@cisco.com" && (
                <span className="text-[11px] text-[var(--text-dim)]">{meeting.hostDisplayName}</span>
              )}
              {meeting.source === "google" && meeting.calendarName && (
                <span className="text-[9px] uppercase tracking-wider text-[var(--green)] bg-[rgba(63,185,80,0.12)] px-1.5 py-0.5 rounded-full">
                  {meeting.calendarName}
                </span>
              )}
              {meeting.location && (
                <span className="text-[10px] text-[var(--text-dim)] truncate max-w-[120px]" title={meeting.location}>
                  {meeting.location}
                </span>
              )}
              {prepArtifact && (
                <button
                  onClick={(e) => { e.stopPropagation(); onPrepClick?.(prepArtifact.id); }}
                  className="text-[9px] px-1.5 py-0.5 rounded-full bg-[rgba(63,185,80,0.12)] text-[var(--green)] font-medium hover:bg-[rgba(63,185,80,0.2)] transition-colors"
                  title={prepArtifact.title}
                >
                  Prep
                </button>
              )}
            </div>
          </div>
          {onClick && <div className="text-[var(--text-dim)] text-xs shrink-0">›</div>}
        </div>
      )}

      {/* Gap indicator after this meeting */}
      {gap && (
        <div className="flex items-center gap-3 px-4 py-1.5 border-b border-[var(--border)] bg-[rgba(63,185,80,0.04)]">
          <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--green)] opacity-40" />
          <span className="text-[11px] text-[var(--green)] opacity-70 italic">
            {gap.minutes >= 60
              ? `${Math.floor(gap.minutes / 60)}h${gap.minutes % 60 > 0 ? ` ${gap.minutes % 60}m` : ""} free`
              : `${gap.minutes}m free`}
            {" "}({fmt12(gap.start)} – {fmt12(gap.end)})
          </span>
        </div>
      )}
    </>
  );
}
