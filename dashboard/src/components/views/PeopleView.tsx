"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, StatCard } from "@/components/Card";
import { timeAgo } from "@/lib/dates";
import ReplyDrafter from "@/components/ReplyDrafter";
import VoteButtons from "@/components/VoteButtons";
import ArtifactList from "@/components/ArtifactList";

interface PersonSummary {
  key: string;
  name: string;
  emails: string[];
  avatar: string | null;
  meetings: number;
  transcripts: number;
  messages: number;
  tasks: number;
  total: number;
}

interface PersonDetail {
  name: string;
  emails: string[];
  avatar?: string;
  company?: string;
  jobTitle?: string;
  profileNotes?: string;
  webexRoomIds: string[];
  meetings: { id: string; topic: string; date: string; role: string }[];
  transcriptMentions: {
    recordingId: string;
    topic: string;
    date: string;
    snippetCount: number;
    snippets: string[];
  }[];
  notionTasks: { id: string; title: string; status: string }[];
  messageExcerpts: { text: string; date: string; roomTitle: string }[];
  aiSummaries: {
    meetingId: string;
    title: string;
    date: string;
    summary: string;
    actionItems: string[];
  }[];
}

function Avatar({ name, avatar, size = "sm" }: { name: string; avatar?: string | null; size?: "sm" | "lg" }) {
  const initials = name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
  const cls = size === "lg"
    ? "w-12 h-12 text-lg"
    : "w-8 h-8 text-xs";

  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name}
        className={`${cls} rounded-full object-cover shrink-0`}
      />
    );
  }

  return (
    <div className={`${cls} rounded-full bg-[var(--surface2)] border border-[var(--border)] flex items-center justify-center font-medium text-[var(--accent)] shrink-0`}>
      {initials}
    </div>
  );
}

