"use client";

import { useState, useRef } from "react";
import { NotionPage, prop } from "@/lib/notion";
import EditableBadge from "@/components/EditableBadge";

function badgeStyle(type: "priority" | "context" | "source"): string {
  const base = "inline-block px-2 py-0.5 rounded-full text-[11px] font-medium";
  if (type === "context")
    return `${base} bg-[rgba(188,140,255,0.12)] text-[var(--purple)]`;
  if (type === "source")
    return `${base} bg-[rgba(88,166,255,0.08)] text-[var(--accent)]`;
  return base;
}

function priorityBadge(p: string): string {
  if (p.includes("P0")) return "bg-[rgba(248,81,73,0.15)] text-[var(--red)]";
  if (p.includes("P1")) return "bg-[rgba(219,109,40,0.15)] text-[var(--orange)]";
  if (p.includes("P2")) return "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]";
  return "bg-[rgba(139,148,158,0.15)] text-[var(--text-dim)]";
}

export default function TaskItem({
  page,
  onClick,
  selectable,
  selected,
  onSelect,
}: {
  page: NotionPage;
  onClick?: (page: NotionPage) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (page: NotionPage, selected: boolean) => void;
}) {
  const title = prop(page, "Task") || prop(page, "Name") || "Untitled";
  const priority = prop(page, "Priority");
  const context = prop(page, "Context");
  const source = prop(page, "Source");
  const project = prop(page, "Project");
  const notes = prop(page, "Notes");

  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSaveTitle() {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === title) { setEditing(false); setTitleDraft(title); return; }
    setSaving(true);
    try {
      await fetch("/api/corrections", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: page.id, oldTitle: title, newTitle: trimmed }),
      });
      // The title will update on next data refresh
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 border-b border-[var(--border)] hover:bg-[rgba(88,166,255,0.03)] ${
        onClick && !selectable ? "cursor-pointer" : ""
      } ${selected ? "bg-[rgba(88,166,255,0.06)]" : ""}`}
      onClick={() => {
        if (selectable) {
          onSelect?.(page, !selected);
        } else {
          onClick?.(page);
        }
      }}
    >
      {selectable && (
        <div className="flex items-center pt-0.5 shrink-0">
          <input
            type="checkbox"
            checked={selected || false}
            onChange={(e) => {
              e.stopPropagation();
              onSelect?.(page, e.target.checked);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 rounded border-[var(--border)] bg-[var(--bg)] accent-[var(--accent)] cursor-pointer"
          />
        </div>
      )}
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSaveTitle();
              if (e.key === "Escape") { setEditing(false); setTitleDraft(title); }
            }}
            onBlur={handleSaveTitle}
            onClick={(e) => e.stopPropagation()}
            disabled={saving}
            className="text-sm w-full bg-[var(--bg)] border border-[var(--accent)] rounded px-2 py-0.5 text-[var(--text)] focus:outline-none"
            autoFocus
          />
        ) : (
          <div
            onClick={(e) => {
              if (selectable) return;
              e.stopPropagation();
              setTitleDraft(title);
              setEditing(true);
            }}
            className={`text-sm text-[var(--text-bright)] ${
              !selectable ? "cursor-text hover:underline hover:decoration-dotted hover:decoration-[var(--text-dim)]" : ""
            } ${flash ? "text-[var(--green)]" : ""} ${saving ? "opacity-50" : ""}`}
            title={!selectable ? "Click to edit" : undefined}
          >
            {title}{flash && " \u2713"}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 mt-1">
          {priority && (
            <EditableBadge pageId={page.id} field="Priority" value={priority} displayValue={priority.split(" ")[0]} />
          )}
          {context && (
            <EditableBadge pageId={page.id} field="Context" value={context} />
          )}
          {source && (
            <EditableBadge pageId={page.id} field="Source" value={source} />
          )}
          {project && (
            <EditableBadge pageId={page.id} field="Project" value={project} />
          )}
        </div>
        {notes && (
          <div className="text-xs text-[var(--text-dim)] mt-1 line-clamp-2">
            {notes}
          </div>
        )}
      </div>
      {onClick && !selectable && (
        <div className="text-[var(--text-dim)] text-xs mt-1 shrink-0">›</div>
      )}
    </div>
  );
}
