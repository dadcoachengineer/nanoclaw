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
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
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

  async function sendViaWebex() {
    if (!roomId || !draft) return;
    setSending(true);
    try {
      const resp = await fetch("/api/send-webex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, text: draft }),
      });
      const data = await resp.json();
      if (data.id) {
        setSent(true);
        setTimeout(onClose, 1500);
      } else {
        setError(data.error || "Failed to send");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  }

  function copyToClipboard() {
    navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

          {sent && (
            <div className="flex items-center justify-center gap-2 py-6 text-[var(--green)]">
              <span className="text-lg">&#10003;</span> Sent via Webex
            </div>
          )}

          {draft && !sent && (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-lg px-4 py-3 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--accent)] resize-y"
            />
          )}
        </div>

        {/* Actions */}
        {draft && !sent && (
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
              onClick={copyToClipboard}
              className="px-4 py-1.5 bg-[var(--surface2)] border border-[var(--border)] text-sm text-[var(--text)] rounded-md hover:border-[var(--accent)]"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            {roomId && (
              <button
                onClick={sendViaWebex}
                disabled={sending}
                className="px-4 py-1.5 bg-[var(--accent)] text-[var(--bg)] text-sm font-medium rounded-md hover:opacity-90 disabled:opacity-50"
              >
                {sending ? "Sending..." : "Send via Webex"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
