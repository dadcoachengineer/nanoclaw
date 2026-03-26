"use client";

import { useState, useEffect, useRef } from "react";
import { NotionPage, prop } from "@/lib/notion";
import EditableBadge from "@/components/EditableBadge";

/** Check if this is a briefing/prep page (has rich body content) */
function isRichPage(title: string): boolean {
  return /daily briefing|meeting prep|weekly review|transcript summary/i.test(title);
}

/** Extract plain text from a Notion rich_text array */
function richText(rt: { plain_text: string }[] | undefined): string {
  return (rt || []).map((t) => t.plain_text).join("");
}

/** Render Notion blocks as React elements */
function NotionBlocks({ blocks }: { blocks: any[] }) {
  return (
    <div className="space-y-1.5">
      {blocks.map((block, i) => {
        const type = block.type;

        if (type === "heading_1") {
          return <h2 key={i} className="text-base font-bold text-[var(--text-bright)] mt-4 mb-1">{richText(block.heading_1?.rich_text)}</h2>;
        }
        if (type === "heading_2") {
          return <h3 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-3 mb-1">{richText(block.heading_2?.rich_text)}</h3>;
        }
        if (type === "heading_3") {
          return <h4 key={i} className="text-sm font-semibold text-[var(--text)] mt-2 mb-0.5">{richText(block.heading_3?.rich_text)}</h4>;
        }
        if (type === "paragraph") {
          const text = richText(block.paragraph?.rich_text);
          if (!text) return <div key={i} className="h-2" />;
          return <p key={i} className="text-sm text-[var(--text)] leading-relaxed">{text}</p>;
        }
        if (type === "bulleted_list_item") {
          return (
            <div key={i} className="flex gap-2 text-sm text-[var(--text)]">
              <span className="text-[var(--text-dim)] shrink-0">•</span>
              <span>{richText(block.bulleted_list_item?.rich_text)}</span>
            </div>
          );
        }
        if (type === "numbered_list_item") {
          return (
            <div key={i} className="flex gap-2 text-sm text-[var(--text)]">
              <span className="text-[var(--text-dim)] shrink-0 w-4 text-right">{i + 1}.</span>
              <span>{richText(block.numbered_list_item?.rich_text)}</span>
            </div>
          );
        }
        if (type === "to_do") {
          const checked = block.to_do?.checked;
          return (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span className={`shrink-0 ${checked ? "text-[var(--green)]" : "text-[var(--text-dim)]"}`}>
                {checked ? "☑" : "☐"}
              </span>
              <span className={checked ? "text-[var(--text-dim)] line-through" : "text-[var(--text)]"}>
                {richText(block.to_do?.rich_text)}
              </span>
            </div>
          );
        }
        if (type === "divider") {
          return <hr key={i} className="border-[var(--border)] my-2" />;
        }
        if (type === "callout") {
          return (
            <div key={i} className="flex gap-2 text-sm bg-[rgba(88,166,255,0.06)] rounded-lg px-3 py-2 my-1">
              <span>{block.callout?.icon?.emoji || "💡"}</span>
              <span className="text-[var(--text)]">{richText(block.callout?.rich_text)}</span>
            </div>
          );
        }
        if (type === "quote") {
          return (
            <div key={i} className="border-l-2 border-[var(--accent)] pl-3 text-sm text-[var(--text-dim)] italic my-1">
              {richText(block.quote?.rich_text)}
            </div>
          );
        }
        if (type === "table_row" || type === "table") {
          return null; // Skip complex tables for now
        }
        // Fallback: render as paragraph if it has rich_text
        const fallbackText = richText(block[type]?.rich_text);
        if (fallbackText) {
          return <p key={i} className="text-sm text-[var(--text)]">{fallbackText}</p>;
        }
        return null;
      })}
    </div>
  );
}

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

async function addNoteComment(pageId: string, text: string): Promise<boolean> {
  const resp = await fetch("/api/notion/update", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page_id: pageId, comment: text }),
  });
  return resp.ok;
}

interface Initiative {
  slug: string;
  name: string;
  status: string;
  pinnedTaskIds?: string[];
}

