"use client";

import { useState } from "react";

interface ReplyDrafterProps {
  message: string;
  personName: string;
  personEmail?: string;
  channel: string;
  roomId?: string;
  onClose: () => void;
}

function copyText(text: string): boolean {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // Fallback for non-HTTPS (LAN)
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  return true;
}

export default function ReplyDrafter({
  message,
  personName,
  personEmail,
  channel,
  roomId,
  onClose,
}: ReplyDrafterProps) {
  const [draft, setDraft] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generateDraft() {
    setGenerating(true);
    setError(null);
    try {
      const resp = await fetch("/api/draft-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          personName,
          personEmail,
          channel,
        }),
      });
      const data = await resp.json();
      if (data.error) {
        setError(data.error);
      } else {
        setDraft(data.reply);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }

  function handleCopy() {
    copyText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  }

  function handleCopyAndOpen() {
    copyText(draft);
    setCopied(true);
    // Use email-based deep link — most reliable for opening the right conversation
    if (personEmail) {
      window.location.href = `webexteams://im?email=${encodeURIComponent(personEmail)}`;
    } else if (roomId) {
      window.location.href = `webexteams://im?space=${roomId}`;
    }
  }

  // Auto-generate on mount
  if (!draft && !generating && !error) {
    generateDraft();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative w-[550px] bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-bright)]">
                Draft Reply to {personName}
              </h2>
              <div className="text-xs text-[var(--text-dim)] mt-0.5">
                via {channel}
                {personEmail && <span className="ml-1">({personEmail})</span>}
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-[var(--text-dim)] hover:text-[var(--text)] text-lg px-2"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Original message */}
        <div className="px-5 py-3 bg-[var(--bg)] border-b border-[var(--border)]">
          <div className="text-xs text-[var(--text-dim)] mb-1">
            {personName} wrote:
          </div>
          <div className="text-sm text-[var(--text)] italic">
            &ldquo;{message.slice(0, 300)}
            {message.length > 300 ? "..." : ""}&rdquo;
          </div>
        </div>

        {/* Draft area */}
        <div className="px-5 py-4">
          {generating && (
            <div className="flex items-center gap-3 py-6 justify-center text-[var(--text-dim)]">
              <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              Drafting with context...
            </div>
          )}

          {error && (
            <div className="text-sm text-[var(--red)] py-4 text-center">
              {error}
              <button
                onClick={generateDraft}
                className="block mx-auto mt-2 text-xs text-[var(--accent)] hover:underline"
              >
                Retry
              </button>
            </div>
          )}

          {draft && (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-lg px-4 py-3 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--accent)] resize-y"
            />
          )}

          {copied && (
            <div className="text-xs text-[var(--green)] mt-2 text-center">
              Copied to clipboard — paste in Webex with Cmd+V
            </div>
          )}
        </div>

        {/* Actions */}
        {draft && (
          <div className="px-5 py-3 border-t border-[var(--border)] flex items-center gap-3">
            <button
              onClick={generateDraft}
              disabled={generating}
              className="px-3 py-1.5 text-sm text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-50"
            >
              Regenerate
            </button>
            <div className="flex-1" />
            <button
              onClick={handleCopy}
              className="px-4 py-1.5 bg-[var(--surface2)] border border-[var(--border)] text-sm text-[var(--text)] rounded-md hover:border-[var(--accent)]"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            {(personEmail || roomId) && (
              <button
                onClick={handleCopyAndOpen}
                className="px-4 py-1.5 bg-[var(--accent)] text-[var(--bg)] text-sm font-medium rounded-md hover:opacity-90"
              >
                Copy & Open Webex
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
