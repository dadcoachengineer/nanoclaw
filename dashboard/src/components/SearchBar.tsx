"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/Card";
import { timeAgo } from "@/lib/dates";

interface SearchResult {
  id: string;
  source: string;
  text: string;
  metadata: Record<string, string>;
  distance: number;
}

const SOURCE_COLORS: Record<string, string> = {
  transcript: "var(--purple)",
  webex_message: "var(--green)",
  notion_task: "var(--yellow)",
};

const SOURCE_LABELS: Record<string, string> = {
  transcript: "Transcript",
  webex_message: "Message",
  notion_task: "Task",
};

export default function SearchBar() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);

  async function search(q: string) {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const resp = await fetch(
        `/api/search?q=${encodeURIComponent(q)}&limit=10`
      );
      const data = await resp.json();
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="relative">
      <input
        type="text"
        placeholder="Search across all sources..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            search(query);
            setOpen(true);
          }
        }}
        onFocus={() => results.length > 0 && setOpen(true)}
        className="w-64 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)]"
      />
      {searching && (
        <span className="absolute right-3 top-2 text-xs text-[var(--text-dim)]">
          ...
        </span>
      )}

      {/* Results dropdown */}
      {open && results.length > 0 && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute top-full right-0 mt-2 w-[500px] z-50 bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-2xl max-h-[70vh] overflow-y-auto">
            <div className="px-4 py-2 border-b border-[var(--border)] text-xs text-[var(--text-dim)]">
              {results.length} results for &ldquo;{query}&rdquo;
            </div>
            {results.map((r, i) => (
              <div
                key={i}
                className="px-4 py-3 border-b border-[var(--border)] hover:bg-[rgba(88,166,255,0.03)] last:border-0"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                    style={{
                      color: SOURCE_COLORS[r.source] || "var(--text-dim)",
                      background: `color-mix(in srgb, ${SOURCE_COLORS[r.source] || "var(--text-dim)"} 15%, transparent)`,
                    }}
                  >
                    {SOURCE_LABELS[r.source] || r.source}
                  </span>
                  {r.metadata.person && (
                    <span className="text-xs text-[var(--accent)]">
                      {r.metadata.person}
                    </span>
                  )}
                  {r.metadata.topic && (
                    <span className="text-xs text-[var(--text-dim)]">
                      {r.metadata.topic}
                    </span>
                  )}
                  {r.metadata.date && (
                    <span className="text-xs text-[var(--text-dim)] ml-auto">
                      {new Date(r.metadata.date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  )}
                </div>
                <div className="text-sm text-[var(--text)] line-clamp-2">
                  {r.text}
                </div>
                <div className="text-xs text-[var(--text-dim)] mt-1">
                  relevance: {Math.round((1 - r.distance) * 100)}%
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
