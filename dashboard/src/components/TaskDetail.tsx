"use client";

import { useState, useEffect, useRef } from "react";
import { NotionPage, prop } from "@/lib/notion";
import EditableBadge from "@/components/EditableBadge";
import ActionCompose from "@/components/ActionCompose";

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

async function addNoteToPage(pageId: string, text: string): Promise<boolean> {
  const resp = await fetch("/api/notion/update", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page_id: pageId, appendNote: text }),
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
  const [currentNotes, setCurrentNotes] = useState<string | null>(null);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Initiative assignment state
  const [initiatives, setInitiatives] = useState<Initiative[]>([]);
  const [currentInitiative, setCurrentInitiative] = useState<Initiative | null>(null);
  const [initiativeOpen, setInitiativeOpen] = useState(false);
  const [savingInitiative, setSavingInitiative] = useState(false);
  const [newInitMode, setNewInitMode] = useState(false);
  const [newInitName, setNewInitName] = useState("");
  const initiativeRef = useRef<HTMLDivElement>(null);

  const originalTitle = prop(page, "Task") || prop(page, "Name") || "Untitled";
  const [title, setTitle] = useState(originalTitle);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(originalTitle);
  const [savingTitle, setSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [showActions, setShowActions] = useState(false);
  const [artifacts, setArtifacts] = useState<{ id: string; title: string; intent: string; createdAt: string; charCount: number }[]>([]);
  const [expandedArtifact, setExpandedArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  const [taskPeople, setTaskPeople] = useState<{ name: string; email?: string; auto: boolean }[]>([]);
  const [peopleSearchOpen, setPeopleSearchOpen] = useState(false);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [peopleSuggestions, setPeopleSuggestions] = useState<{ name: string; emails: string[] }[]>([]);
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
        const match = data.find((ini) =>
          (ini.pinnedTaskIds || []).includes(page.id)
        );
        if (match) setCurrentInitiative(match);
      })
      .catch(() => {});
    // Fetch artifacts for this task
    fetch(`/api/artifacts?taskId=${page.id}`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setArtifacts(data); })
      .catch(() => {});
    // Load saved people from Notes [People: ...] tag, then auto-detect additional
    const notesText = prop(page, "Notes") || "";
    const savedMatch = notesText.match(/\[People:\s*([^\]]+)\]/);
    const savedNames = savedMatch ? savedMatch[1].split(",").map((n: string) => n.trim()).filter(Boolean) : [];
    const savedSet = new Set(savedNames.map((n: string) => n.toLowerCase()));

    const taskText = `${originalTitle} ${notesText}`;
    fetch("/api/people")
      .then((r) => r.json())
      .then((people: { name: string; emails: string[] }[]) => {
        const result: { name: string; email?: string; auto: boolean }[] = [];
        // Add saved people first
        for (const name of savedNames) {
          const match = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
          result.push({ name: match?.name || name, email: match?.emails?.[0], auto: false });
        }
        // Auto-detect additional people from text
        for (const p of people) {
          if (!p.name || p.name.length < 4) continue;
          if (savedSet.has(p.name.toLowerCase())) continue;
          const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (new RegExp(`\\b${escaped}\\b`, "i").test(taskText)) {
            result.push({ name: p.name, email: p.emails?.[0], auto: true });
          }
        }
        setTaskPeople(result);
      })
      .catch(() => {});
  }, [page.id]);

  // Auto-save people list to Notion Notes as [People: Name1, Name2, ...]
  const peopleInitialized = useRef(false);
  useEffect(() => {
    // Skip the first render (initial load sets people from existing data)
    if (!peopleInitialized.current) {
      if (taskPeople.length > 0) peopleInitialized.current = true;
      return;
    }
    const names = taskPeople.map((p) => p.name);
    const tag = names.length > 0 ? `[People: ${names.join(", ")}]` : "";
    const currentNotes = prop(page, "Notes") || "";
    // Replace existing tag or append
    const cleaned = currentNotes.replace(/\[People:[^\]]*\]\s*/g, "").trim();
    const newNotes = tag ? (cleaned ? `${tag}\n${cleaned}` : tag) : cleaned;
    // Only update if changed
    const oldTag = currentNotes.match(/\[People:[^\]]*\]/)?.[0] || "";
    const newTag = tag;
    if (oldTag === newTag) return;
    fetch("/api/notion/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page_id: page.id,
        properties: {
          Notes: { rich_text: [{ text: { content: newNotes.slice(0, 2000) } }] },
        },
      }),
    }).catch(() => {});
  }, [taskPeople, page.id]);

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
    const ok = await addNoteToPage(page.id, noteText.trim());
    if (ok) {
      // Refetch the page to get the updated notes
      try {
        const resp = await fetch("/api/notion/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            database_id: "5b4e1d2d7259496ea237ef0525c3ce78",
            filter: { property: "Task", title: { equals: title } },
            page_size: 1,
          }),
        });
        const data = await resp.json();
        const updatedPage = data.results?.[0];
        if (updatedPage) {
          const updatedNotes = (updatedPage.properties?.Notes?.rich_text || [])
            .map((t: { plain_text: string }) => t.plain_text).join("");
          setCurrentNotes(updatedNotes);
        }
      } catch { /* fall back to optimistic update */ }
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
  const notesFromPage = prop(page, "Notes");
  const notes = currentNotes ?? notesFromPage;
  const delegated = prop(page, "Delegated To");
  const energy = prop(page, "Energy");
  const dueDate = prop(page, "Due Date");

  // Parse Webex deep link IDs from notes
  const webexRoomId = (notes?.match(/webex_room:(\S+)/)?.[1] || "").replace(/[.\s,;]+$/, "");
  const webexMsgId = notes?.match(/webex_msg:(\S+)/)?.[1] || "";
  // Don't extract email from notes — LLMs hallucinate email addresses.
  // The person index has verified emails from Webex API.
  // Parse source IDs and meeting names for archive links
  const recordingId = notes?.match(/file_id:\s*(\S+)/)?.[1] || notes?.match(/Recording:\s*(\S+)/)?.[1] || "";
  const webexMeetingId = notes?.match(/webex_meeting:(\S+)/)?.[1] || "";
  const meetingName = notes?.match(/(?:From (?:Webex )?meeting|From recording|From meeting):\s*([^\n—]+)/i)?.[1]?.trim() || "";
  const sourceField = prop(page, "Source") || "";

  // Source provenance state — resolved async
  const [provenanceLink, setProvenanceLink] = useState<{ type: string; id: string; title: string } | null>(null);
  useEffect(() => {
    // For Webex message tasks, search archive by room ID
    if (webexRoomId && sourceField.includes("Message")) {
      const roomShort = webexRoomId.slice(-12);
      fetch(`/api/archive?type=messages&q=${encodeURIComponent(roomShort)}`).then((r) => r.json()).then((data) => {
        if (data.items?.[0]) setProvenanceLink({ type: "messages", id: data.items[0].id, title: data.items[0].title });
      }).catch(() => {});
      return;
    }

    // Try explicit IDs first
    const explicitId = recordingId || webexMeetingId;
    if (explicitId) {
      const archiveType = sourceField.includes("Transcript") ? "transcripts"
        : sourceField.includes("PLAUD") ? "plaud"
        : sourceField.includes("Webex Message") ? "messages"
        : sourceField.includes("Webex AI") ? "summaries"
        : sourceField.includes("Boox") ? "boox"
        : sourceField.includes("Gmail") ? "emails" : "transcripts";
      fetch(`/api/archive?type=${archiveType}&id=${explicitId}`).then((r) => {
        if (r.ok) return r.json();
        return null;
      }).then((data) => {
        if (data && !data.error) setProvenanceLink({ type: archiveType, id: explicitId, title: data.title });
      }).catch(() => {});
      return;
    }
    // Fallback: search archive by meeting name
    if (meetingName) {
      const searchName = meetingName.replace(/\s*—\s*\d{4}.*$/, "").trim();
      // Search across transcripts, summaries, plaud
      Promise.all(["transcripts", "summaries", "plaud"].map((type) =>
        fetch(`/api/archive?type=${type}&q=${encodeURIComponent(searchName)}`).then((r) => r.json()).catch(() => ({ items: [] }))
      )).then(([trans, summ, plaud]) => {
        const match = (trans.items?.[0]) || (summ.items?.[0]) || (plaud.items?.[0]);
        if (match) {
          const type = trans.items?.[0] ? "transcripts" : summ.items?.[0] ? "summaries" : "plaud";
          setProvenanceLink({ type, id: match.id, title: match.title });
        }
      });
    }
  }, [recordingId, webexMeetingId, meetingName, sourceField]);
  // Strip the IDs from displayed notes
  const displayNotes = notes
    ?.replace(/\s*webex_room:\S+/g, "")
    .replace(/\s*webex_msg:\S+/g, "")
    .replace(/\s*webex_meeting:\S+/g, "")
    .trim();

  useEffect(() => {
    if (editingTitle && titleInputRef.current) titleInputRef.current.focus();
  }, [editingTitle]);

  async function handleSaveTitle() {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === title) { setEditingTitle(false); setTitleDraft(title); return; }
    setSavingTitle(true);
    try {
      const resp = await fetch("/api/corrections", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: page.id, oldTitle: title, newTitle: trimmed }),
      });
      if (resp.ok) setTitle(trimmed);
    } finally {
      setSavingTitle(false);
      setEditingTitle(false);
    }
  }

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
              ) : editingTitle ? (
                <input
                  ref={titleInputRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveTitle();
                    if (e.key === "Escape") { setEditingTitle(false); setTitleDraft(title); }
                  }}
                  onBlur={handleSaveTitle}
                  disabled={savingTitle}
                  className="text-lg font-semibold text-[var(--text-bright)] bg-[var(--bg)] border border-[var(--accent)] rounded px-2 py-0.5 w-full focus:outline-none"
                />
              ) : (
                <h2
                  className="text-lg font-semibold text-[var(--text-bright)] cursor-text hover:underline hover:decoration-dotted hover:decoration-[var(--text-dim)]"
                  onClick={() => { setEditingTitle(true); setTitleDraft(title); }}
                  title="Click to edit"
                >
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
                      {!newInitMode ? (
                        <button
                          className="block w-full text-left px-3 py-1.5 text-xs text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[rgba(88,166,255,0.04)] border-t border-[var(--border)] mt-1 pt-1.5"
                          onClick={(e) => { e.stopPropagation(); setNewInitMode(true); }}
                        >
                          + New Initiative
                        </button>
                      ) : (
                        <div className="px-3 py-1.5 border-t border-[var(--border)] mt-1 pt-1.5" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            placeholder="Initiative name..."
                            value={newInitName}
                            onChange={(e) => setNewInitName(e.target.value)}
                            onKeyDown={async (e) => {
                              if (e.key === "Enter" && newInitName.trim()) {
                                setSavingInitiative(true);
                                const resp = await fetch("/api/initiatives", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ name: newInitName.trim(), description: newInitName.trim(), keywords: [newInitName.trim().toLowerCase()] }),
                                });
                                if (resp.ok) {
                                  const created = await resp.json();
                                  setInitiatives((prev) => [...prev, created]);
                                  handleInitiativeSelect(created);
                                }
                                setNewInitMode(false);
                                setNewInitName("");
                                setSavingInitiative(false);
                              }
                            }}
                            className="w-full h-6 px-2 text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[#38b2ac]"
                            autoFocus
                          />
                          <div className="flex gap-1 mt-1">
                            <button
                              onClick={async () => {
                                if (!newInitName.trim()) return;
                                setSavingInitiative(true);
                                const resp = await fetch("/api/initiatives", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ name: newInitName.trim(), description: newInitName.trim(), keywords: [newInitName.trim().toLowerCase()] }),
                                });
                                if (resp.ok) {
                                  const created = await resp.json();
                                  setInitiatives((prev) => [...prev, created]);
                                  handleInitiativeSelect(created);
                                }
                                setNewInitMode(false);
                                setNewInitName("");
                                setSavingInitiative(false);
                              }}
                              disabled={!newInitName.trim()}
                              className="flex-1 h-5 text-[10px] font-medium bg-[#38b2ac] text-white rounded hover:opacity-90 disabled:opacity-40"
                            >
                              Create
                            </button>
                            <button
                              onClick={() => { setNewInitMode(false); setNewInitName(""); }}
                              className="h-5 px-1.5 text-[10px] text-[var(--text-dim)]"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
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

          {/* People */}
          <div>
            <div className="text-xs text-[var(--text-dim)] uppercase tracking-wider mb-2">People</div>
            <div className="flex flex-wrap gap-1.5">
              {taskPeople.map((p) => (
                <div key={p.name} className="flex items-center gap-1 px-2 py-1 rounded-full bg-[rgba(88,166,255,0.08)] text-xs text-[var(--accent)]">
                  <span>{p.name}</span>
                  <button
                    onClick={() => setTaskPeople((prev) => prev.filter((pp) => pp.name !== p.name))}
                    className="text-[var(--text-dim)] hover:text-[var(--red)] text-[10px] ml-0.5"
                  >
                    &times;
                  </button>
                </div>
              ))}
              {!peopleSearchOpen ? (
                <button
                  onClick={() => setPeopleSearchOpen(true)}
                  className="px-2 py-1 rounded-full text-xs text-[var(--text-dim)] hover:text-[var(--accent)] border border-dashed border-[var(--border)] hover:border-[var(--accent)]"
                >
                  + Add person
                </button>
              ) : (
                <div className="relative">
                  <input
                    type="text"
                    value={peopleQuery}
                    onChange={(e) => {
                      setPeopleQuery(e.target.value);
                      if (e.target.value.length >= 2) {
                        fetch(`/api/people`).then((r) => r.json()).then((all: { name: string; emails: string[] }[]) => {
                          const q = e.target.value.toLowerCase();
                          const existing = new Set(taskPeople.map((p) => p.name.toLowerCase()));
                          setPeopleSuggestions(all.filter((p) =>
                            p.name.toLowerCase().includes(q) && !existing.has(p.name.toLowerCase())
                          ).slice(0, 6));
                        }).catch(() => {});
                      } else {
                        setPeopleSuggestions([]);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setPeopleSearchOpen(false); setPeopleQuery(""); setPeopleSuggestions([]); }
                      if (e.key === "Enter" && peopleQuery.trim().length >= 2) {
                        const name = peopleQuery.trim();
                        // Check if there's an exact suggestion match — use it
                        const exactMatch = peopleSuggestions.find((p) => p.name.toLowerCase() === name.toLowerCase());
                        if (exactMatch) {
                          setTaskPeople((prev) => [...prev, { name: exactMatch.name, email: exactMatch.emails?.[0], auto: false }]);
                        } else {
                          // Hot-seed: add to task AND person index
                          setTaskPeople((prev) => [...prev, { name, auto: false }]);
                          fetch("/api/people", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name }),
                          }).catch(() => {});
                        }
                        setPeopleSearchOpen(false);
                        setPeopleQuery("");
                        setPeopleSuggestions([]);
                      }
                    }}
                    placeholder="Search..."
                    className="h-7 w-40 px-2 text-xs bg-[var(--bg)] border border-[var(--accent)] rounded-full text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none"
                    autoFocus
                  />
                  {peopleQuery.length >= 2 && (
                    <div className="absolute top-full left-0 mt-1 z-30 w-56 bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg py-1 max-h-[180px] overflow-y-auto">
                      {peopleSuggestions.map((p) => (
                        <button
                          key={p.name}
                          onClick={() => {
                            setTaskPeople((prev) => [...prev, { name: p.name, email: p.emails?.[0], auto: false }]);
                            setPeopleSearchOpen(false);
                            setPeopleQuery("");
                            setPeopleSuggestions([]);
                          }}
                          className="w-full text-left px-3 py-1.5 text-xs text-[var(--text)] hover:bg-[rgba(88,166,255,0.06)]"
                        >
                          <div>{p.name}</div>
                          {p.emails?.[0] && <div className="text-[10px] text-[var(--text-dim)]">{p.emails[0]}</div>}
                        </button>
                      ))}
                      {peopleSuggestions.length === 0 && (
                        <div className="px-3 py-1.5 text-[11px] text-[var(--text-dim)]">
                          Press <span className="text-[var(--accent)]">Enter</span> to add &ldquo;{peopleQuery}&rdquo; as a new person
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {taskPeople.length === 0 && !peopleSearchOpen && (
              <div className="text-[11px] text-[var(--text-dim)] italic mt-1">No people detected — click + to add</div>
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
              <button
                onClick={() => {
                  // Try desktop app first, fall back to web
                  window.location.href = `webexteams://im?roomId=${webexRoomId}`;
                  setTimeout(() => {
                    window.open(`https://web.webex.com/spaces/${webexRoomId}`, "_blank");
                  }, 1500);
                }}
                className="text-xs text-[var(--green)] hover:underline"
              >
                Open in Webex &rarr;
              </button>
            )}
            {provenanceLink && (
              <button
                onClick={async () => {
                  try {
                    const resp = await fetch(`/api/archive?type=${provenanceLink.type}&id=${provenanceLink.id}`);
                    if (resp.ok) {
                      const data = await resp.json();
                      const w = window.open("", "_blank", "width=700,height=600");
                      if (w) {
                        w.document.write(`<html><head><title>${data.title || "Source"}</title><style>body{font-family:system-ui;background:#1a1a2e;color:#e0e0e0;padding:2rem;line-height:1.6;max-width:700px}h1{font-size:1.1rem;color:#58a6ff}h2{font-size:0.95rem;color:#bc8cff;margin-top:1.5rem}.meta{color:#888;font-size:0.8rem;margin-bottom:1rem}pre{white-space:pre-wrap;font-size:0.85rem;line-height:1.5}</style></head><body><h1>${(data.title || "Source Content").replace(/</g,"&lt;")}</h1><div class="meta">${(data.date || "").slice(0,10)} &middot; ${data.source || provenanceLink.type}${data.speakers ? " &middot; " + data.speakers.join(", ") : ""}</div><pre>${(data.content || "").replace(/</g,"&lt;")}</pre></body></html>`);
                      }
                    }
                  } catch {}
                }}
                className="text-xs text-[var(--purple)] hover:underline"
              >
                View Source: {provenanceLink.title.slice(0, 40)}{provenanceLink.title.length > 40 ? "..." : ""} &rarr;
              </button>
            )}
          </div>
        </div>

        {/* Artifacts */}
        {artifacts.length > 0 && (
          <div className="px-6 py-4 border-t border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium mb-2">
              Artifacts ({artifacts.length})
            </div>
            {artifacts.map((a) => (
              <div key={a.id} className="mb-2">
                <button
                  onClick={async () => {
                    if (expandedArtifact === a.id) { setExpandedArtifact(null); return; }
                    setExpandedArtifact(a.id);
                    setArtifactContent(null);
                    try {
                      const resp = await fetch(`/api/artifacts?id=${a.id}`);
                      const data = await resp.json();
                      if (data.content) setArtifactContent(data.content);
                    } catch { /* ignore */ }
                  }}
                  className="w-full text-left flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-[rgba(88,166,255,0.04)] transition-colors"
                >
                  <div className="w-6 h-6 rounded bg-[rgba(63,185,80,0.12)] flex items-center justify-center text-[10px] font-bold text-[var(--green)] shrink-0">A</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-[var(--text)] truncate">{a.title}</div>
                    <div className="text-[10px] text-[var(--text-dim)]">
                      {new Date(a.createdAt).toLocaleDateString()} — {a.charCount.toLocaleString()} chars
                    </div>
                  </div>
                  <span className="text-[var(--text-dim)] text-xs">{expandedArtifact === a.id ? "\u25BE" : "\u25B8"}</span>
                </button>
                {expandedArtifact === a.id && artifactContent && (
                  <div className="mt-1 bg-[var(--bg)] rounded-lg px-4 py-3 text-xs text-[var(--text)] max-h-[300px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden leading-relaxed space-y-1">
                    {artifactContent.split("\n").map((line, i) => {
                      if (line.startsWith("---") || line.match(/^(title|intent|created|taskId|taskTitle|project|sources):/)) return null;
                      if (line.startsWith("### ")) return <h3 key={i} className="text-xs font-bold text-[var(--text-bright)] mt-3 mb-1">{line.replace("### ", "")}</h3>;
                      if (line.startsWith("## ")) return <h2 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-3 mb-1">{line.replace("## ", "")}</h2>;
                      if (line.startsWith("# ")) return <h2 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-3 mb-1">{line.replace("# ", "")}</h2>;
                      if (line.startsWith("- ") || line.startsWith("* ")) return <div key={i} className="flex gap-2"><span className="text-[var(--text-dim)] shrink-0">&bull;</span><span>{line.slice(2)}</span></div>;
                      if (!line.trim()) return <div key={i} className="h-1.5" />;
                      return <p key={i}>{line}</p>;
                    })}
                    <button
                      onClick={async () => {
                        try { await navigator.clipboard.writeText(artifactContent); } catch { /* ignore */ }
                      }}
                      className="mt-2 text-[10px] text-[var(--accent)] hover:underline"
                    >
                      Copy to clipboard
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

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
              {!isRich && (
                <button
                  onClick={() => setShowActions(true)}
                  className="px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:opacity-90 whitespace-nowrap"
                >
                  Take Action
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Action Compose slide-over */}
      {showActions && (
        <ActionCompose page={page} onClose={() => setShowActions(false)} />
      )}
    </div>
  );
}
