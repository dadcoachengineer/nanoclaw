"use client";

import { useEffect, useState, useCallback } from "react";
import { NotionPage, prop } from "@/lib/notion";
import PrepWorkspace from "@/components/PrepWorkspace";

interface SuggestedAction {
  type: "email" | "webex" | "meeting" | "document" | "subtask";
  label: string;
  to?: string;
  toEmail?: string;
  toRoomId?: string;
  subject?: string;
  body?: string;
  airgapped: boolean;
  reason: string;
}

const TYPE_ICONS: Record<string, string> = {
  email: "M",
  webex: "W",
  meeting: "C",
  document: "D",
  subtask: "T",
};

const TYPE_COLORS: Record<string, string> = {
  email: "var(--accent)",
  webex: "var(--green)",
  meeting: "var(--purple)",
  document: "var(--orange)",
  subtask: "var(--yellow)",
};

const TYPE_LABELS: Record<string, string> = {
  email: "Email",
  webex: "Webex",
  meeting: "Meeting",
  document: "Document",
  subtask: "Sub-task",
};

export default function ActionCompose({
  page,
  onClose,
}: {
  page: NotionPage;
  onClose: () => void;
}) {
  const title = prop(page, "Task") || prop(page, "Name") || "Untitled";
  const notes = prop(page, "Notes") || "";
  const project = prop(page, "Project") || "";
  const context = prop(page, "Context") || "";
  const priority = prop(page, "Priority") || "";
  const source = prop(page, "Source") || "";
  const delegatedTo = prop(page, "Delegated To") || "";

  const [loading, setLoading] = useState(true);
  const [actions, setActions] = useState<SuggestedAction[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SuggestedAction | null>(null);
  const [editedBody, setEditedBody] = useState("");
  const [editedSubject, setEditedSubject] = useState("");
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [showPrepWorkspace, setShowPrepWorkspace] = useState<SuggestedAction | null>(null);

  const fetchActions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/task-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: page.id, title, notes, project, context, priority, source, delegatedTo }),
      });
      const data = await resp.json();
      if (data.error) {
        setError(data.error);
      } else {
        setActions(data.actions || []);
        setPeople(data.people || []);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [page.id, title, notes, project, context, priority]);

  useEffect(() => {
    fetchActions();
  }, [fetchActions]);

  function selectAction(action: SuggestedAction) {
    // All document actions and research-flavored subtasks go to PrepWorkspace
    if (action.type === "document") {
      setShowPrepWorkspace(action);
      return;
    }
    if (action.type === "subtask" && /research|prep|discover|background|talking points|brief/i.test(action.label)) {
      setShowPrepWorkspace(action);
      return;
    }
    setSelected(action);
    setEditedBody(action.body || "");
    setEditedSubject(action.subject || "");
    setCopied(false);
  }

  async function handleExecute() {
    if (!selected) return;

    if (selected.airgapped || selected.type === "document") {
      // Copy to clipboard
      const fullText = selected.subject
        ? `Subject: ${editedSubject}\n\n${editedBody}`
        : editedBody;
      try {
        await navigator.clipboard.writeText(fullText);
      } catch {
        // Fallback for non-HTTPS
        const ta = document.createElement("textarea");
        ta.value = fullText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);

      // Open target app for airgapped actions
      if (selected.type === "webex" && selected.toEmail) {
        window.open(`webexteams://im?email=${encodeURIComponent(selected.toEmail)}`, "_blank");
      } else if (selected.type === "email" && selected.toEmail) {
        // Open mailto as fallback for Cisco/Outlook
        window.open(
          `mailto:${selected.toEmail}?subject=${encodeURIComponent(editedSubject)}&body=${encodeURIComponent(editedBody)}`,
          "_blank"
        );
      }
      return;
    }

    // Direct API actions (personal email, calendar, webex send, subtask)
    setSending(true);
    try {
      if (selected.type === "webex" && selected.toRoomId) {
        await fetch("/api/send-webex", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: selected.toRoomId, text: editedBody }),
        });
        setCopied(true); // reuse for "Sent!" feedback
      } else if (selected.type === "subtask") {
        await fetch("/api/notion/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            database_id: "5b4e1d2d7259496ea237ef0525c3ce78",
            properties: {
              Task: { title: [{ text: { content: editedBody || selected.label } }] },
              Priority: { select: { name: priority || "P1 — This Week" } },
              Status: { status: { name: "Not started" } },
              Source: { select: { name: "Action Engine" } },
              Project: project ? { select: { name: project } } : undefined,
            },
          }),
        });
        setCopied(true);
      }
      // TODO: Gmail draft, Calendar event (future)
    } finally {
      setSending(false);
    }
  }

  // If a research action is selected, show PrepWorkspace instead
  if (showPrepWorkspace) {
    return (
      <PrepWorkspace
        topic={showPrepWorkspace.label || title}
        taskId={page.id}
        taskTitle={title}
        taskNotes={notes}
        project={project}
        initialBody={showPrepWorkspace.body || undefined}
        intent={showPrepWorkspace.label}
        onClose={() => setShowPrepWorkspace(null)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Slide-over panel */}
      <div className="absolute right-0 top-0 bottom-0 w-[520px] bg-[var(--surface)] border-l border-[var(--border)] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[var(--surface)] border-b border-[var(--border)] px-5 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--text-bright)]">Take Action</h2>
            <button onClick={onClose} className="text-[var(--text-dim)] hover:text-[var(--text)] text-lg leading-none">&times;</button>
          </div>
          <div className="text-xs text-[var(--text)] mt-1 line-clamp-2">{title}</div>
          {people.length > 0 && (
            <div className="flex gap-1 mt-2 flex-wrap">
              {people.map((p) => (
                <span key={p} className="text-[10px] px-2 py-0.5 rounded-full bg-[rgba(88,166,255,0.08)] text-[var(--accent)]">
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="px-5 py-4">
          {loading && (
            <div className="text-center py-12">
              <div className="text-sm text-[var(--text-dim)] animate-pulse">Analyzing task and generating actions...</div>
            </div>
          )}

          {error && (
            <div className="p-3 bg-[rgba(248,81,73,0.1)] border border-[var(--red)] rounded-lg text-sm text-[var(--red)]">
              {error}
            </div>
          )}

          {!loading && !error && !selected && (
            <div className="space-y-3">
              {/* Always-present Research & Enrich action */}
              <button
                onClick={() => setShowPrepWorkspace({
                  type: "document",
                  label: `Research: ${title}`,
                  airgapped: true,
                  reason: "Deep-dive into this task — gather context, upload documents, generate a research brief",
                } as SuggestedAction)}
                className="w-full text-left p-3 rounded-lg border-2 border-[rgba(56,178,172,0.3)] hover:border-[#38b2ac] bg-[rgba(56,178,172,0.04)] hover:bg-[rgba(56,178,172,0.08)] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0 bg-[rgba(56,178,172,0.15)] text-[#38b2ac]">
                    R
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[#38b2ac]">Research &amp; Enrich</div>
                    <div className="text-[11px] text-[var(--text-dim)] mt-0.5">
                      Gather context, upload docs, generate a brief — creates a reusable artifact
                    </div>
                  </div>
                  <div className="text-[#38b2ac] text-xs shrink-0">&rsaquo;</div>
                </div>
              </button>

              <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium">Suggested Actions</div>
              {actions.map((action, i) => (
                <button
                  key={i}
                  onClick={() => selectAction(action)}
                  className="w-full text-left p-3 rounded-lg border border-[var(--border)] hover:border-[var(--accent)] hover:bg-[rgba(88,166,255,0.03)] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0"
                      style={{
                        background: `color-mix(in srgb, ${TYPE_COLORS[action.type]} 15%, transparent)`,
                        color: TYPE_COLORS[action.type],
                      }}
                    >
                      {TYPE_ICONS[action.type]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--text-bright)]">{action.label}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                          style={{
                            background: `color-mix(in srgb, ${TYPE_COLORS[action.type]} 12%, transparent)`,
                            color: TYPE_COLORS[action.type],
                          }}
                        >
                          {TYPE_LABELS[action.type]}
                        </span>
                        {action.to && (
                          <span className="text-[11px] text-[var(--text-dim)]">to {action.to}</span>
                        )}
                        {action.airgapped && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[rgba(210,153,34,0.12)] text-[var(--yellow)] font-medium">
                            COPY
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-[var(--text-dim)] text-xs shrink-0">&rsaquo;</div>
                  </div>
                  <div className="text-[11px] text-[var(--text-dim)] mt-2 pl-10">{action.reason}</div>
                </button>
              ))}

              {actions.length === 0 && (
                <div className="text-center py-8 text-sm text-[var(--text-dim)] italic">
                  No actions suggested for this task.
                </div>
              )}

              <button
                onClick={fetchActions}
                className="w-full text-center text-xs text-[var(--text-dim)] hover:text-[var(--accent)] py-2"
              >
                Regenerate suggestions
              </button>
            </div>
          )}

          {/* Compose view — editing a selected action */}
          {selected && (
            <div className="space-y-4">
              <button
                onClick={() => { setSelected(null); setCopied(false); }}
                className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)]"
              >
                &larr; Back to suggestions
              </button>

              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-md flex items-center justify-center text-[12px] font-bold shrink-0"
                  style={{
                    background: `color-mix(in srgb, ${TYPE_COLORS[selected.type]} 15%, transparent)`,
                    color: TYPE_COLORS[selected.type],
                  }}
                >
                  {TYPE_ICONS[selected.type]}
                </div>
                <div>
                  <div className="text-sm font-semibold text-[var(--text-bright)]">{selected.label}</div>
                  {selected.to && (
                    <div className="text-xs text-[var(--text-dim)]">
                      To: {selected.to}{selected.toEmail ? ` (${selected.toEmail})` : ""}
                    </div>
                  )}
                </div>
                {selected.airgapped && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[rgba(210,153,34,0.12)] text-[var(--yellow)] font-medium ml-auto">
                    AIRGAPPED — Copy &amp; Paste
                  </span>
                )}
              </div>

              {/* Subject line (email/meeting) */}
              {(selected.type === "email" || selected.type === "meeting") && (
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium">Subject</label>
                  <input
                    type="text"
                    value={editedSubject}
                    onChange={(e) => setEditedSubject(e.target.value)}
                    className="w-full mt-1 h-8 px-3 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
              )}

              {/* Body */}
              <div>
                <label className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium">
                  {selected.type === "subtask" ? "Task Title" : "Draft"}
                </label>
                <textarea
                  value={editedBody}
                  onChange={(e) => setEditedBody(e.target.value)}
                  rows={selected.type === "subtask" ? 2 : 12}
                  className="w-full mt-1 px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)] focus:outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
                />
              </div>

              {/* Execute button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleExecute}
                  disabled={sending}
                  className={`flex-1 h-9 text-sm font-medium rounded-md transition-all ${
                    copied
                      ? "bg-[var(--green)] text-white"
                      : "bg-[var(--accent)] text-white hover:opacity-90"
                  } disabled:opacity-50`}
                >
                  {copied
                    ? selected.airgapped
                      ? "Copied! Opening app..."
                      : selected.type === "subtask"
                      ? "Task Created!"
                      : "Sent!"
                    : sending
                    ? "Sending..."
                    : selected.airgapped
                    ? "Copy to Clipboard"
                    : selected.type === "subtask"
                    ? "Create Task"
                    : "Send"}
                </button>
                {!selected.airgapped && selected.type !== "subtask" && (
                  <button
                    onClick={async () => {
                      const text = editedSubject ? `Subject: ${editedSubject}\n\n${editedBody}` : editedBody;
                      try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="h-9 px-3 text-xs text-[var(--text-dim)] hover:text-[var(--text)] border border-[var(--border)] rounded-md hover:border-[var(--accent)] transition-colors"
                  >
                    Copy
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