interface LocalNote {
  text: string;
  timestamp: string;
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
  const [blocks, setBlocks] = useState<any[] | null>(null);
  const [loadingBlocks, setLoadingBlocks] = useState(false);

  // Editable notes state
  const [addingNote, setAddingNote] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [localNotes, setLocalNotes] = useState<LocalNote[]>([]);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Initiative assignment state
  const [initiatives, setInitiatives] = useState<Initiative[]>([]);
  const [currentInitiative, setCurrentInitiative] = useState<Initiative | null>(null);
  const [initiativeOpen, setInitiativeOpen] = useState(false);
  const [savingInitiative, setSavingInitiative] = useState(false);
  const initiativeRef = useRef<HTMLDivElement>(null);

  const title = prop(page, "Task") || prop(page, "Name") || "Untitled";
  const isRich = isRichPage(title);

  // Fetch page blocks for briefing/prep pages
  useEffect(() => {
    if (!isRich) return;
    setLoadingBlocks(true);
    fetch(`/api/notion/blocks?page_id=${page.id}`)
      .then((r) => r.json())
      .then((data) => setBlocks(data.blocks || []))
      .catch(() => setBlocks(null))
      .finally(() => setLoadingBlocks(false));
  }, [page.id, isRich]);

  // Fetch initiatives and detect current assignment
  useEffect(() => {
    fetch("/api/initiatives")
      .then((r) => r.json())
      .then((data: Initiative[]) => {
        setInitiatives(data);
        // Find which initiative has this task pinned
        const match = data.find((ini) =>
          (ini.pinnedTaskIds || []).includes(page.id)
        );
        if (match) setCurrentInitiative(match);
      })
      .catch(() => {});
  }, [page.id]);

