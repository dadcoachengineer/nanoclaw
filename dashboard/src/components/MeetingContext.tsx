"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/Card";
import { fmt12, timeAgo } from "@/lib/dates";
import { WebexMeeting } from "@/lib/webex";

interface ContextData {
  match?: { name: string; emails: string[] } | null;
  directMessages?: { text: string; from: string; created: string }[];
  recentMeetings?: { topic: string; date: string; role: string }[];
  transcriptSnippets?: {
    topic: string;
    date: string;
    snippetCount: number;
    snippets: string[];
  }[];
  relatedTasks?: { id: string; title: string; status: string }[];
  stats?: {
    totalMeetings: number;
    totalTranscripts: number;
    totalMessages: number;
    totalTasks: number;
  };
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

  const hostEmail = meeting.hostEmail || "";
  const hostName = meeting.hostDisplayName || "";

  // Extract person name from meeting title
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

  const personEmail = hostEmail !== "jasheare@cisco.com" ? hostEmail : "";

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

  const matched = context?.match;
  const stats = context?.stats;
  const hasData =
    context &&
    ((context.directMessages?.length || 0) > 0 ||
      (context.recentMeetings?.length || 0) > 0 ||
      (context.transcriptSnippets?.length || 0) > 0 ||
      (context.relatedTasks?.length || 0) > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative w-[520px] h-full bg-[var(--bg)] border-l border-[var(--border)] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-[var(--bg)] border-b border-[var(--border)] px-5 py-4 z-10">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-[var(--text-bright)]">
                {meeting.title}
              </h2>
              <div className="text-sm text-[var(--text-dim)] mt-1">
                {fmt12(meeting.start)} - {fmt12(meeting.end)}
              </div>
              {matched && (
                <div className="mt-2">
                  <span className="text-sm text-[var(--accent)] font-medium">
                    {matched.name}
                  </span>
                  {matched.emails[0] && (
                    <span className="text-xs text-[var(--text-dim)] ml-2">
                      {matched.emails[0]}
                    </span>
                  )}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-[var(--text-dim)] hover:text-[var(--text)] text-lg px-2"
            >
              &times;
            </button>
          </div>

          {/* Stats bar */}
          {stats && (stats.totalMeetings + stats.totalTranscripts + stats.totalMessages + stats.totalTasks > 0) && (
            <div className="flex gap-4 mt-3 pt-3 border-t border-[var(--border)]">
              <div className="text-center">
                <div className="text-lg font-bold text-[var(--accent)]">{stats.totalMeetings}</div>
                <div className="text-[10px] text-[var(--text-dim)] uppercase">Meetings</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-[var(--purple)]">{stats.totalTranscripts}</div>
                <div className="text-[10px] text-[var(--text-dim)] uppercase">Transcripts</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-[var(--green)]">{stats.totalMessages}</div>
                <div className="text-[10px] text-[var(--text-dim)] uppercase">Messages</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-[var(--yellow)]">{stats.totalTasks}</div>
                <div className="text-[10px] text-[var(--text-dim)] uppercase">Tasks</div>
              </div>
            </div>
          )}
        </div>

        <div className="p-5 space-y-5">
          {loading && (
            <div className="text-center text-[var(--text-dim)] py-8">
              Loading context...
            </div>
          )}

          {!loading && !hasData && (
            <div className="text-center text-[var(--text-dim)] py-8 italic">
              No cross-platform context found
            </div>
          )}

          {/* Transcript Snippets — what they actually said */}
          {context?.transcriptSnippets && context.transcriptSnippets.length > 0 && (
            <Card>
              <CardHeader title="What They Said (Transcripts)" />
              <div>
                {context.transcriptSnippets.map((t, i) => (
                  <div key={i} className="px-4 py-3 border-b border-[var(--border)] last:border-0">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-[var(--purple)]">
                        {t.topic.slice(0, 50)}
                      </span>
                      <span className="text-xs text-[var(--text-dim)]">
                        {new Date(t.date).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </div>
                    {t.snippets.map((s, j) => (
                      <div
                        key={j}
                        className="text-sm text-[var(--text)] bg-[var(--surface2)] rounded px-3 py-1.5 mb-1 italic"
                      >
                        &ldquo;{s}&rdquo;
                      </div>
                    ))}
                    {t.snippetCount > t.snippets.length && (
                      <div className="text-xs text-[var(--text-dim)] mt-1">
                        +{t.snippetCount - t.snippets.length} more lines in this meeting
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Recent Messages */}
          {context?.directMessages && context.directMessages.length > 0 && (
            <Card>
              <CardHeader title="Recent Messages" />
              <div>
                {context.directMessages.map((m, i) => (
                  <div
                    key={i}
                    className="px-4 py-2.5 border-b border-[var(--border)] last:border-0"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-[var(--accent)]">
                        {m.from === "jasheare@cisco.com" ? "You" : matched?.name || personName}
                      </span>
                      <span className="text-xs text-[var(--text-dim)]">
                        {timeAgo(m.created)}
                      </span>
                    </div>
                    <div className="text-sm text-[var(--text)]">{m.text}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Meeting History */}
          {context?.recentMeetings && context.recentMeetings.length > 0 && (
            <Card>
              <CardHeader title="Meeting History" />
              <div>
                {context.recentMeetings.map((m, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0"
                  >
                    <div
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{
                        background: m.role === "host" ? "var(--yellow)" : "var(--purple)",
                      }}
                    />
                    <span className="text-sm flex-1">{m.topic.slice(0, 60)}</span>
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

          {/* Related Tasks */}
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
        </div>
      </div>
    </div>
  );
}
