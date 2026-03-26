"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/Card";
import { fmt12, timeAgo } from "@/lib/dates";
import { WebexMeeting } from "@/lib/webex";

interface ContextData {
  directMessages?: { text: string; from: string; created: string }[];
  recentMeetings?: { topic: string; date: string }[];
  relatedTasks?: { id: string; title: string; status: string }[];
  upcomingMeetings?: { title: string; start: string }[];
}

export default function MeetingContext({
  meeting,
  onClose,
}: {
  meeting: WebexMeeting;
  onClose: () => void;
}) {
  const [context, setContext] = useState<ContextData | null>(null);
  const [loading, setLoading] = useState(true);

  // Extract the other person's name/email from meeting title or host
  const hostEmail = meeting.hostEmail || "";
  const hostName = meeting.hostDisplayName || "";

  // For 1:1 meetings, the title often contains the person's name
  // For group meetings, use the host
  const personName =
    meeting.title
      .replace(/&/g, "")
      .replace(/1:1/gi, "")
      .replace(/Jason/gi, "")
      .replace(/Shearer/gi, "")
      .replace(/['']s?\s*(meeting|sync|catch up|check in)/gi, "")
      .replace(/\d{8}/g, "")
      .replace(/[-–]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(",")[0]
      .trim() || hostName;

  const personEmail =
    hostEmail !== "jasheare@cisco.com" ? hostEmail : "";

  useEffect(() => {
    async function load() {
      const params = new URLSearchParams();
      if (personEmail) params.set("email", personEmail);
      if (personName) params.set("name", personName);

      if (!personEmail && !personName) {
        setLoading(false);
        return;
      }

      try {
        const resp = await fetch(`/api/context?${params}`);
        const data = await resp.json();
        setContext(data);
      } catch {
        setContext(null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [personEmail, personName]);

  const hasData =
    context &&
    ((context.directMessages?.length || 0) > 0 ||
      (context.recentMeetings?.length || 0) > 0 ||
      (context.relatedTasks?.length || 0) > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-[480px] h-full bg-[var(--bg)] border-l border-[var(--border)] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-[var(--bg)] border-b border-[var(--border)] px-5 py-4 flex items-start justify-between z-10">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-bright)]">
              {meeting.title}
            </h2>
            <div className="text-sm text-[var(--text-dim)] mt-1">
              {fmt12(meeting.start)} - {fmt12(meeting.end)}
              {personName && (
                <span className="ml-2 text-[var(--accent)]">
                  with {personName}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-dim)] hover:text-[var(--text)] text-lg px-2"
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-5">
          {loading && (
            <div className="text-center text-[var(--text-dim)] py-8">
              Loading context...
            </div>
          )}

          {!loading && !hasData && (
            <div className="text-center text-[var(--text-dim)] py-8 italic">
              No cross-platform context found for this meeting
            </div>
          )}

          {/* Recent 1:1 Messages */}
          {context?.directMessages && context.directMessages.length > 0 && (
            <Card>
              <CardHeader title={`Recent Messages with ${personName}`} />
              <div>
                {context.directMessages.map((m, i) => (
                  <div
                    key={i}
                    className="px-4 py-2.5 border-b border-[var(--border)] last:border-0"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-[var(--accent)]">
                        {m.from === "jasheare@cisco.com" ? "You" : personName}
                      </span>
                      <span className="text-xs text-[var(--text-dim)]">
                        {timeAgo(m.created)}
                      </span>
                    </div>
                    <div className="text-sm text-[var(--text)]">
                      {m.text}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Previous Meetings */}
          {context?.recentMeetings && context.recentMeetings.length > 0 && (
            <Card>
              <CardHeader title="Previous Meetings Together" />
              <div>
                {context.recentMeetings.map((m, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0"
                  >
                    <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--purple)]" />
                    <span className="text-sm flex-1">{m.topic}</span>
                    <span className="text-xs text-[var(--text-dim)]">
                      {new Date(m.date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Related Notion Tasks */}
          {context?.relatedTasks && context.relatedTasks.length > 0 && (
            <Card>
              <CardHeader title="Related Tasks" />
              <div>
                {context.relatedTasks.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0"
                  >
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        t.status === "Done"
                          ? "bg-[rgba(63,185,80,0.15)] text-[var(--green)]"
                          : "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]"
                      }`}
                    >
                      {t.status}
                    </span>
                    <span className="text-sm flex-1">{t.title}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Upcoming Meetings */}
          {context?.upcomingMeetings &&
            context.upcomingMeetings.length > 0 && (
              <Card>
                <CardHeader title="Upcoming Meetings Together" />
                <div>
                  {context.upcomingMeetings.map((m, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0"
                    >
                      <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--accent)]" />
                      <span className="text-sm flex-1">{m.title}</span>
                      <span className="text-xs text-[var(--text-dim)]">
                        {fmt12(m.start)}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
        </div>
      </div>
    </div>
  );
}