export default function PeopleView() {
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [selected, setSelected] = useState<PersonDetail | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [detailFilter, setDetailFilter] = useState<"all" | "meetings" | "transcripts" | "messages" | "tasks" | "summaries" | "artifacts">("all");
  const [personArtifacts, setPersonArtifacts] = useState<{ id: string; title: string; intent: string; createdAt: string; charCount: number }[]>([]);
  const [replyTo, setReplyTo] = useState<{ text: string; personName: string; personEmail?: string; roomId?: string } | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileDraft, setProfileDraft] = useState({ name: "", email: "", company: "", jobTitle: "", notes: "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const [lookupResults, setLookupResults] = useState<{ displayName: string; email?: string; title?: string; company?: string; source: string }[]>([]);
  const [showEnrich, setShowEnrich] = useState(false);
  const [enrichCandidates, setEnrichCandidates] = useState<{ key: string; name: string; interactions: number }[]>([]);
  const [enrichResults, setEnrichResults] = useState<Record<string, { displayName: string; email: string; title: string; company: string }[]>>({});
  const [enriching, setEnriching] = useState(false);
  const [enrichApplied, setEnrichApplied] = useState<Set<string>>(new Set());
  const [enrichAction, setEnrichAction] = useState<{ key: string; type: "rename" | "merge" } | null>(null);
  const [enrichInput, setEnrichInput] = useState("");

  const voteContext = selectedName ? `person:${selectedName}` : "";
  const updateScore = (itemType: string, itemId: string, s: number) => setScores((prev) => ({ ...prev, [`${itemType}:${itemId}`]: s }));
  const getScore = (itemType: string, itemId: string) => scores[`${itemType}:${itemId}`] ?? 0;
  const isSuppressed = (itemType: string, itemId: string) => getScore(itemType, itemId) <= -2;

  useEffect(() => {
    fetch("/api/people")
      .then((r) => r.json())
      .then((data) => {
        setPeople(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function selectPerson(name: string) {
    setSelectedName(name);
    setDetailFilter("all");
    setPersonArtifacts([]);
    const [resp, scoresResp] = await Promise.all([
      fetch(`/api/people?name=${encodeURIComponent(name)}`),
      fetch(`/api/relevance?context=${encodeURIComponent(`person:${name}`)}`).then(r => r.ok ? r.json() : { scores: {} }),
    ]);
    const data = await resp.json();
    setSelected(data);
    setScores(scoresResp.scores || {});
    // Fetch artifacts mentioning this person
    fetch(`/api/artifacts?person=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((arts) => { if (Array.isArray(arts)) setPersonArtifacts(arts); })
      .catch(() => {});
  }

  const filtered = filter
    ? people.filter(
        (p) =>
          p.name.toLowerCase().includes(filter.toLowerCase()) ||
          p.emails.some((e) => e.toLowerCase().includes(filter.toLowerCase()))
      )
    : people;

  const withEmail = people.filter((p) => p.emails.length > 0);
  const withTranscripts = people.filter((p) => p.transcripts > 0);
  const withMessages = people.filter((p) => p.messages > 0);

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard value={people.length} label="People" color="var(--accent)" />
        <StatCard value={withEmail.length} label="With Email" color="var(--green)" />
        <StatCard value={withTranscripts.length} label="In Transcripts" color="var(--purple)" />
        <StatCard value={withMessages.length} label="Messaged" color="var(--yellow)" />
      </div>

      {/* Enrich tool toggle */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={async () => {
            if (showEnrich) { setShowEnrich(false); return; }
            setShowEnrich(true);
            const resp = await fetch("/api/people/enrich");
            const data = await resp.json();
            setEnrichCandidates(data.candidates || []);
          }}
          className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
            showEnrich
              ? "border-[var(--accent)] text-[var(--accent)] bg-[rgba(88,166,255,0.08)]"
              : "border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
          }`}
        >
          {showEnrich ? "Close Enrichment Tool" : `Enrich Contacts (${people.length - withEmail.length} missing email)`}
        </button>
      </div>

      {showEnrich && (
        <Card>
          <CardHeader
            title={`Contact Enrichment — ${enrichCandidates.length} candidates`}
            right={
              <button
                disabled={enriching || enrichCandidates.length === 0}
                onClick={async () => {
                  setEnriching(true);
                  // Process in batches of 10
                  const remaining = enrichCandidates.filter((c) => !enrichApplied.has(c.key) && !enrichResults[c.key]);
                  for (let i = 0; i < remaining.length; i += 10) {
                    const batch = remaining.slice(i, i + 10);
                    try {
                      const resp = await fetch("/api/people/enrich", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ names: batch.map((c) => c.name) }),
                      });
                      const data = await resp.json();
                      const newResults: Record<string, any[]> = {};
                      for (const r of data.results || []) {
                        const candidate = batch.find((c) => c.name === r.name);
                        if (candidate) newResults[candidate.key] = r.matches;
                      }
                      setEnrichResults((prev) => ({ ...prev, ...newResults }));
                    } catch {}
                  }
                  setEnriching(false);
                }}
                className="text-xs px-3 py-1 font-medium bg-[var(--green)] text-white rounded hover:opacity-90 disabled:opacity-40"
              >
                {enriching ? "Looking up..." : "Lookup All via Webex"}
              </button>
            }
          />
          <div className="max-h-[400px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {enrichCandidates.slice(0, 50).map((c) => {
              const matches = enrichResults[c.key];
              const applied = enrichApplied.has(c.key);
              return (
                <div key={c.key} className={`px-4 py-2 border-b border-[var(--border)] ${applied ? "opacity-40" : ""}`}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <span className="text-sm text-[var(--text)]">{c.name}</span>
                      <span className="text-[10px] text-[var(--text-dim)] ml-2">{c.interactions} interactions</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {!matches && !applied && (
                        <button
                          onClick={async () => {
                            try {
                              const resp = await fetch("/api/people/enrich", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ names: [c.name] }),
                              });
                              const data = await resp.json();
                              const r = data.results?.[0];
                              if (r) setEnrichResults((prev) => ({ ...prev, [c.key]: r.matches }));
                            } catch {}
                          }}
                          className="text-[11px] text-[var(--accent)] hover:underline"
                        >
                          Lookup
                        </button>
                      )}
                      {!applied && (
                        <>
                          <button
                            onClick={() => { setEnrichAction({ key: c.key, type: "rename" }); setEnrichInput(c.name); }}
                            className="text-[11px] text-[var(--text-dim)] hover:text-[var(--yellow)]"
                          >
                            Rename
                          </button>
                          <button
                            onClick={() => { setEnrichAction({ key: c.key, type: "merge" }); setEnrichInput(""); }}
                            className="text-[11px] text-[var(--text-dim)] hover:text-[var(--purple)]"
                          >
                            Merge
                          </button>
                          <button
                            onClick={async () => {
                              if (!confirm(`Delete "${c.name}" from the person index?`)) return;
                              await fetch("/api/people/enrich", {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ deleteKeys: [c.key] }),
                              });
                              setEnrichCandidates((prev) => prev.filter((p) => p.key !== c.key));
                            }}
                            className="text-[11px] text-[var(--text-dim)] hover:text-[var(--red)]"
                          >
                            Delete
                          </button>
                        </>
                      )}
                      {applied && <span className="text-[11px] text-[var(--green)]">Done</span>}
                    </div>
                  </div>
                  {matches && matches.length > 0 && !applied && (
                    <div className="mt-1 ml-4 space-y-1">
                      {matches.map((m, i) => (
                        <button
                          key={i}
                          onClick={async () => {
                            await fetch("/api/people/enrich", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ updates: [{ key: c.key, email: m.email, company: m.company, jobTitle: m.title, avatar: m.avatar }] }),
                            });
                            setEnrichApplied((prev) => new Set([...prev, c.key]));
                          }}
                          className="flex items-center gap-2 text-xs text-[var(--text)] hover:text-[var(--accent)] hover:bg-[rgba(88,166,255,0.04)] px-2 py-1 rounded w-full text-left"
                        >
                          <span className="text-[var(--accent)]">{m.email}</span>
                          {m.title && <span className="text-[var(--text-dim)]">— {m.title}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  {matches && matches.length === 0 && !applied && (
                    <div className="mt-1 ml-4 text-[11px] text-[var(--text-dim)] italic">No Webex match found</div>
                  )}
                  {enrichAction?.key === c.key && (
                    <div className="mt-2 ml-4 flex items-center gap-2">
                      <span className="text-[10px] text-[var(--text-dim)] shrink-0">
                        {enrichAction.type === "rename" ? "New name:" : "Merge into:"}
                      </span>
                      <input
                        value={enrichInput}
                        onChange={(e) => setEnrichInput(e.target.value)}
                        placeholder={enrichAction.type === "merge" ? "Type target person name..." : "New name..."}
                        className="flex-1 h-6 px-2 text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
                        autoFocus
                        onKeyDown={(e) => e.key === "Escape" && setEnrichAction(null)}
                      />
                      <button
                        onClick={async () => {
                          if (!enrichInput.trim()) return;
                          if (enrichAction.type === "rename") {
                            await fetch("/api/people/enrich", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ rename: { key: c.key, newName: enrichInput.trim() } }),
                            });
                            setEnrichCandidates((prev) => prev.map((p) => p.key === c.key ? { ...p, name: enrichInput.trim() } : p));
                          } else {
                            // Merge: find target key
                            const targetKey = enrichInput.trim().toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
                            await fetch("/api/people/enrich", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ merge: { sourceKey: c.key, targetKey } }),
                            });
                            setEnrichCandidates((prev) => prev.filter((p) => p.key !== c.key));
                          }
                          setEnrichAction(null);
                          setEnrichInput("");
                        }}
                        className="h-6 px-2 text-[10px] font-medium bg-[var(--accent)] text-white rounded hover:opacity-90"
                      >
                        {enrichAction.type === "rename" ? "Rename" : "Merge"}
                      </button>
                      <button
                        onClick={() => setEnrichAction(null)}
                        className="h-6 px-1.5 text-[10px] text-[var(--text-dim)]"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-[320px_1fr] gap-6">
        {/* Left: People list */}
        <Card>
          <CardHeader
            title="People"
            right={
              <input
                type="text"
                placeholder="Filter..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-40 bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-xs text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)]"
              />
            }
          />
          <div className="max-h-[70vh] overflow-y-auto">
            {loading && (
              <div className="p-6 text-center text-[var(--text-dim)]">Loading...</div>
            )}
            {filtered.map((p) => (
              <div
                key={p.key}
                className={`flex items-center gap-4 px-4 py-3 border-b border-[var(--border)] cursor-pointer hover:bg-[rgba(88,166,255,0.03)] ${
                  selectedName === p.name ? "bg-[rgba(88,166,255,0.06)]" : ""
                }`}
                onClick={() => selectPerson(p.name)}
              >
                <Avatar name={p.name} avatar={p.avatar} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--text-bright)] truncate">
                    {p.name}
                  </div>
                  <div className="flex gap-3 text-xs text-[var(--text-dim)]">
                    {p.meetings > 0 && <span>{p.meetings} mtg</span>}
                    {p.transcripts > 0 && <span>{p.transcripts} trans</span>}
                    {p.messages > 0 && <span>{p.messages} msg</span>}
                    {p.tasks > 0 && <span>{p.tasks} tasks</span>}
                  </div>
                </div>
                <div className="text-xs text-[var(--text-dim)] tabular-nums shrink-0">
                  {p.total}
                </div>
                <div className="text-[var(--text-dim)] text-xs">›</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Right: Person detail */}
        <div className="space-y-6">
          {!selected && (
            <Card>
              <div className="p-8 text-center text-[var(--text-dim)] italic">
                Select a person to see their full context
              </div>
            </Card>
          )}

          {selected && (
            <>
              {/* Header card */}
              <Card>
                <div className="p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <Avatar name={selected.name} avatar={selected.avatar} size="lg" />
                    <div className="flex-1">
                      {!editingProfile ? (
                        <>
                          <div className="text-base font-semibold text-[var(--text-bright)]">
                            {selected.name}
                          </div>
                          {selected.company && (
                            <div className="text-xs text-[var(--text)]">{selected.jobTitle ? `${selected.jobTitle} at ` : ""}{selected.company}</div>
                          )}
                          {selected.emails.map((e) => (
                            <div key={e} className="text-xs text-[var(--text-dim)]">{e}</div>
                          ))}
                          {selected.profileNotes && (
                            <div className="text-xs text-[var(--text-dim)] mt-1 italic">{selected.profileNotes}</div>
                          )}
                        </>
                      ) : (
                        <div className="space-y-2">
                          <input value={profileDraft.name} onChange={(e) => setProfileDraft((d) => ({ ...d, name: e.target.value }))}
                            placeholder="Name" className="w-full h-7 px-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] focus:outline-none focus:border-[var(--accent)]" />
                          <input value={profileDraft.email} onChange={(e) => setProfileDraft((d) => ({ ...d, email: e.target.value }))}
                            placeholder="Email" className="w-full h-7 px-2 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] focus:outline-none focus:border-[var(--accent)]" />
                          <div className="flex gap-2">
                            <input value={profileDraft.company} onChange={(e) => setProfileDraft((d) => ({ ...d, company: e.target.value }))}
                              placeholder="Company" className="flex-1 h-7 px-2 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] focus:outline-none focus:border-[var(--accent)]" />
                            <input value={profileDraft.jobTitle} onChange={(e) => setProfileDraft((d) => ({ ...d, jobTitle: e.target.value }))}
                              placeholder="Title / Role" className="flex-1 h-7 px-2 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] focus:outline-none focus:border-[var(--accent)]" />
                          </div>
                          <input value={profileDraft.notes} onChange={(e) => setProfileDraft((d) => ({ ...d, notes: e.target.value }))}
                            placeholder="Notes (relationship context, how you know them)" className="w-full h-7 px-2 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] focus:outline-none focus:border-[var(--accent)]" />
                          <div className="flex gap-2 items-center">
                            <button
                              onClick={() => {
                                const q = encodeURIComponent(`"${profileDraft.name}" ${profileDraft.company || ""}`);
                                window.open(`https://www.linkedin.com/search/results/people/?keywords=${q}`, "_blank");
                              }}
                              className="h-7 px-2 text-[11px] text-[#0a66c2] border border-[var(--border)] rounded hover:border-[#0a66c2] hover:bg-[rgba(10,102,194,0.06)] shrink-0"
                            >
                              Search LinkedIn
                            </button>
                            <input
                              placeholder="Paste LinkedIn URL here..."
                              className="flex-1 h-7 px-2 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[#0a66c2]"
                              onPaste={(e) => {
                                setTimeout(async () => {
                                  const url = (e.target as HTMLInputElement).value.trim();
                                  if (!url.includes("linkedin.com/in/")) return;
                                  setSavingProfile(true);
                                  try {
                                    const resp = await fetch("/api/people/linkedin", {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ key: selectedName, linkedinUrl: url }),
                                    });
                                    const data = await resp.json();
                                    if (data.extracted) {
                                      setProfileDraft((d) => ({
                                        ...d,
                                        company: data.extracted.company || d.company,
                                        jobTitle: data.extracted.title || d.jobTitle,
                                      }));
                                    }
                                  } catch {}
                                  setSavingProfile(false);
                                }, 100);
                              }}
                            />
                          </div>
                          <div className="flex gap-2">
                            <button disabled={savingProfile} onClick={async () => {
                              setSavingProfile(true);
                              await fetch("/api/people", {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ key: selectedName, ...profileDraft }),
                              });
                              setSavingProfile(false);
                              setEditingProfile(false);
                              if (selectedName) selectPerson(profileDraft.name || selectedName);
                            }} className="h-7 px-3 text-xs font-medium bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50">
                              {savingProfile ? "Saving..." : "Save"}
                            </button>
                            <button disabled={savingProfile} onClick={async () => {
                              setSavingProfile(true);
                              setLookupResults([]);
                              const query = profileDraft.email
                                ? `email=${encodeURIComponent(profileDraft.email)}`
                                : `name=${encodeURIComponent(profileDraft.name)}`;
                              try {
                                const resp = await fetch(`/api/people/lookup?${query}`);
                                const data = await resp.json();
                                const matches = data.results || [];
                                if (matches.length === 1) {
                                  setProfileDraft((d) => ({
                                    ...d,
                                    name: matches[0].displayName || d.name,
                                    email: matches[0].email || d.email,
                                    company: matches[0].company || d.company,
                                    jobTitle: matches[0].title || d.jobTitle,
                                  }));
                                  if (matches[0].avatar && selectedName) {
                                    fetch("/api/people", {
                                      method: "PATCH",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ key: selectedName, avatar: matches[0].avatar }),
                                    }).catch(() => {});
                                  }
                                } else if (matches.length > 1) {
                                  setLookupResults(matches);
                                }
                              } catch {}
                              setSavingProfile(false);
                            }} className="h-7 px-3 text-xs font-medium text-[var(--green)] border border-[var(--border)] rounded hover:border-[var(--green)] disabled:opacity-50">
                              {savingProfile ? "..." : "Lookup Webex"}
                            </button>
                            <button onClick={() => { setEditingProfile(false); setLookupResults([]); }} className="h-7 px-3 text-xs text-[var(--text-dim)] hover:text-[var(--text)]">Cancel</button>
                          </div>
                          {lookupResults.length > 1 && (
                            <div className="mt-2 border border-[var(--border)] rounded-lg overflow-hidden">
                              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-dim)] bg-[var(--bg)]">
                                Multiple matches — select one
                              </div>
                              {lookupResults.map((r, i) => (
                                <button
                                  key={i}
                                  onClick={() => {
                                    setProfileDraft((d) => ({
                                      ...d,
                                      name: r.displayName || d.name,
                                      email: r.email || d.email,
                                      company: r.company || d.company,
                                      jobTitle: r.title || d.jobTitle,
                                    }));
                                    if ((r as any).avatar && selectedName) {
                                      fetch("/api/people", {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ key: selectedName, avatar: (r as any).avatar }),
                                      }).catch(() => {});
                                    }
                                    setLookupResults([]);
                                  }}
                                  className="w-full text-left px-3 py-2 text-xs border-t border-[var(--border)] hover:bg-[rgba(88,166,255,0.06)] transition-colors"
                                >
                                  <div className="font-medium text-[var(--text)]">{r.displayName}</div>
                                  <div className="text-[var(--text-dim)]">
                                    {r.email}{r.title ? ` — ${r.title}` : ""}{r.company ? ` (${r.company})` : ""}
                                  </div>
                                </button>
                              ))}
                              <button
                                onClick={() => setLookupResults([])}
                                className="w-full text-center px-3 py-1.5 text-[10px] text-[var(--text-dim)] border-t border-[var(--border)] hover:text-[var(--text)]"
                              >
                                None of these — enter manually
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {!editingProfile && (
                      <button onClick={() => {
                        setProfileDraft({
                          name: selected.name,
                          email: selected.emails?.[0] || "",
                          company: selected.company || "",
                          jobTitle: selected.jobTitle || "",
                          notes: selected.profileNotes || "",
                        });
                        setEditingProfile(true);
                      }} className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)] shrink-0 self-start">
                        Edit
                      </button>
                    )}
                  </div>
                  <div className="flex gap-1 pt-3 border-t border-[var(--border)]">
                    {([
                      { key: "meetings" as const, value: selected.meetings.length, label: "Meetings", color: "var(--accent)" },
                      { key: "transcripts" as const, value: selected.transcriptMentions.length, label: "Transcripts", color: "var(--purple)" },
                      { key: "messages" as const, value: selected.messageExcerpts.length, label: "Messages", color: "var(--green)" },
                      { key: "tasks" as const, value: selected.notionTasks.length, label: "Tasks", color: "var(--yellow)" },
                      ...((selected.aiSummaries?.length || 0) > 0 ? [{ key: "summaries" as const, value: selected.aiSummaries.length, label: "AI Summaries", color: "var(--green)" }] : []),
                      ...(personArtifacts.length > 0 ? [{ key: "artifacts" as const, value: personArtifacts.length, label: "Artifacts", color: "#38b2ac" }] : []),
                    ]).map((s) => (
                      <button
                        key={s.key}
                        onClick={() => setDetailFilter(detailFilter === s.key ? "all" : s.key)}
                        className={`flex-1 text-center py-2 rounded-md transition-colors cursor-pointer ${
                          detailFilter === s.key
                            ? "bg-[rgba(88,166,255,0.1)] border border-[var(--border)]"
                            : "hover:bg-[rgba(88,166,255,0.04)]"
                        }`}
                      >
                        <div className="text-lg font-bold" style={{ color: s.color }}>{s.value}</div>
                        <div className="text-[10px] text-[var(--text-dim)] uppercase">{s.label}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </Card>

              {/* Transcript quotes */}
              {selected.transcriptMentions.length > 0 && (detailFilter === "all" || detailFilter === "transcripts") && (
                <Card>
                  <CardHeader title="What They Said" />
                  <div>
                    {selected.transcriptMentions
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .slice(0, detailFilter === "transcripts" ? 20 : 5)
                      .filter((t) => !isSuppressed("transcript", t.recordingId))
                      .map((t, i) => (
                        <div key={i} className="group/row px-4 py-3 border-b border-[var(--border)] last:border-0">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-[var(--purple)]">
                              {t.topic.slice(0, 50)}
                            </span>
                            <div className="flex items-center gap-2">
                              <VoteButtons context={voteContext} itemType="transcript" itemId={t.recordingId} initialScore={getScore("transcript", t.recordingId)} onVoted={(s) => updateScore("transcript", t.recordingId, s)} />
                              <span className="text-xs text-[var(--text-dim)]">
                                {new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              </span>
                            </div>
                          </div>
                          {t.snippets.slice(0, 3).map((s, j) => (
                            <div key={j} className="text-sm text-[var(--text)] bg-[var(--surface2)] rounded px-3 py-1.5 mb-1 italic">
                              &ldquo;{s}&rdquo;
                            </div>
                          ))}
                          {t.snippetCount > 3 && (
                            <div className="text-xs text-[var(--text-dim)] mt-1">
                              +{t.snippetCount - 3} more lines
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* AI Meeting Summaries */}
              {(selected.aiSummaries?.length || 0) > 0 && (detailFilter === "all" || detailFilter === "summaries") && (
                <Card>
                  <CardHeader title="AI Meeting Summaries" />
                  <div>
                    {selected.aiSummaries
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .slice(0, detailFilter === "summaries" ? 10 : 3)
                      .map((s, i) => (
                        <div key={i} className="group/row px-4 py-3 border-b border-[var(--border)] last:border-0">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-[var(--green)]">{s.title}</span>
                            <div className="flex items-center gap-2">
                              <VoteButtons context={voteContext} itemType="summary" itemId={s.meetingId} initialScore={getScore("summary", s.meetingId)} onVoted={(sc) => updateScore("summary", s.meetingId, sc)} />
                              <span className="text-xs text-[var(--text-dim)]">
                                {new Date(s.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              </span>
                            </div>
                          </div>
                          <p className="text-sm text-[var(--text)] mb-2 line-clamp-3">{s.summary}</p>
                          {s.actionItems.length > 0 && (
                            <div className="space-y-1">
                              {s.actionItems.map((item, j) => (
                                <div key={j} className="flex gap-1.5 text-xs text-[var(--text-dim)]">
                                  <span className="text-[var(--yellow)] shrink-0">→</span>
                                  <span>{item}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* Recent messages */}
              {selected.messageExcerpts.length > 0 && (detailFilter === "all" || detailFilter === "messages") && (
                <Card>
                  <CardHeader title="Recent Messages" />
                  <div>
                    {selected.messageExcerpts
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .slice(0, detailFilter === "messages" ? 30 : 10)
                      .filter((_, i) => !isSuppressed("message", String(i)))
                      .map((m, i) => (
                        <div key={i} className="group/row px-4 py-2.5 border-b border-[var(--border)] last:border-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-[var(--accent)]">
                              {m.roomTitle}
                            </span>
                            <div className="flex items-center gap-2">
                              <VoteButtons context={voteContext} itemType="message" itemId={String(i)} initialScore={getScore("message", String(i))} onVoted={(s) => updateScore("message", String(i), s)} />
                              <button
                                onClick={() => setReplyTo({
                                  text: m.text,
                                  personName: selected.name,
                                  personEmail: selected.emails?.[0],
                                  roomId: selected.webexRoomIds?.[0],
                                })}
                                className="text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] opacity-0 group-hover/row:opacity-100 transition-opacity"
                              >
                                Draft Reply
                              </button>
                              <span className="text-xs text-[var(--text-dim)]">
                                {timeAgo(m.date)}
                              </span>
                            </div>
                          </div>
                          <div className="text-sm text-[var(--text)]">{m.text}</div>
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* Meeting history */}
              {selected.meetings.length > 0 && (detailFilter === "all" || detailFilter === "meetings") && (
                <Card>
                  <CardHeader title="Meeting History" />
                  <div>
                    {selected.meetings
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .slice(0, detailFilter === "meetings" ? 30 : 10)
                      .map((m, i) => (
                        <div key={i} className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0">
                          <div
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ background: m.role === "host" ? "var(--yellow)" : "var(--purple)" }}
                          />
                          <span className="text-sm flex-1 truncate">{m.topic}</span>
                          <span className="text-xs text-[var(--text-dim)]">
                            {new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </span>
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* Related tasks */}
              {selected.notionTasks.length > 0 && (detailFilter === "all" || detailFilter === "tasks") && (
                <Card>
                  <CardHeader title="Related Tasks" />
                  <div>
                    {selected.notionTasks.filter((t) => !isSuppressed("task", t.id)).map((t) => (
                      <div key={t.id} className="group/row flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                            t.status === "Done"
                              ? "bg-[rgba(63,185,80,0.15)] text-[var(--green)]"
                              : "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]"
                          }`}
                        >
                          {t.status}
                        </span>
                        <span className="text-sm flex-1 truncate">{t.title}</span>
                        <VoteButtons context={voteContext} itemType="task" itemId={t.id} initialScore={getScore("task", t.id)} onVoted={(s) => updateScore("task", t.id, s)} />
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Artifacts mentioning this person */}
              {personArtifacts.length > 0 && (detailFilter === "all" || detailFilter === "artifacts") && (
                <Card>
                  <CardHeader title="Artifacts" />
                  <div className="px-4 py-2">
                    <ArtifactList person={selected?.name} label="" />
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {/* Reply drafter modal */}
      {replyTo && (
        <ReplyDrafter
          message={replyTo.text}
          personName={replyTo.personName}
          personEmail={replyTo.personEmail}
          channel="Webex"
          roomId={replyTo.roomId}
          onClose={() => setReplyTo(null)}
        />
      )}
    </div>
  );
}
