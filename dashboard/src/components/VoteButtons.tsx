"use client";

import { useState } from "react";

/**
 * Compact up/down vote buttons for relevance scoring.
 * Appears on hover, records votes via /api/relevance.
 */
export default function VoteButtons({
  context,
  itemType,
  itemId,
  initialScore,
  onVoted,
}: {
  context: string;
  itemType: string;
  itemId: string;
  initialScore?: number;
  onVoted?: (newScore: number) => void;
}) {
  const [score, setScore] = useState(initialScore ?? 0);
  const [voting, setVoting] = useState(false);

  async function vote(direction: "up" | "down") {
    if (voting) return;
    setVoting(true);
    try {
      const resp = await fetch("/api/relevance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context, itemType, itemId, vote: direction }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setScore(data.score);
        onVoted?.(data.score);
      }
    } finally {
      setVoting(false);
    }
  }

  return (
    <span
      className="inline-flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => vote("up")}
        disabled={voting}
        className={`w-5 h-5 flex items-center justify-center rounded text-[11px] transition-colors ${
          score > 0
            ? "text-[var(--green)] bg-[rgba(63,185,80,0.12)]"
            : "text-[var(--text-dim)] hover:text-[var(--green)] hover:bg-[rgba(63,185,80,0.08)]"
        }`}
        title="More relevant"
      >
        ▲
      </button>
      {score !== 0 && (
        <span className={`text-[10px] min-w-[12px] text-center font-medium ${
          score > 0 ? "text-[var(--green)]" : "text-[var(--red)]"
        }`}>
          {score > 0 ? `+${score}` : score}
        </span>
      )}
      <button
        onClick={() => vote("down")}
        disabled={voting}
        className={`w-5 h-5 flex items-center justify-center rounded text-[11px] transition-colors ${
          score < 0
            ? "text-[var(--red)] bg-[rgba(248,81,73,0.12)]"
            : "text-[var(--text-dim)] hover:text-[var(--red)] hover:bg-[rgba(248,81,73,0.08)]"
        }`}
        title="Less relevant"
      >
        ▼
      </button>
    </span>
  );
}
