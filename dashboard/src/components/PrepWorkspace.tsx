"use client";

import { useState, useRef, useEffect } from "react";

interface ArtifactMeta {
  id: string;
  title: string;
  intent: string;
  createdAt: string;
  charCount: number;
}

interface PrepWorkspaceProps {
  topic: string;
  taskId?: string;
  taskTitle?: string;
  taskNotes?: string;
  project?: string;
  initialBody?: string;
  intent?: string;
  onClose: () => void;
}

export default function PrepWorkspace({
  topic,
  taskNotes,
  project,
  initialBody,
  intent,
  taskId,
  taskTitle,
  onClose,
}: PrepWorkspaceProps) {
  const [documents, setDocuments] = useState<{ name: string; text: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urls, setUrls] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [brief, setBrief] = useState<string | null>(initialBody || null);
  const [sources, setSources] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteDraft, setPasteDraft] = useState("");
  const [guidance, setGuidance] = useState("");

  async function runResearch() {
    setRunning(true);
    setError(null);
    setBrief(null);
    try {
      const resp = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          taskNotes,
          project,
          documents: documents.length > 0 ? documents.map((d) => `[${d.name}]\n${d.text}`) : undefined,
          urls: urls.length > 0 ? urls : undefined,
          guidance: guidance.trim() || undefined,
          intent: intent || undefined,
        }),
      });
      const data = await resp.json();
      if (data.error) {
        setError(data.error);
      } else {
        setBrief(data.brief);
        setSources(data.sources || []);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;
    setUploading(true);
    setError(null);
    // Upload files in small batches to avoid timeouts on image OCR
    const BATCH_SIZE = 2;
    const errors: string[] = [];
    try {
      for (let i = 0; i < fileArray.length; i += BATCH_SIZE) {
        const batch = fileArray.slice(i, i + BATCH_SIZE);
        const formData = new FormData();
        for (const f of batch) formData.append("files", f);
        const resp = await fetch("/api/research/extract", { method: "POST", body: formData });
        const text = await resp.text();
        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          errors.push(`Upload batch failed: ${text.slice(0, 100)}`);
          continue;
        }
        if (data.error) {
          errors.push(data.error);
        } else {
          const extracted = (data.files || []) as { name: string; text: string; error?: string }[];
          for (const f of extracted) {
            if (f.error) {
              errors.push(`${f.name}: ${f.error}`);
            } else if (f.text) {
              setDocuments((prev) => [...prev, { name: f.name, text: f.text }]);
            }
          }
        }
      }
      if (errors.length > 0) setError(errors.join("\n"));
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
    }
  }

  function addPastedText() {
    const text = pasteDraft.trim();
    if (!text) return;
    setDocuments((prev) => [...prev, { name: "Pasted text", text }]);
    setPasteDraft("");
    setPasteMode(false);
  }

  function addUrl() {
    const url = urlInput.trim();
    if (!url) return;
    setUrls((prev) => [...prev, url]);
    setUrlInput("");
  }

  async function handleCopy() {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(brief);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = brief;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const [saved, setSaved] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [viewingArtifact, setViewingArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<string | null>(null);

  // Load existing artifacts for this task
  useEffect(() => {
    if (!taskId) return;
    fetch(`/api/artifacts?taskId=${taskId}`).then((r) => r.json()).then((data) => {
      if (Array.isArray(data)) setArtifacts(data);
    }).catch(() => {});
  }, [taskId]);

  async function saveArtifact() {
    if (!brief) return;
    setSaved(false);
    try {
      const resp = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: intent || topic,
          content: brief,
          intent: intent || "research",
          taskId,
          taskTitle: taskTitle || topic,
          project,
          sources,
        }),
      });
      if (resp.ok) {
        const meta = await resp.json();
        setArtifacts((prev) => [meta, ...prev]);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch { /* continue */ }
  }

  async function loadArtifact(id: string) {
    setViewingArtifact(id);
    setArtifactContent(null);
    try {
      const resp = await fetch(`/api/artifacts?id=${id}`);
      const data = await resp.json();
      if (data.content) setArtifactContent(data.content);
    } catch { /* ignore */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="absolute right-0 top-0 bottom-0 w-[640px] bg-[var(--surface)] border-l border-[var(--border)] overflow-y-auto shadow-2xl flex flex-col">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[var(--surface)] border-b border-[var(--border)] px-5 py-4 shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--text-bright)]">Research Workspace</h2>
            <button onClick={onClose} className="text-[var(--text-dim)] hover:text-[var(--text)] text-lg leading-none">&times;</button>
          </div>
          <div className="text-xs text-[var(--text)] mt-1">{topic}</div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Auto-gathered context summary */}
          {(taskNotes || project) && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium mb-2">Auto-Gathered Context</div>
              <div className="bg-[var(--bg)] rounded-lg px-3 py-2 text-xs text-[var(--text-dim)] space-y-1">
                {project && <div>Project: <span className="text-[var(--text)]">{project}</span></div>}
                {taskNotes && <div className="line-clamp-3">Notes: <span className="text-[var(--text)]">{taskNotes}</span></div>}
                <div className="text-[10px] italic">Person index, message history, and transcript data will be searched automatically.</div>
              </div>
            </div>
          )}

          {/* Document upload */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium mb-2">
              Documents ({documents.length})
            </div>

            {/* Uploaded files list */}
            {documents.map((doc, i) => (
              <div key={i} className="flex items-center gap-2 mb-2 bg-[var(--bg)] rounded-lg px-3 py-2">
                <div className="w-6 h-6 rounded bg-[rgba(88,166,255,0.1)] flex items-center justify-center text-[10px] font-bold text-[var(--accent)] shrink-0">
                  {doc.name.split(".").pop()?.toUpperCase().slice(0, 3) || "TXT"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-[var(--text)] truncate">{doc.name}</div>
                  <div className="text-[10px] text-[var(--text-dim)]">{doc.text.length.toLocaleString()} chars extracted</div>
                </div>
                <button
                  onClick={() => setDocuments((prev) => prev.filter((_, j) => j !== i))}
                  className="text-[var(--text-dim)] hover:text-[var(--red)] text-xs shrink-0"
                >
                  &times;
                </button>
              </div>
            ))}

            {/* Drop zone */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.csv,.txt,.md,.jpg,.jpeg,.png,.gif,.webp,.heic"
              className="hidden"
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg px-4 py-4 text-center cursor-pointer transition-colors ${
                dragging
                  ? "border-[var(--accent)] bg-[rgba(88,166,255,0.06)]"
                  : "border-[var(--border)] hover:border-[var(--accent)] hover:bg-[rgba(88,166,255,0.02)]"
              }`}
            >
              {uploading ? (
                <div className="text-xs text-[var(--accent)] animate-pulse">Extracting text from files...</div>
              ) : (
                <>
                  <div className="text-xs text-[var(--text-dim)]">
                    Drop files here or <span className="text-[var(--accent)]">browse</span>
                  </div>
                  <div className="text-[10px] text-[var(--text-dim)] mt-1">
                    PDF, Word, PowerPoint, Excel, Images, TXT
                  </div>
                </>
              )}
            </div>

            {/* Paste text toggle */}
            {!pasteMode ? (
              <button
                onClick={() => setPasteMode(true)}
                className="mt-2 text-[11px] text-[var(--text-dim)] hover:text-[var(--accent)]"
              >
                or paste text directly
              </button>
            ) : (
              <div className="mt-2">
                <textarea
                  value={pasteDraft}
                  onChange={(e) => setPasteDraft(e.target.value)}
                  placeholder="Paste document content, meeting notes, background info..."
                  rows={3}
                  className="w-full px-3 py-2 text-xs bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)] resize-y"
                />
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={addPastedText}
                    disabled={!pasteDraft.trim()}
                    className="text-[11px] text-[var(--accent)] hover:underline disabled:opacity-30"
                  >
                    + Add
                  </button>
                  <button
                    onClick={() => { setPasteMode(false); setPasteDraft(""); }}
                    className="text-[11px] text-[var(--text-dim)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* URL input */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium mb-2">
              Reference URLs ({urls.length})
            </div>
            {urls.map((url, i) => (
              <div key={i} className="flex items-center gap-2 mb-1">
                <span className="text-xs text-[var(--accent)] truncate flex-1">{url}</span>
                <button
                  onClick={() => setUrls((prev) => prev.filter((_, j) => j !== i))}
                  className="text-[var(--text-dim)] hover:text-[var(--red)] text-xs shrink-0"
                >
                  &times;
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addUrl(); }}
                placeholder="https://company-website.com"
                className="flex-1 h-7 px-2 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={addUrl}
                disabled={!urlInput.trim()}
                className="h-7 px-3 text-[11px] font-medium text-[var(--accent)] border border-[var(--border)] rounded hover:border-[var(--accent)] disabled:opacity-30"
              >
                Add
              </button>
            </div>
          </div>

          {/* Research guidance / prompt steering */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium mb-2">
              Research Guidance
            </div>
            <textarea
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder="Steer the research — e.g. 'Focus on their building portfolio and connectivity challenges' or 'Draft an org announcement using the attached background doc, emphasize her IoT and smart building experience'"
              rows={3}
              className="w-full px-3 py-2 text-xs bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)] resize-y"
            />
          </div>

          {/* Run button */}
          <button
            onClick={runResearch}
            disabled={running}
            className={`w-full h-10 text-sm font-medium rounded-lg transition-all ${
              running
                ? "bg-[var(--accent)] text-white opacity-70 animate-pulse"
                : "bg-[var(--accent)] text-white hover:opacity-90"
            }`}
          >
            {running ? "Researching — analyzing context, messages, transcripts..." : "Run Research"}
          </button>

          {error && (
            <div className="p-3 bg-[rgba(248,81,73,0.1)] border border-[var(--red)] rounded-lg text-xs text-[var(--red)]">
              {error}
            </div>
          )}

          {/* Research brief output */}
          {brief && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium">Research Brief</div>
                {sources.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {sources.map((s, i) => (
                      <span key={i} className="text-[9px] px-1.5 py-0.5 rounded-full bg-[rgba(88,166,255,0.08)] text-[var(--accent)]">
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-[var(--bg)] rounded-lg px-4 py-3 text-sm text-[var(--text)] leading-relaxed space-y-3 prose-sm">
                {brief.split("\n").map((line, i) => {
                  if (line.startsWith("### ")) return <h3 key={i} className="text-xs font-bold text-[var(--text-bright)] mt-4 mb-1">{line.replace("### ", "")}</h3>;
                  if (line.startsWith("## ")) return <h2 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-4 mb-1">{line.replace("## ", "")}</h2>;
                  if (line.startsWith("- ") || line.startsWith("* ")) return <div key={i} className="flex gap-2 text-xs"><span className="text-[var(--text-dim)] shrink-0">•</span><span>{line.slice(2)}</span></div>;
                  if (line.match(/^\d+\.\s/)) return <div key={i} className="flex gap-2 text-xs"><span className="text-[var(--accent)] shrink-0 w-4 text-right">{line.match(/^(\d+)\./)?.[1]}.</span><span>{line.replace(/^\d+\.\s/, "")}</span></div>;
                  if (line.startsWith("> ")) return <div key={i} className="border-l-2 border-[var(--accent)] pl-3 text-xs italic text-[var(--text-dim)]">{line.slice(2)}</div>;
                  if (!line.trim()) return <div key={i} className="h-2" />;
                  return <p key={i} className="text-xs">{line}</p>;
                })}
              </div>

              {/* Action buttons */}
              <div className="flex gap-2 mt-3">
                <button
                  onClick={handleCopy}
                  className={`flex-1 h-8 text-xs font-medium rounded-md transition-all ${
                    copied ? "bg-[var(--green)] text-white" : "bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)]"
                  }`}
                >
                  {copied ? "Copied!" : "Copy Brief"}
                </button>
                <button
                  onClick={saveArtifact}
                  className={`flex-1 h-8 text-xs font-medium rounded-md transition-all ${
                    saved ? "bg-[var(--green)] text-white" : "bg-[var(--accent)] text-white hover:opacity-90"
                  }`}
                >
                  {saved ? "Saved!" : "Save Artifact"}
                </button>
                <button
                  onClick={runResearch}
                  disabled={running}
                  className="h-8 px-3 text-xs text-[var(--text-dim)] hover:text-[var(--accent)] border border-[var(--border)] rounded-md"
                >
                  Regenerate
                </button>
              </div>
            </div>
          )}

          {/* Saved artifacts for this task */}
          {artifacts.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-medium mb-2">
                Saved Artifacts ({artifacts.length})
              </div>
              {artifacts.map((a) => (
                <div key={a.id} className="mb-2">
                  <button
                    onClick={() => viewingArtifact === a.id ? setViewingArtifact(null) : loadArtifact(a.id)}
                    className="w-full text-left flex items-center gap-2 bg-[var(--bg)] rounded-lg px-3 py-2 hover:bg-[rgba(88,166,255,0.04)] transition-colors"
                  >
                    <div className="w-6 h-6 rounded bg-[rgba(63,185,80,0.12)] flex items-center justify-center text-[10px] font-bold text-[var(--green)] shrink-0">
                      A
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-[var(--text)] truncate">{a.title}</div>
                      <div className="text-[10px] text-[var(--text-dim)]">
                        {new Date(a.createdAt).toLocaleDateString()} — {a.charCount.toLocaleString()} chars
                      </div>
                    </div>
                    <span className="text-[var(--text-dim)] text-xs">{viewingArtifact === a.id ? "▾" : "▸"}</span>
                  </button>
                  {viewingArtifact === a.id && artifactContent && (
                    <div className="mt-1 bg-[var(--bg)] rounded-lg px-4 py-3 text-xs text-[var(--text)] max-h-[300px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden leading-relaxed">
                      {artifactContent.split("\n").map((line, i) => {
                        if (line.startsWith("---") || line.match(/^(title|intent|created|taskId|taskTitle|project|sources):/)) return null;
                        if (line.startsWith("### ")) return <h3 key={i} className="text-xs font-bold text-[var(--text-bright)] mt-3 mb-1">{line.replace("### ", "")}</h3>;
                        if (line.startsWith("## ")) return <h2 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-3 mb-1">{line.replace("## ", "")}</h2>;
                        if (line.startsWith("# ")) return <h2 key={i} className="text-sm font-bold text-[var(--text-bright)] mt-3 mb-1">{line.replace("# ", "")}</h2>;
                        if (line.startsWith("- ") || line.startsWith("* ")) return <div key={i} className="flex gap-2"><span className="text-[var(--text-dim)] shrink-0">•</span><span>{line.slice(2)}</span></div>;
                        if (!line.trim()) return <div key={i} className="h-1.5" />;
                        return <p key={i}>{line}</p>;
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
