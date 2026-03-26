"use client";

import { useState, useRef, useEffect } from "react";

/** Notion property options for each editable field */
const PROPERTY_OPTIONS: Record<string, { values: string[]; notionType: string; notionKey: string }> = {
  Priority: {
    values: ["P0 — Today", "P1 — This Week", "P2 — This Month", "P3 — Backlog"],
    notionType: "select",
    notionKey: "Priority",
  },
  Status: {
    values: ["Not started", "In progress", "Done"],
    notionType: "status",
    notionKey: "Status",
  },
  Context: {
    values: ["Quick Win", "Deep Work", "Research (Claude)", "Draft (Claude)", "Waiting On"],
    notionType: "select",
    notionKey: "Context",
  },
  Source: {
    values: ["Claude", "Email", "PLAUD Recording", "Manual", "Voice Memo", "Calendar", "Webex"],
    notionType: "select",
    notionKey: "Source",
  },
  Project: {
    values: ["Cisco", "MomentumEQ", "Elevation", "Ordinary Epics", "jasonshearer.me", "Home", "Personal"],
    notionType: "select",
    notionKey: "Project",
  },
  "Delegated To": {
    values: ["Jason", "Claude"],
    notionType: "select",
    notionKey: "Delegated To",
  },
};

function badgeCls(field: string, value: string): string {
  const base = "inline-block px-2.5 py-0.5 rounded-full text-xs font-medium cursor-pointer transition-opacity hover:opacity-80";
  if (field === "Priority" || field === "priority") {
    if (value.includes("P0")) return `${base} bg-[rgba(248,81,73,0.15)] text-[var(--red)]`;
    if (value.includes("P1")) return `${base} bg-[rgba(219,109,40,0.15)] text-[var(--orange)]`;
    if (value.includes("P2")) return `${base} bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]`;
    return `${base} bg-[rgba(139,148,158,0.15)] text-[var(--text-dim)]`;
  }
  if (field === "Status" || field === "status") {
    if (value === "Done") return `${base} bg-[rgba(63,185,80,0.15)] text-[var(--green)]`;
    if (value === "In progress") return `${base} bg-[rgba(88,166,255,0.15)] text-[var(--accent)]`;
    return `${base} bg-[rgba(139,148,158,0.15)] text-[var(--text-dim)]`;
  }
  if (field === "Context") return `${base} bg-[rgba(188,140,255,0.12)] text-[var(--purple)]`;
  if (field === "Source") return `${base} bg-[rgba(88,166,255,0.08)] text-[var(--accent)]`;
  return `${base} bg-[rgba(139,148,158,0.1)] text-[var(--text-dim)]`;
}

function optionCls(field: string, value: string, isSelected: boolean): string {
  const selected = isSelected ? "ring-1 ring-[var(--accent)]" : "";
  // Reuse badge colors but with hover
  const base = `block w-full text-left px-3 py-1.5 text-xs rounded-md transition-colors ${selected}`;
  if (field === "Priority") {
    if (value.includes("P0")) return `${base} text-[var(--red)] hover:bg-[rgba(248,81,73,0.1)]`;
    if (value.includes("P1")) return `${base} text-[var(--orange)] hover:bg-[rgba(219,109,40,0.1)]`;
    if (value.includes("P2")) return `${base} text-[var(--yellow)] hover:bg-[rgba(210,153,34,0.1)]`;
    return `${base} text-[var(--text-dim)] hover:bg-[rgba(139,148,158,0.1)]`;
  }
  if (field === "Status") {
    if (value === "Done") return `${base} text-[var(--green)] hover:bg-[rgba(63,185,80,0.1)]`;
    if (value === "In progress") return `${base} text-[var(--accent)] hover:bg-[rgba(88,166,255,0.1)]`;
    return `${base} text-[var(--text-dim)] hover:bg-[rgba(139,148,158,0.1)]`;
  }
  return `${base} text-[var(--text)] hover:bg-[rgba(88,166,255,0.06)]`;
}

export default function EditableBadge({
  pageId,
  field,
  value,
  displayValue,
  onUpdated,
}: {
  pageId: string;
  field: string;
  value: string;
  displayValue?: string;
  onUpdated?: (field: string, newValue: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(value);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const config = PROPERTY_OPTIONS[field];

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function selectOption(newValue: string) {
    if (newValue === current || !config) return;
    setSaving(true);
    setOpen(false);

    const propPayload =
      config.notionType === "status"
        ? { [config.notionKey]: { status: { name: newValue } } }
        : { [config.notionKey]: { select: { name: newValue } } };

    try {
      const resp = await fetch("/api/notion/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_id: pageId, properties: propPayload }),
      });
      if (resp.ok) {
        setCurrent(newValue);
        onUpdated?.(field, newValue);
      }
    } finally {
      setSaving(false);
    }
  }

  // Non-editable fallback if no config
  if (!config) {
    return <span className={badgeCls(field, current)}>{displayValue || current}</span>;
  }

  return (
    <div ref={ref} className="relative inline-block">
      <span
        className={`${badgeCls(field, current)} ${saving ? "opacity-50" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {displayValue || current}
      </span>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-[60] min-w-[180px] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg py-1 space-y-0.5">
          <div className="px-3 py-1 text-[10px] text-[var(--text-dim)] uppercase tracking-wider">
            {field}
          </div>
          {config.values.map((opt) => (
            <button
              key={opt}
              className={optionCls(field, opt, opt === current)}
              onClick={(e) => {
                e.stopPropagation();
                selectOption(opt);
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
