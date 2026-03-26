"use client";

import { WebexMeeting } from "@/lib/webex";
import { fmt12 } from "@/lib/dates";

export default function MeetingItem({ meeting }: { meeting: WebexMeeting }) {
  const isActive = meeting.state === "inProgress";
  const isMissed = meeting.state === "missed";

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)]">
      <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--accent)]" />
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
              : "text-[var(--text)]"
          }`}
        >
          {meeting.title}
        </div>
        {meeting.hostDisplayName &&
          meeting.hostEmail !== "jasheare@cisco.com" && (
            <div className="text-[11px] text-[var(--text-dim)]">
              {meeting.hostDisplayName}
            </div>
          )}
      </div>
    </div>
  );
}
