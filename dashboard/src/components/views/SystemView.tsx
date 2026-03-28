"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Card, CardHeader, StatCard } from "@/components/Card";

// --- Types ---

interface Service {
  name: string;
  status: string;
  port: number;
  uptime: number | null;
}

interface Pipeline {
  id: string;
  name: string;
  schedule: string;
  lastRun: string | null;
  lastStatus: string;
  nextRun: string | null;
  status: string;
}

interface RecentRun {
  taskId: string;
  name: string;
  status: string;
  runAt: string;
  durationMs: number;
  error: string | null;
}

interface IndexInfo {
  count?: number;
  entries?: number;
  chunks?: number;
  lastBuilt: string | null;
  sizeKb: number;
}

interface SystemData {
  platform: {
    status: string;
    uptime: number;
    timezone: string;
    version: string;
  };
  services: Service[];
  ollama: {
    url: string;
    reachable: boolean;
    models: string[];
  };
  llm: {
    backend: string;
    model: string;
    localAvailable: boolean;
  };
  pipelines: Pipeline[];
  recentRuns: RecentRun[];
  indexes: Record<string, IndexInfo>;
  containers: {
    active: number;
    waiting: number;
    imageSize: string;
  };
}

// --- Formatting helpers ---

function formatUptime(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return timeUntil(iso);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function timeUntil(iso: string | null): string {
  if (!iso) return "---";
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 0) return "overdue";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

function formatSize(kb: number): string {
  if (kb === 0) return "0 KB";
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
    case "success":
      return "var(--green)";
    case "stopped":
    case "error":
      return "var(--red)";
    case "degraded":
    case "warning":
      return "var(--yellow)";
    default:
      return "var(--text-dim)";
  }
}

// --- Component ---