  // Close initiative dropdown on outside click
  useEffect(() => {
    if (!initiativeOpen) return;
    function handleClick(e: MouseEvent) {
      if (initiativeRef.current && !initiativeRef.current.contains(e.target as Node)) {
        setInitiativeOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [initiativeOpen]);

  // Auto-focus the note textarea when opened
  useEffect(() => {
    if (addingNote && noteTextareaRef.current) {
      noteTextareaRef.current.focus();
    }
  }, [addingNote]);

  async function handleSaveNote() {
    if (!noteText.trim()) return;
    setSavingNote(true);
    const ok = await addNoteComment(page.id, noteText.trim());
    if (ok) {
      setLocalNotes((prev) => [
        ...prev,
        { text: noteText.trim(), timestamp: new Date().toLocaleString() },
      ]);
      setNoteText("");
      setAddingNote(false);
    }
    setSavingNote(false);
  }

  async function handleInitiativeSelect(ini: Initiative) {
    if (currentInitiative?.slug === ini.slug) {
      setInitiativeOpen(false);
      return;
    }
    setSavingInitiative(true);
    setInitiativeOpen(false);

    // Unpin from current initiative if assigned
    if (currentInitiative) {
      await fetch("/api/initiatives", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: currentInitiative.slug, unpinTask: page.id }),
      });
    }

    // Pin to the new initiative
    const resp = await fetch("/api/initiatives", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: ini.slug, pinTask: page.id }),
    });

    if (resp.ok) {
      setCurrentInitiative(ini);
    }
    setSavingInitiative(false);
  }
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

      {/* Modal — wider for rich content pages */}
      <div className={`relative ${isRich ? "w-[750px]" : "w-[600px]"} max-h-[80vh] bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden flex flex-col`}>
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
                {priority && <EditableBadge pageId={page.id} field="Priority" value={priority} />}
                {status && (done
                  ? <span className={badgeCls("status", "Done")}>Done</span>
                  : <EditableBadge pageId={page.id} field="Status" value={status} />
                )}
                {context && <EditableBadge pageId={page.id} field="Context" value={context} />}
                {/* Initiative assignment pill */}
                <div ref={initiativeRef} className="relative inline-block">
                  <span
                    className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium cursor-pointer transition-opacity hover:opacity-80 ${
                      savingInitiative
                        ? "opacity-50"
                        : currentInitiative
                          ? "bg-[rgba(56,178,172,0.15)] text-[#38b2ac]"
                          : "bg-[rgba(56,178,172,0.08)] text-[rgba(56,178,172,0.6)] border border-dashed border-[rgba(56,178,172,0.3)]"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setInitiativeOpen(!initiativeOpen);
                    }}
                  >
                    {currentInitiative ? currentInitiative.name : "+ Initiative"}
                  </span>

                  {initiativeOpen && (
                    <div className="absolute top-full left-0 mt-1 z-[60] min-w-[200px] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg py-1 space-y-0.5">
                      <div className="px-3 py-1 text-[10px] text-[var(--text-dim)] uppercase tracking-wider">
                        Initiative
                      </div>
                      {initiatives.length === 0 && (
                        <div className="px-3 py-1.5 text-xs text-[var(--text-dim)]">No initiatives found</div>
                      )}
                      {initiatives.map((ini) => (
                        <button
                          key={ini.slug}
                          className={`block w-full text-left px-3 py-1.5 text-xs rounded-md transition-colors text-[#38b2ac] hover:bg-[rgba(56,178,172,0.1)] ${
                            currentInitiative?.slug === ini.slug ? "ring-1 ring-[#38b2ac]" : ""
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleInitiativeSelect(ini);
                          }}
                        >
                          {ini.name}
                          {ini.status !== "active" && (
                            <span className="ml-1.5 text-[var(--text-dim)]">({ini.status})</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
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
                <div className="text-sm"><EditableBadge pageId={page.id} field="Project" value={project} /></div>
              </div>
            )}
            {source && (
              <div>
                <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Source</div>
                <div className="text-sm"><EditableBadge pageId={page.id} field="Source" value={source} /></div>
              </div>
            )}
            {delegated && (
              <div>
                <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Delegated To</div>
                <div className="text-sm"><EditableBadge pageId={page.id} field="Delegated To" value={delegated} /></div>
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
          {(notes || localNotes.length > 0) && (
            <div>
              <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-2">Notes</div>
              {displayNotes && (
                <div className="text-sm text-[var(--text)] bg-[var(--bg)] rounded-lg p-4 whitespace-pre-wrap leading-relaxed">
                  {displayNotes}
                </div>
              )}
              {/* Locally added notes */}
              {localNotes.map((ln, i) => (
                <div key={i} className="text-sm text-[var(--text)] bg-[var(--bg)] rounded-lg p-4 mt-2 whitespace-pre-wrap leading-relaxed">
                  <div className="text-[10px] text-[var(--text-dim)] mb-1">{ln.timestamp}</div>
                  {ln.text}
                </div>
              ))}
            </div>
          )}

          {/* Add Note */}
          {!done && (
            <div>
              {!addingNote ? (
                <button
                  onClick={() => setAddingNote(true)}
                  className="text-xs text-[var(--accent)] hover:underline"
                >
                  + Add Note
                </button>
              ) : (
                <div className="bg-[var(--bg)] rounded-lg p-3 border border-[var(--border)]">
                  <textarea
                    ref={noteTextareaRef}
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        handleSaveNote();
                      }
                      if (e.key === "Escape") {
                        setAddingNote(false);
                        setNoteText("");
                      }
                    }}
                    placeholder="Write a note..."
                    rows={3}
                    className="w-full bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] resize-none focus:outline-none"
                  />
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[10px] text-[var(--text-dim)]">Ctrl+Enter to save, Esc to cancel</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setAddingNote(false); setNoteText(""); }}
                        className="px-3 py-1 text-xs text-[var(--text-dim)] hover:text-[var(--text)]"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSaveNote}
                        disabled={savingNote || !noteText.trim()}
                        className="px-3 py-1 text-xs bg-[var(--accent)] text-[var(--bg)] rounded-md hover:opacity-90 disabled:opacity-50"
                      >
                        {savingNote ? "Saving..." : "Save Note"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Rich page content (briefings, prep, reviews) */}
          {isRich && loadingBlocks && (
            <div className="text-center text-[var(--text-dim)] py-4 text-sm">Loading content...</div>
          )}
          {isRich && blocks && blocks.length > 0 && (
            <div className="bg-[var(--bg)] rounded-lg p-5">
              <NotionBlocks blocks={blocks} />
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
                placeholder="Completion note..."
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
