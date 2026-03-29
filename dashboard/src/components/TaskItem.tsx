"use client";

import { useState, useRef, useEffect } from "react";
import { NotionPage, prop } from "@/lib/notion";
import EditableBadge from "@/components/EditableBadge";

interface Initiative {
  slug: string;
  name: string;
  status: string;
  pinnedTaskIds?: string[];
}

// Shared initiative cache — fetched once, shared across all TaskItems
let _initiativeCache: Initiative[] | null = null;
let _initiativeFetching = false;
const _initiativeListeners: Set<(data: Initiative[]) => void> = new Set();

function fetchInitiatives() {
  _initiativeFetching = true;
  fetch("/api/initiatives").then((r) => r.json()).then((data: Initiative[]) => {
    _initiativeCache = data;
    _initiativeFetching = false;
    _initiativeListeners.forEach((l) => l(data));
  }).catch(() => { _initiativeFetching = false; });
}

/** Call this after any initiative mutation to refresh all TaskItems */
function refreshInitiatives() {
  _initiativeCache = null;
  _initiativeFetching = false;
  fetchInitiatives();
}

function useInitiatives(): Initiative[] {
  const [initiatives, setInitiatives] = useState<Initiative[]>(_initiativeCache || []);
  useEffect(() => {
    const listener = (data: Initiative[]) => setInitiatives(data);
    _initiativeListeners.add(listener);
    if (_initiativeCache) {
      setInitiatives(_initiativeCache);
    } else if (!_initiativeFetching) {
      fetchInitiatives();
    }
    return () => { _initiativeListeners.delete(listener); };
  }, []);
  return initiatives;
}

// Shared artifact index cache — taskIds that have artifacts
let _artifactTaskIds: Set<string> | null = null;
let _artifactFetching = false;
const _artifactListeners: (() => void)[] = [];

function useHasArtifact(taskId: string): boolean {
  const [has, setHas] = useState<boolean>(_artifactTaskIds?.has(taskId) ?? false);
  useEffect(() => {
    if (_artifactTaskIds) { setHas(_artifactTaskIds.has(taskId)); return; }
    const listener = () => setHas(_artifactTaskIds?.has(taskId) ?? false);
    _artifactListeners.push(listener);
    if (!_artifactFetching) {
      _artifactFetching = true;
      fetch("/api/artifacts").then((r) => r.json()).then((data: { taskId?: string }[]) => {
        _artifactTaskIds = new Set(data.filter((a) => a.taskId).map((a) => a.taskId!));
        _artifactListeners.forEach((l) => l());
      }).catch(() => {});
    }
    return () => {
      const idx = _artifactListeners.indexOf(listener);
      if (idx >= 0) _artifactListeners.splice(idx, 1);
    };
  }, [taskId]);
  return has;
}

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
  const initiatives = useInitiatives();
  const initiative = initiatives.find((ini) => ini.pinnedTaskIds?.includes(page.id));
  const hasArtifact = useHasArtifact(page.id);

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
          <InitiativePill pageId={page.id} current={initiative} initiatives={initiatives} />
          {hasArtifact && (
            <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium bg-[rgba(63,185,80,0.12)] text-[var(--green)]">
              Artifact
            </span>
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

function InitiativePill({
  pageId,
  current,
  initiatives,
}: {
  pageId: string;
  current?: Initiative;
  initiatives: Initiative[];
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newMode, setNewMode] = useState(false);
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setNewMode(false);
        setNewName("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function assign(slug: string) {
    setSaving(true);
    setOpen(false);
    // Unpin from current
    if (current) {
      await fetch("/api/initiatives", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: current.slug, unpinTask: pageId }),
      });
    }
    // Pin to new
    await fetch("/api/initiatives", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, pinTask: pageId }),
    });
    // Refresh all TaskItem initiative pills
    refreshInitiatives();
    setSaving(false);
  }

  async function createAndAssign() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    setOpen(false);
    setNewMode(false);
    try {
      const resp = await fetch("/api/initiatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: name, keywords: [name.toLowerCase()] }),
      });
      if (resp.ok) {
        const created = await resp.json();
        refreshInitiatives();
        if (created.slug) await assign(created.slug);
      }
    } finally {
      setSaving(false);
      setNewName("");
    }
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        disabled={saving}
        className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
          current
            ? "bg-[rgba(56,178,172,0.12)] text-[#38b2ac] hover:bg-[rgba(56,178,172,0.2)]"
            : "bg-[rgba(139,148,158,0.08)] text-[var(--text-dim)] hover:text-[#38b2ac] hover:bg-[rgba(56,178,172,0.08)]"
        } ${saving ? "opacity-50" : ""}`}
      >
        {saving ? "..." : current ? current.name : "+ Initiative"}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-30 min-w-[180px] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg py-1 max-h-[200px] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[10px] text-[var(--text-dim)] uppercase tracking-wider">Initiative</div>
          {initiatives.filter((i) => i.status === "active").map((ini) => (
            <button
              key={ini.slug}
              className={`block w-full text-left px-3 py-1.5 text-xs transition-colors ${
                current?.slug === ini.slug
                  ? "text-[#38b2ac] bg-[rgba(56,178,172,0.08)] font-medium"
                  : "text-[var(--text)] hover:bg-[rgba(56,178,172,0.06)]"
              }`}
              onClick={() => assign(ini.slug)}
            >
              {current?.slug === ini.slug ? "\u2713 " : ""}{ini.name}
            </button>
          ))}
          {!newMode ? (
            <button
              className="block w-full text-left px-3 py-1.5 text-xs text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[rgba(88,166,255,0.04)] border-t border-[var(--border)] mt-1 pt-1.5"
              onClick={() => setNewMode(true)}
            >
              + New Initiative
            </button>
          ) : (
            <div className="px-3 py-1.5 border-t border-[var(--border)] mt-1 pt-1.5">
              <input
                type="text"
                placeholder="Initiative name..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createAndAssign(); }}
                className="w-full h-6 px-2 text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[#38b2ac]"
                autoFocus
              />
              <div className="flex gap-1 mt-1">
                <button
                  onClick={createAndAssign}
                  disabled={!newName.trim()}
                  className="flex-1 h-5 text-[10px] font-medium bg-[#38b2ac] text-white rounded hover:opacity-90 disabled:opacity-40"
                >
                  Create
                </button>
                <button
                  onClick={() => { setNewMode(false); setNewName(""); }}
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
  );
}
