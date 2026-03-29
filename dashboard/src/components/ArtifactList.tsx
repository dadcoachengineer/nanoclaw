"use client";

import { useState, useEffect } from "react";

interface ArtifactMeta {
  id: string;
  title: string;
  intent: string;
  createdAt: string;
  charCount: number;
  project?: string;
  mentionedPeople?: string[];
}

/**
 * Reusable artifact list — fetches and displays artifacts filtered by person, project, or taskId.
 * Use in People, Topics, Initiatives, and TaskDetail views.
 */
export default function ArtifactList({
  person,
  project,
  taskId,
  label,
}: {
  person?: string;
  project?: string;
  taskId?: string;
  label?: string;
}) {
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (person) params.set("person", person);
    if (project) params.set("project", project);
    if (taskId) params.set("taskId", taskId);
    fetch(`/api/artifacts?${params}`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setArtifacts(data); })
      .catch(() => {});
  }, [person, project, taskId]);

  if (artifacts.length === 0) return null;

  async function toggle(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    setContent(null);
    try {
      const resp = await fetch(`/api/artifacts?id=${id}`);
      const data = await resp.json();
      if (data.content) setContent(data.content);
    } catch { /* ignore */ }
  }

  return (
    <div className="mt-4">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium mb-2">
        {label || "Artifacts"} ({artifacts.length})
      </div>
      {artifacts.map((a) => (
        <div key={a.id} className="mb-2">
          <button
            onClick={() => toggle(a.id)}
            className="w-full text-left flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-[rgba(88,166,255,0.04)] transition-colors"
          >
            <div className="w-6 h-6 rounded bg-[rgba(63,185,80,0.12)] flex items-center justify-center text-[10px] font-bold text-[var(--green)] shrink-0">
              A
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-[var(--text)] truncate">{a.title}</div>
              <div className="text-[10px] text-[var(--text-dim)]">
                {new Date(a.createdAt).toLocaleDateString()} — {a.charCount.toLocaleString()} chars
                {a.mentionedPeople && a.mentionedPeople.length > 0 && (
                  <span className="ml-2">{a.mentionedPeople.slice(0, 3).join(", ")}{a.mentionedPeople.length > 3 ? ` +${a.mentionedPeople.length - 3}` : ""}</span>
                )}
              </div>
            </div>
            <span className="text-[var(--text-dim)] text-xs">{expanded === a.id ? "\u25BE" : "\u25B8"}</span>
          </button>
          {expanded === a.id && content && (
            <div className="mt-1 bg-[var(--bg)] rounded-lg px-4 py-3 text-xs text-[var(--text)] max-h-[300px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden leading-relaxed space-y-1">
              {content.split("\n").map((line, i) => {
                if (line.startsWith("---") || line.match(/^(title|intent|created|taskId|taskTitle|project|sources|mentionedPeople):/)) return null;
                if (line.startsWith("### ")) return <h3 key={i} className="text-xs font-bold text-[var(--text-bright)] mt-3 mb-1">{line.replace("### ", "")}</h3>;
                if (line.startsWith("## ")) return <h2 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-3 mb-1">{line.replace("## ", "")}</h2>;
                if (line.startsWith("# ")) return <h2 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-3 mb-1">{line.replace("# ", "")}</h2>;
                if (line.startsWith("- ") || line.startsWith("* ")) return <div key={i} className="flex gap-2"><span className="text-[var(--text-dim)] shrink-0">&bull;</span><span>{line.slice(2)}</span></div>;
                if (!line.trim()) return <div key={i} className="h-1.5" />;
                return <p key={i}>{line}</p>;
              })}
              <button
                onClick={async () => { try { await navigator.clipboard.writeText(content); } catch {} }}
                className="mt-2 text-[10px] text-[var(--accent)] hover:underline"
              >
                Copy to clipboard
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
