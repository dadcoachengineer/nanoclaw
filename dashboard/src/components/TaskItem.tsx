"use client";

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
}: {
  page: NotionPage;
  onClick?: (page: NotionPage) => void;
}) {
  const title = prop(page, "Task") || prop(page, "Name") || "Untitled";
  const priority = prop(page, "Priority");
  const context = prop(page, "Context");
  const source = prop(page, "Source");
  const project = prop(page, "Project");
  const notes = prop(page, "Notes");

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 border-b border-[var(--border)] hover:bg-[rgba(88,166,255,0.03)] ${
        onClick ? "cursor-pointer" : ""
      }`}
      onClick={() => onClick?.(page)}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--text-bright)]">{title}</div>
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
      {onClick && (
        <div className="text-[var(--text-dim)] text-xs mt-1 shrink-0">›</div>
      )}
    </div>
  );
}
