"use client";

import { useState } from "react";
import { NotionPage, prop } from "@/lib/notion";

function badgeCls(type: string, value: string): string {
  const base = "inline-block px-2.5 py-0.5 rounded-full text-xs font-medium";
  if (type === "priority") {
    if (value.includes("P0")) return `${base} bg-[rgba(248,81,73,0.15)] text-[var(--red)]`;
    if (value.includes("P1")) return `${base} bg-[rgba(219,109,40,0.15)] text-[var(--orange)]`;
    if (value.includes("P2")) return `${base} bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]`;
    return `${base} bg-[rgba(139,148,158,0.15)] text-[var(--text-dim)]`;
  }
  if (type === "status") {
    if (value === "Done") return `${base} bg-[rgba(63,185,80,0.15)] text-[var(--green)]`;
    if (value === "In progress") return `${base} bg-[rgba(88,166,255,0.15)] text-[var(--accent)]`;
    return `${base} bg-[rgba(139,148,158,0.15)] text-[var(--text-dim)]`;
  }
  if (type === "context") return `${base} bg-[rgba(188,140,255,0.12)] text-[var(--purple)]`;
  if (type === "source") return `${base} bg-[rgba(88,166,255,0.08)] text-[var(--accent)]`;
  return `${base} bg-[rgba(139,148,158,0.1)] text-[var(--text-dim)]`;
}

async function completeTask(pageId: string, comment?: string) {
  const resp = await fetch("/api/notion/update", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      page_id: pageId,
      properties: { Status: { status: { name: "Done" } } },
      comment: comment || undefined,
    }),
  });
  return resp.ok;
}

export default function TaskDetail({
  page,
  onClose,
  onComplete,
}: {
  page: NotionPage;
  onClose: () => void;
  onComplete?: (id: string) => void;
}) {
  const [completing, setCompleting] = useState(false);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState(false);

  const title = prop(page, "Task") || prop(page, "Name") || "Untitled";
  const priority = prop(page, "Priority");
  const status = prop(page, "Status");
  const context = prop(page, "Context");
  const source = prop(page, "Source");
  const project = prop(page, "Project");
  const notes = prop(page, "Notes");
  const delegated = prop(page, "Delegated To");
  const energy = prop(page, "Energy");
  const dueDate = prop(page, "Due Date");

  // Parse Webex deep link IDs from notes
  const webexRoomId = notes?.match(/webex_room:(\S+)/)?.[1] || "";
  const webexMsgId = notes?.match(/webex_msg:(\S+)/)?.[1] || "";
  // Strip the IDs from displayed notes
  const displayNotes = notes
    ?.replace(/\s*webex_room:\S+/g, "")
    .replace(/\s*webex_msg:\S+/g, "")
    .trim();

  async function handleComplete() {
    setCompleting(true);
    const ok = await completeTask(page.id, comment || undefined);
    if (ok) {
      setDone(true);
      onComplete?.(page.id);
      setTimeout(onClose, 800);
    }
    setCompleting(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-[600px] max-h-[80vh] bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-[var(--border)]">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              {done ? (
                <h2 className="text-lg font-semibold text-[var(--green)] line-through">
                  {title}
                </h2>
              ) : (
                <h2 className="text-lg font-semibold text-[var(--text-bright)]">
                  {title}
                </h2>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {priority && <span className={badgeCls("priority", priority)}>{priority}</span>}
                {status && <span className={badgeCls("status", status)}>{done ? "Done" : status}</span>}
                {context && <span className={badgeCls("context", context)}>{context}</span>}
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-[var(--text-dim)] hover:text-[var(--text)] text-xl px-1 -mt-1"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Properties grid */}
          <div className="grid grid-cols-2 gap-3">
            {project && (
              <div>
                <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Project</div>
                <div className="text-sm text-[var(--text)]">{project}</div>
              </div>
            )}
            {source && (
              <div>
                <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Source</div>
                <div className="text-sm"><span className={badgeCls("source", source)}>{source}</span></div>
              </div>
            )}
            {delegated && (
              <div>
                <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Delegated To</div>
                <div className="text-sm text-[var(--purple)]">{delegated}</div>
              </div>
            )}
            {energy && (
              <div>
                <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Energy</div>
                <div className="text-sm text-[var(--text)]">{energy}</div>
              </div>
            )}
            {dueDate && (
              <div>
                <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Due Date</div>
                <div className="text-sm text-[var(--text)]">{dueDate}</div>
              </div>
            )}
          </div>

          {/* Notes */}
          {notes && (
            <div>
              <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-2">Notes</div>
              <div className="text-sm text-[var(--text)] bg-[var(--bg)] rounded-lg p-4 whitespace-pre-wrap leading-relaxed">
                {displayNotes}
              </div>
            </div>
          )}

          {/* Source links */}
          <div className="flex flex-wrap gap-4">
            <a
              href={page.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[var(--accent)] hover:underline"
            >
              Open in Notion &rarr;
            </a>
            {webexRoomId && (
              <a
                href={`https://web.webex.com/spaces/${webexRoomId}${webexMsgId ? `?messageId=${webexMsgId}` : ""}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--green)] hover:underline"
              >
                View in Webex &rarr;
              </a>
            )}
          </div>
        </div>

        {/* Footer: complete action */}
        {!done && (
          <div className="px-6 py-4 border-t border-[var(--border)] bg-[var(--surface2)]">
            <div className="flex items-center gap-3">
              <input
                type="text"
                placeholder="Completion note (optional)..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleComplete()}
                className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={handleComplete}
                disabled={completing}
                className="px-4 py-2 bg-[var(--green)] text-[var(--bg)] text-sm font-medium rounded-md hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
              >
                {completing ? "Saving..." : "Mark Done"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
