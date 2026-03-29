"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, StatCard } from "@/components/Card";
import VoteButtons from "@/components/VoteButtons";
import ArtifactList from "@/components/ArtifactList";

interface TopicSummary {
  key: string;
  name: string;
  meetings: number;
  transcripts: number;
  tasks: number;
  rooms: number;
  people: number;
}

interface TopicDetail {
  name: string;
  meetings: { id: string; topic: string; date: string }[];
  transcriptSnippets: {
    topic: string;
    date: string;
    speakers: string[];
    keyLines: string[];
  }[];
  webexRooms: { id: string; title: string }[];
  notionTasks: { id: string; title: string; status: string; source: string }[];
  people: string[];
}

export default function TopicsView() {
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [selected, setSelected] = useState<TopicDetail | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scores, setScores] = useState<Record<string, number>>({});

  const voteContext = selectedName ? `topic:${selectedName}` : "";
  const updateScore = (itemType: string, itemId: string, s: number) => setScores((prev) => ({ ...prev, [`${itemType}:${itemId}`]: s }));
  const getScore = (itemType: string, itemId: string) => scores[`${itemType}:${itemId}`] ?? 0;
  const isSuppressed = (itemType: string, itemId: string) => getScore(itemType, itemId) <= -2;

  useEffect(() => {
    fetch("/api/topics")
      .then((r) => r.json())
      .then((data) => {
        setTopics(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function selectTopic(name: string) {
    setSelectedName(name);
    const [resp, scoresResp] = await Promise.all([
      fetch(`/api/topics?name=${encodeURIComponent(name)}`),
      fetch(`/api/relevance?context=${encodeURIComponent(`topic:${name}`)}`).then(r => r.ok ? r.json() : { scores: {} }),
    ]);
    const data = await resp.json();
    setSelected(data);
    setScores(scoresResp.scores || {});
  }

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard value={topics.length} label="Topics" color="var(--accent)" />
        <StatCard
          value={topics.reduce((s, t) => s + t.meetings, 0)}
          label="Meetings"
          color="var(--purple)"
        />
        <StatCard
          value={topics.reduce((s, t) => s + t.tasks, 0)}
          label="Tasks"
          color="var(--yellow)"
        />
        <StatCard
          value={topics.reduce((s, t) => s + t.people, 0)}
          label="People"
          color="var(--green)"
        />
      </div>

      <div className="grid grid-cols-[1fr_480px] gap-6">
        {/* Left: Topic list */}
        <Card>
          <CardHeader title="Topics" />
          <div>
            {loading && (
              <div className="p-6 text-center text-[var(--text-dim)]">
                Loading topics...
              </div>
            )}
            {topics.map((t) => (
              <div
                key={t.key}
                className={`flex items-center gap-4 px-4 py-3 border-b border-[var(--border)] cursor-pointer hover:bg-[rgba(88,166,255,0.03)] ${
                  selectedName === t.name
                    ? "bg-[rgba(88,166,255,0.06)]"
                    : ""
                }`}
                onClick={() => selectTopic(t.name)}
              >
                <div className="flex-1">
                  <div className="text-sm font-medium text-[var(--text-bright)]">
                    {t.name}
                  </div>
                  <div className="flex gap-3 mt-1 text-xs text-[var(--text-dim)]">
                    <span>{t.meetings} meetings</span>
                    <span>{t.transcripts} transcripts</span>
                    <span>{t.tasks} tasks</span>
                    <span>{t.people} people</span>
                  </div>
                </div>
                <div className="text-[var(--text-dim)] text-xs">›</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Right: Topic detail */}
        <div className="space-y-6">
          {!selected && (
            <Card>
              <div className="p-8 text-center text-[var(--text-dim)] italic">
                Select a topic to see details
              </div>
            </Card>
          )}

          {selected && (
            <>
              {/* People */}
              {selected.people.length > 0 && (
                <Card>
                  <CardHeader
                    title="People"
                    right={
                      <span className="text-xs text-[var(--text-dim)]">
                        {selected.people.length}
                      </span>
                    }
                  />
                  <div className="px-4 py-3 flex flex-wrap gap-2">
                    {selected.people.slice(0, 20).map((p, i) => (
                      <span
                        key={i}
                        className="text-xs px-2 py-1 rounded-full bg-[rgba(88,166,255,0.08)] text-[var(--accent)]"
                      >
                        {p}
                      </span>
                    ))}
                    {selected.people.length > 20 && (
                      <span className="text-xs text-[var(--text-dim)]">
                        +{selected.people.length - 20} more
                      </span>
                    )}
                  </div>
                </Card>
              )}

              {/* Transcript highlights */}
              {selected.transcriptSnippets.length > 0 && (
                <Card>
                  <CardHeader title="From Transcripts" />
                  <div>
                    {selected.transcriptSnippets.slice(0, 5).filter((_, i) => !isSuppressed("transcript", String(i))).map((t, i) => (
                      <div
                        key={i}
                        className="group/row px-4 py-3 border-b border-[var(--border)] last:border-0"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium text-[var(--purple)]">
                            {t.topic.slice(0, 50)}
                          </span>
                          <div className="flex items-center gap-2">
                            <VoteButtons context={voteContext} itemType="transcript" itemId={String(i)} initialScore={getScore("transcript", String(i))} onVoted={(s) => updateScore("transcript", String(i), s)} />
                            <span className="text-xs text-[var(--text-dim)]">
                              {new Date(t.date).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          </div>
                        </div>
                        {t.keyLines.slice(0, 3).map((line, j) => (
                          <div
                            key={j}
                            className="text-sm text-[var(--text)] bg-[var(--surface2)] rounded px-3 py-1.5 mb-1"
                          >
                            {line}
                          </div>
                        ))}
                        <div className="text-xs text-[var(--text-dim)] mt-1">
                          Speakers: {t.speakers.slice(0, 5).join(", ")}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Related Tasks */}
              {selected.notionTasks.length > 0 && (
                <Card>
                  <CardHeader
                    title="Tasks"
                    right={
                      <span className="text-xs text-[var(--text-dim)]">
                        {selected.notionTasks.length}
                      </span>
                    }
                  />
                  <div>
                    {selected.notionTasks.slice(0, 15).filter((t) => !isSuppressed("task", t.id)).map((t) => (
                      <div
                        key={t.id}
                        className="group/row flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0"
                      >
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                            t.status === "Done"
                              ? "bg-[rgba(63,185,80,0.15)] text-[var(--green)]"
                              : "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)]"
                          }`}
                        >
                          {t.status}
                        </span>
                        <span className="text-sm flex-1 truncate">
                          {t.title}
                        </span>
                        <VoteButtons context={voteContext} itemType="task" itemId={t.id} initialScore={getScore("task", t.id)} onVoted={(s) => updateScore("task", t.id, s)} />
                        {t.source && (
                          <span className="text-[10px] text-[var(--text-dim)] shrink-0">
                            {t.source}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Meetings */}
              {selected.meetings.length > 0 && (
                <Card>
                  <CardHeader title="Meetings" />
                  <div>
                    {selected.meetings
                      .sort((a, b) => b.date.localeCompare(a.date))
                      .slice(0, 10)
                      .map((m, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0"
                        >
                          <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--accent)]" />
                          <span className="text-sm flex-1">
                            {m.topic.slice(0, 60)}
                          </span>
                          <span className="text-xs text-[var(--text-dim)]">
                            {new Date(m.date).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                        </div>
                      ))}
                  </div>
                </Card>
              )}

              {/* Webex Rooms */}
              {selected.webexRooms.length > 0 && (
                <Card>
                  <CardHeader title="Webex Spaces" />
                  <div>
                    {selected.webexRooms.map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] last:border-0"
                      >
                        <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--green)]" />
                        <span className="text-sm">{r.title}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Artifacts related to this topic */}
              {selected && (
                <Card>
                  <div className="px-4 py-3">
                    <ArtifactList project={selected.name} label="Topic Artifacts" />
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