export default function SystemView() {
  const [data, setData] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const runsRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const resp = await fetch("/api/system-status");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Auto-scroll recent runs
  useEffect(() => {
    if (runsRef.current) {
      runsRef.current.scrollTop = 0;
    }
  }, [data?.recentRuns]);

  async function triggerPipeline(id: string) {
    setTriggeringId(id);
    try {
      await fetch(`/api/system-status?action=trigger&id=${encodeURIComponent(id)}`, {
        method: "POST",
      });
      // Refresh data after a brief delay to let the scheduler pick it up
      setTimeout(fetchData, 2000);
    } catch {}
    setTriggeringId(null);
  }

  if (loading && !data) {
    return (
      <div className="max-w-[1400px] mx-auto px-8 py-6">
        <div className="text-center text-[var(--text-dim)] py-20">
          Loading system status...
        </div>
      </div>
    );
  }

  // Compute stats
  const recentErrors = (data?.recentRuns || []).filter((r) => {
    if (r.status !== "error") return false;
    const ago = Date.now() - new Date(r.runAt).getTime();
    return ago < 86400000; // 24h
  }).length;

  const activePipelines = (data?.pipelines || []).filter(
    (p) => p.status === "active"
  ).length;

  const sortedPipelines = [...(data?.pipelines || [])].sort((a, b) => {
    if (!a.nextRun && !b.nextRun) return 0;
    if (!a.nextRun) return 1;
    if (!b.nextRun) return -1;
    return a.nextRun.localeCompare(b.nextRun);
  });

  const indexEntries: {
    key: string;
    label: string;
    count: number;
    countLabel: string;
    info: IndexInfo;
  }[] = [
    {
      key: "personIndex",
      label: "Person Index",
      count: data?.indexes.personIndex?.count ?? 0,
      countLabel: "people",
      info: data?.indexes.personIndex ?? { sizeKb: 0, lastBuilt: null },
    },
    {
      key: "topicIndex",
      label: "Topic Index",
      count: data?.indexes.topicIndex?.count ?? 0,
      countLabel: "topics",
      info: data?.indexes.topicIndex ?? { sizeKb: 0, lastBuilt: null },
    },
    {
      key: "vectorIndex",
      label: "Vector Index",
      count: data?.indexes.vectorIndex?.chunks ?? 0,
      countLabel: "chunks",
      info: data?.indexes.vectorIndex ?? { sizeKb: 0, lastBuilt: null },
    },
    {
      key: "webexSummaries",
      label: "Webex Summaries",
      count: data?.indexes.webexSummaries?.count ?? 0,
      countLabel: "summaries",
      info: data?.indexes.webexSummaries ?? { sizeKb: 0, lastBuilt: null },
    },
    {
      key: "corrections",
      label: "Corrections Glossary",
      count: data?.indexes.corrections?.entries ?? 0,
      countLabel: "entries",
      info: data?.indexes.corrections ?? { sizeKb: 0, lastBuilt: null },
    },
    {
      key: "relevanceScores",
      label: "Relevance Scores",
      count: data?.indexes.relevanceScores?.entries ?? 0,
      countLabel: "entries",
      info: data?.indexes.relevanceScores ?? { sizeKb: 0, lastBuilt: null },
    },
    {
      key: "initiatives",
      label: "Initiatives",
      count: data?.indexes.initiatives?.count ?? 0,
      countLabel: "initiatives",
      info: data?.indexes.initiatives ?? { sizeKb: 0, lastBuilt: null },
    },
  ];

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      {error && (
        <div className="mb-4 p-3 bg-[rgba(248,81,73,0.1)] border border-[var(--red)] rounded-lg text-sm text-[var(--red)]">
          {error}
        </div>
      )}

      {/* Section 1: Platform Health */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          value={formatUptime(data?.platform.uptime ?? 0)}
          label="Uptime"
          color="var(--green)"
        />
        <StatCard
          value={data?.containers.active ?? 0}
          label="Active Containers"
          color="var(--accent)"
        />
        <StatCard
          value={activePipelines}
          label="Active Pipelines"
          color="var(--accent)"
        />
        <StatCard
          value={recentErrors}
          label="Errors (24h)"
          color={recentErrors > 0 ? "var(--red)" : "var(--green)"}
        />
      </div>

      {/* Section 2: Services */}
      <Card className="mb-6">
        <CardHeader
          title="Services"
          right={
            <span className="text-xs text-[var(--text-dim)]">
              v{data?.platform.version} | {data?.platform.timezone}
            </span>
          }
        />
        <div className="px-4 py-3">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {(data?.services || []).map((svc) => (
              <div key={svc.name} className="flex items-center gap-2.5">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: statusColor(svc.status) }}
                />
                <div>
                  <div className="text-[13px] text-[var(--text-bright)]">
                    {svc.name}
                  </div>
                  <div className="text-[11px] text-[var(--text-dim)]">
                    :{svc.port}{" "}
                    <span
                      style={{ color: statusColor(svc.status) }}
                    >
                      {svc.status}
                    </span>
                    {svc.uptime != null && (
                      <span className="ml-1">({formatUptime(svc.uptime)})</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Section 3: LLM Configuration */}
      <Card className="mb-6">
        <CardHeader title="LLM Configuration" />
        <div className="px-4 py-3 grid grid-cols-3 gap-6">
          <div>
            <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider mb-1">
              Backend
            </div>
            <div className="text-[13px] text-[var(--text-bright)]">
              {data?.llm.backend === "api" ? "Anthropic API" : "Local (Ollama)"}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider mb-1">
              Model
            </div>
            <div className="text-[13px] text-[var(--text-bright)] font-mono">
              {data?.llm.model}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider mb-1">
              Local Routing
            </div>
            <div className="text-[13px]">
              {(data?.services || []).find((s) => s.name === "Ollama Shim")
                ?.status === "running" ? (
                <span style={{ color: "var(--green)" }}>
                  Active on port {(data?.services || []).find((s) => s.name === "Ollama Shim")?.port}
                </span>
              ) : data?.llm.localAvailable ? (
                <span style={{ color: "var(--yellow)" }}>
                  Available (shim not active)
                </span>
              ) : (
                <span style={{ color: "var(--text-dim)" }}>Unavailable</span>
              )}
            </div>
          </div>
          {data?.ollama.reachable && data.ollama.models.length > 0 && (
            <div className="col-span-3">
              <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider mb-1.5">
                Ollama Models ({data.ollama.url})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {data.ollama.models.map((m) => (
                  <span
                    key={m}
                    className="text-[11px] font-mono bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-0.5 text-[var(--text)]"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}
          {data?.ollama && !data.ollama.reachable && (
            <div className="col-span-3">
              <div className="text-[11px] text-[var(--text-dim)]">
                Ollama at {data.ollama.url} is{" "}
                <span style={{ color: "var(--red)" }}>unreachable</span>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Section 4: Ingestion Pipelines */}
      <Card className="mb-6">
        <CardHeader
          title="Ingestion Pipelines"
          right={
            <span className="text-xs text-[var(--text-dim)]">
              {activePipelines} active
            </span>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider bg-[var(--bg)]">
                <th className="text-left px-4 py-2 font-medium">Pipeline</th>
                <th className="text-left px-4 py-2 font-medium">Schedule</th>
                <th className="text-left px-4 py-2 font-medium">Last Run</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Next Run</th>
                <th className="text-right px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {sortedPipelines.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-6 text-center text-[var(--text-dim)] italic"
                  >
                    No pipelines configured
                  </td>
                </tr>
              )}
              {sortedPipelines.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-[var(--border)] hover:bg-[rgba(88,166,255,0.03)] transition-colors"
                >
                  <td className="px-4 py-2.5">
                    <div className="text-[var(--text-bright)] font-medium">
                      {p.name}
                    </div>
                    <div className="text-[11px] text-[var(--text-dim)] font-mono">
                      {p.id}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text)]">
                    {p.schedule}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-dim)]">
                    {timeAgo(p.lastRun)}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={p.lastStatus} />
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-dim)]">
                    {p.status === "paused" ? (
                      <span className="text-[var(--yellow)]">paused</span>
                    ) : (
                      timeUntil(p.nextRun)
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => triggerPipeline(p.id)}
                      disabled={triggeringId === p.id || p.status === "paused"}
                      className="text-[11px] px-2.5 py-1 rounded border border-[var(--border)] text-[var(--accent)] hover:bg-[rgba(88,166,255,0.08)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {triggeringId === p.id ? "Triggering..." : "Run Now"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Section 5: Data Indexes */}
      <Card className="mb-6">
        <CardHeader title="Data Indexes" />
        <div className="grid grid-cols-4 gap-3 p-4">
          {indexEntries.map((idx) => (
            <div
              key={idx.key}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3.5 py-3"
            >
              <div className="text-[20px] font-bold text-[var(--text-bright)]">
                {idx.count.toLocaleString()}
              </div>
              <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider">
                {idx.countLabel}
              </div>
              <div className="mt-2 text-[11px] text-[var(--text-dim)] font-medium">
                {idx.label}
              </div>
              <div className="flex justify-between text-[10px] text-[var(--text-dim)] mt-1">
                <span>{formatSize(idx.info.sizeKb)}</span>
                <span>{timeAgo(idx.info.lastBuilt)}</span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Section 6: Recent Agent Runs */}
      <Card>
        <CardHeader
          title="Recent Agent Runs"
          right={
            <span className="text-xs text-[var(--text-dim)]">
              Last 20 runs
            </span>
          }
        />
        <div
          ref={runsRef}
          className="max-h-[400px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {(data?.recentRuns || []).length === 0 && (
            <div className="px-4 py-6 text-center text-[var(--text-dim)] italic">
              No recent runs
            </div>
          )}
          {(data?.recentRuns || []).map((r, i) => (
            <div
              key={`${r.taskId}-${r.runAt}-${i}`}
              className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] hover:bg-[rgba(88,166,255,0.03)] transition-colors"
            >
              <div
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: statusColor(r.status) }}
              />
              <span className="text-[12px] text-[var(--text-dim)] w-16 shrink-0">
                {timeAgo(r.runAt)}
              </span>
              <span className="text-[13px] text-[var(--text-bright)] truncate flex-1">
                {r.name}
              </span>
              <StatusBadge status={r.status} />
              <span className="text-[12px] text-[var(--text-dim)] w-14 text-right shrink-0">
                {formatDuration(r.durationMs)}
              </span>
              {r.error && (
                <span
                  className="text-[11px] text-[var(--red)] truncate max-w-[200px]"
                  title={r.error}
                >
                  {r.error}
                </span>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// --- Sub-components ---

function StatusBadge({ status }: { status: string }) {
  const bg =
    status === "success"
      ? "rgba(63,185,80,0.12)"
      : status === "error"
        ? "rgba(248,81,73,0.12)"
        : "rgba(139,148,158,0.12)";
  const color = statusColor(status);
  const label =
    status === "never" ? "never run" : status;

  return (
    <span
      className="text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0"
      style={{ background: bg, color }}
    >
      {label}
    </span>
  );
}
