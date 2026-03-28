"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Card, CardHeader, StatCard } from "@/components/Card";

// --- Dedup types ---

interface DedupTask {
  id: string;
  title: string;
  source: string;
  priority: string;
  project: string;
  url: string;
}

interface DedupPair {
  score: number;
  action: "skip" | "merge" | "review";
  taskA: DedupTask;
  taskB: DedupTask;
}

interface DedupData {
  totalTasks: number;
  pairs: DedupPair[];
  summary: { skip: number; merge: number; review: number };
}

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
  model: string | null;
  modelLabel: string;
  estimatedCostPerRun: number;
  totalEstimatedCost: number;
  avgDurationMs: number;
  runsPerDay: number;
  recommendation: string;
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

interface AvailableModel {
  id: string;
  label: string;
  inputPerM: number;
  outputPerM: number;
  active: boolean;
}

interface CostSummary {
  estimatedPerDay: number;
  optimizedPerDay: number;
  potentialSavingsPercent: number;
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
  costSummary: CostSummary;
  availableModels: AvailableModel[];
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

function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
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

function modelIndicatorColor(modelLabel: string): string {
  switch (modelLabel) {
    case "Sonnet":
      return "var(--accent)";
    case "Haiku":
      return "var(--green)";
    case "Local":
      return "var(--text-dim)";
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
  const [updatingModelId, setUpdatingModelId] = useState<string | null>(null);
  const runsRef = useRef<HTMLDivElement>(null);

  // Dedup state
  const [dedupData, setDedupData] = useState<DedupData | null>(null);
  const [dedupLoading, setDedupLoading] = useState(false);
  const [dedupError, setDedupError] = useState<string | null>(null);
  const [dedupExpanded, setDedupExpanded] = useState(true);
  const [bulkMergeProgress, setBulkMergeProgress] = useState<{ current: number; total: number } | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [dedupSelected, setDedupSelected] = useState<Set<string>>(new Set());
  const [dedupBulkProgress, setDedupBulkProgress] = useState<string | null>(null);

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

  async function updateModel(id: string, model: string | null) {
    setUpdatingModelId(id);
    try {
      const resp = await fetch("/api/system-status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setModel", id, model }),
      });
      if (resp.ok) {
        // Optimistically update the local state
        const isLocal = typeof model === "string" && model.startsWith("local:");
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            pipelines: prev.pipelines.map((p) =>
              p.id === id ? {
                ...p,
                model,
                modelLabel: model ? (prev.availableModels.find(m => m.id === model)?.label || model) : "Sonnet",
                status: isLocal ? "local" : "active",
              } : p
            ),
          };
        });
        // Full refresh for cost recalculation
        setTimeout(fetchData, 500);
      }
    } catch {}
    setUpdatingModelId(null);
  }

  // --- Dedup handlers ---

  const scanDedup = useCallback(async () => {
    setDedupLoading(true);
    setDedupError(null);
    try {
      const resp = await fetch("/api/dedup");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      setDedupData(json);
    } catch (err) {
      setDedupError(String(err));
    } finally {
      setDedupLoading(false);
    }
  }, []);

  async function dedupMerge(pair: DedupPair) {
    const key = `${pair.taskA.id}:${pair.taskB.id}`;
    setActionInFlight(key);
    try {
      // Keep the task that has more context (longer title as proxy, or higher priority)
      const priorityRank: Record<string, number> = {
        "P0 \u2014 Today": 0,
        "P1 \u2014 This Week": 1,
        "P2 \u2014 This Month": 2,
        "P3 \u2014 This Quarter": 3,
      };
      const rankA = priorityRank[pair.taskA.priority] ?? 3;
      const rankB = priorityRank[pair.taskB.priority] ?? 3;
      const keepA = rankA < rankB || (rankA === rankB && pair.taskA.title.length >= pair.taskB.title.length);
      const keepId = keepA ? pair.taskA.id : pair.taskB.id;
      const removeId = keepA ? pair.taskB.id : pair.taskA.id;
      const removeTitle = keepA ? pair.taskB.title : pair.taskA.title;

      const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const note = `[Dedup] Merged with: "${removeTitle}" on ${dateStr}`;

      await fetch("/api/dedup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "merge", keepId, removeId, note }),
      });

      // Remove pair from local state
      setDedupData((prev) => {
        if (!prev) return prev;
        const remaining = prev.pairs.filter(
          (p) => !(p.taskA.id === pair.taskA.id && p.taskB.id === pair.taskB.id)
        );
        return {
          ...prev,
          pairs: remaining,
          summary: {
            skip: remaining.filter((p) => p.action === "skip").length,
            merge: remaining.filter((p) => p.action === "merge").length,
            review: remaining.filter((p) => p.action === "review").length,
          },
        };
      });
    } catch {}
    setActionInFlight(null);
  }

  async function dedupDismiss(pair: DedupPair) {
    const key = `${pair.taskA.id}:${pair.taskB.id}`;
    setActionInFlight(key);
    try {
      await fetch("/api/dedup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", idA: pair.taskA.id, idB: pair.taskB.id }),
      });

      // Remove pair from local state
      setDedupData((prev) => {
        if (!prev) return prev;
        const remaining = prev.pairs.filter(
          (p) => !(p.taskA.id === pair.taskA.id && p.taskB.id === pair.taskB.id)
        );
        return {
          ...prev,
          pairs: remaining,
          summary: {
            skip: remaining.filter((p) => p.action === "skip").length,
            merge: remaining.filter((p) => p.action === "merge").length,
            review: remaining.filter((p) => p.action === "review").length,
          },
        };
      });
    } catch {}
    setActionInFlight(null);
  }

  function dedupToggleSelect(pair: DedupPair) {
    const key = `${pair.taskA.id}:${pair.taskB.id}`;
    setDedupSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function dedupSelectAll() {
    if (!dedupData) return;
    if (dedupSelected.size === dedupData.pairs.length) {
      setDedupSelected(new Set());
    } else {
      setDedupSelected(new Set(dedupData.pairs.map((p) => `${p.taskA.id}:${p.taskB.id}`)));
    }
  }

  async function dedupBulkAction(action: "merge" | "dismiss") {
    if (!dedupData || dedupSelected.size === 0) return;
    const selected = dedupData.pairs.filter((p) => dedupSelected.has(`${p.taskA.id}:${p.taskB.id}`));
    setDedupBulkProgress(`${action === "merge" ? "Merging" : "Dismissing"} 0 of ${selected.length}...`);

    let done = 0;
    for (const pair of selected) {
      try {
        if (action === "merge") {
          const aRank = (pair.taskA.priority.match(/P(\d)/) || [, "3"])[1];
          const bRank = (pair.taskB.priority.match(/P(\d)/) || [, "3"])[1];
          const keepA = parseInt(aRank as string) <= parseInt(bRank as string);
          const keepId = keepA ? pair.taskA.id : pair.taskB.id;
          const removeId = keepA ? pair.taskB.id : pair.taskA.id;
          const removedTitle = keepA ? pair.taskB.title : pair.taskA.title;
          await fetch("/api/dedup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "merge", keepId, removeId, note: `[Merged] "${removedTitle}"` }),
          });
        } else {
          await fetch("/api/dedup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "dismiss", idA: pair.taskA.id, idB: pair.taskB.id }),
          });
        }
      } catch {}
      done++;
      setDedupBulkProgress(`${action === "merge" ? "Merging" : "Dismissing"} ${done} of ${selected.length}...`);
    }

    // Remove processed pairs from state
    setDedupData((prev) => {
      if (!prev) return prev;
      const remaining = prev.pairs.filter((p) => !dedupSelected.has(`${p.taskA.id}:${p.taskB.id}`));
      return {
        ...prev,
        pairs: remaining,
        summary: {
          skip: remaining.filter((p) => p.action === "skip").length,
          merge: remaining.filter((p) => p.action === "merge").length,
          review: remaining.filter((p) => p.action === "review").length,
        },
      };
    });
    setDedupSelected(new Set());
    setDedupBulkProgress(null);
  }

  async function dedupMergeAllSkips() {
    if (!dedupData) return;
    const skipPairs = dedupData.pairs.filter((p) => p.action === "skip");
    if (skipPairs.length === 0) return;

    const priorityRank: Record<string, number> = {
      "P0 \u2014 Today": 0,
      "P1 \u2014 This Week": 1,
      "P2 \u2014 This Month": 2,
      "P3 \u2014 This Quarter": 3,
    };

    const bulkPairs = skipPairs.map((pair) => {
      const rankA = priorityRank[pair.taskA.priority] ?? 3;
      const rankB = priorityRank[pair.taskB.priority] ?? 3;
      const keepA = rankA < rankB || (rankA === rankB && pair.taskA.title.length >= pair.taskB.title.length);
      const keepId = keepA ? pair.taskA.id : pair.taskB.id;
      const removeId = keepA ? pair.taskB.id : pair.taskA.id;
      const removeTitle = keepA ? pair.taskB.title : pair.taskA.title;
      const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return { keepId, removeId, note: `[Dedup] Merged with: "${removeTitle}" on ${dateStr}` };
    });

    setBulkMergeProgress({ current: 0, total: bulkPairs.length });

    // Process in batches of 10 to show progress
    const BATCH_SIZE = 10;
    let processed = 0;
    for (let i = 0; i < bulkPairs.length; i += BATCH_SIZE) {
      const batch = bulkPairs.slice(i, i + BATCH_SIZE);
      try {
        await fetch("/api/dedup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "merge-all-skips", pairs: batch }),
        });
      } catch {}
      processed += batch.length;
      setBulkMergeProgress({ current: processed, total: bulkPairs.length });
    }

    // Remove merged pairs from state
    setDedupData((prev) => {
      if (!prev) return prev;
      const remaining = prev.pairs.filter((p) => p.action !== "skip");
      return {
        ...prev,
        pairs: remaining,
        summary: {
          skip: 0,
          merge: remaining.filter((p) => p.action === "merge").length,
          review: remaining.filter((p) => p.action === "review").length,
        },
      };
    });
    setBulkMergeProgress(null);
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

  const costSummary = data?.costSummary;

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
              Default Model
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

      {/* Section 4: Cost Summary */}
      {costSummary && (costSummary.estimatedPerDay > 0 || sortedPipelines.length > 0) && (
        <Card className="mb-6">
          <CardHeader title="Cost Estimates" />
          <div className="px-4 py-3">
            <div className="grid grid-cols-3 gap-6">
              <div>
                <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider mb-1">
                  Current Cost / Day
                </div>
                <div className="text-[20px] font-bold text-[var(--text-bright)]">
                  {formatCost(costSummary.estimatedPerDay)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider mb-1">
                  If Optimized
                </div>
                <div className="text-[20px] font-bold" style={{ color: "var(--green)" }}>
                  {formatCost(costSummary.optimizedPerDay)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider mb-1">
                  Potential Savings
                </div>
                <div
                  className="text-[20px] font-bold"
                  style={{
                    color: costSummary.potentialSavingsPercent > 0
                      ? "var(--green)"
                      : "var(--text-dim)",
                  }}
                >
                  {costSummary.potentialSavingsPercent > 0
                    ? `${costSummary.potentialSavingsPercent}%`
                    : "---"}
                </div>
              </div>
            </div>
            {costSummary.potentialSavingsPercent > 0 && (
              <div className="mt-3 text-[11px] text-[var(--text-dim)]">
                Savings based on switching recommended pipelines to Haiku.
                Estimates use avg run duration as a proxy for token usage.
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Section 5: Ingestion Pipelines */}
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
                <th className="text-left px-4 py-2 font-medium">Model</th>
                <th className="text-left px-4 py-2 font-medium">Schedule</th>
                <th className="text-left px-4 py-2 font-medium">Last Run</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Est. Cost</th>
                <th className="text-left px-4 py-2 font-medium">Next Run</th>
                <th className="text-right px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {sortedPipelines.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
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
                  <td className="px-4 py-2.5">
                    <ModelSelector
                      pipelineId={p.id}
                      currentModel={p.model}
                      currentLabel={p.modelLabel}
                      recommendation={p.recommendation}
                      availableModels={data?.availableModels || []}
                      isUpdating={updatingModelId === p.id}
                      onUpdate={updateModel}
                    />
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
                  <td className="px-4 py-2.5 text-right">
                    <div className="text-[var(--text)]">
                      {formatCost(p.estimatedCostPerRun)}
                    </div>
                    <div className="text-[10px] text-[var(--text-dim)]">
                      per run
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-dim)]">
                    {p.status === "local" ? (
                      <span className="text-[var(--green)]">local script</span>
                    ) : p.status === "paused" ? (
                      <span className="text-[var(--yellow)]">paused</span>
                    ) : (
                      timeUntil(p.nextRun)
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => triggerPipeline(p.id)}
                      disabled={triggeringId === p.id || p.status === "paused" || p.status === "local"}
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

      {/* Section 6: Data Indexes */}
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

      {/* Section 7: Recent Agent Runs */}
      <Card className="mb-6">
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

      {/* Section 8: Task Deduplication */}
      <Card>
        <CardHeader
          title="Task Deduplication"
          right={
            <div className="flex items-center gap-2">
              {dedupData && (
                <span className="text-[11px] text-[var(--text-dim)]">
                  {dedupData.totalTasks} tasks scanned
                </span>
              )}
              <button
                onClick={() => setDedupExpanded((v) => !v)}
                className="text-[11px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[rgba(88,166,255,0.05)] transition-colors"
              >
                {dedupExpanded ? "Collapse" : "Expand"}
              </button>
              <button
                onClick={scanDedup}
                disabled={dedupLoading}
                className="text-[11px] px-2.5 py-1 rounded border border-[var(--border)] text-[var(--accent)] hover:bg-[rgba(88,166,255,0.08)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {dedupLoading ? "Scanning..." : "Scan"}
              </button>
            </div>
          }
        />

        {dedupExpanded && (
          <div>
            {dedupError && (
              <div className="px-4 py-3 text-[12px] text-[var(--red)] bg-[rgba(248,81,73,0.06)]">
                {dedupError}
              </div>
            )}

            {dedupLoading && !dedupData && (
              <div className="px-4 py-10 text-center text-[var(--text-dim)] text-[13px]">
                <div className="inline-block w-4 h-4 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin mr-2 align-middle" />
                Scanning open tasks for duplicates...
              </div>
            )}

            {!dedupData && !dedupLoading && (
              <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px] italic">
                Click &quot;Scan&quot; to find duplicate tasks
              </div>
            )}

            {dedupData && (
              <>
                {/* Summary bar */}
                <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between bg-[var(--bg)]">
                  <div className="flex items-center gap-4 text-[12px]">
                    <span>
                      <span className="font-bold text-[var(--red)]">{dedupData.summary.skip}</span>
                      <span className="text-[var(--text-dim)] ml-1">exact dupes</span>
                    </span>
                    <span>
                      <span className="font-bold text-[var(--yellow)]">{dedupData.summary.merge}</span>
                      <span className="text-[var(--text-dim)] ml-1">merge candidates</span>
                    </span>
                    <span>
                      <span className="font-bold text-[var(--text-dim)]">{dedupData.summary.review}</span>
                      <span className="text-[var(--text-dim)] ml-1">to review</span>
                    </span>
                  </div>
                  {dedupData.summary.skip > 0 && (
                    <button
                      onClick={dedupMergeAllSkips}
                      disabled={bulkMergeProgress !== null}
                      className="text-[11px] px-2.5 py-1 rounded border border-[var(--red)] text-[var(--red)] hover:bg-[rgba(248,81,73,0.08)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                      {bulkMergeProgress
                        ? `Merging ${bulkMergeProgress.current} of ${bulkMergeProgress.total}...`
                        : `Merge All Exact Dupes (${dedupData.summary.skip})`}
                    </button>
                  )}
                </div>

                {/* Select all + bulk actions */}
                {dedupData.pairs.length > 0 && (
                  <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--bg)]">
                    <label className="flex items-center gap-2 text-xs text-[var(--text-dim)] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={dedupSelected.size === dedupData.pairs.length && dedupData.pairs.length > 0}
                        onChange={dedupSelectAll}
                        className="w-3.5 h-3.5 rounded accent-[var(--accent)]"
                      />
                      {dedupSelected.size > 0 ? `${dedupSelected.size} selected` : "Select all"}
                    </label>
                    {dedupSelected.size > 0 && !dedupBulkProgress && (
                      <div className="flex items-center gap-2 ml-auto">
                        <button
                          onClick={() => dedupBulkAction("merge")}
                          className="text-[11px] px-2.5 py-1 rounded border border-[var(--green)] text-[var(--green)] hover:bg-[rgba(63,185,80,0.08)] font-medium transition-colors"
                        >
                          Merge ({dedupSelected.size})
                        </button>
                        <button
                          onClick={() => dedupBulkAction("dismiss")}
                          className="text-[11px] px-2.5 py-1 rounded border border-[var(--text-dim)] text-[var(--text-dim)] hover:bg-[rgba(139,148,158,0.08)] transition-colors"
                        >
                          Dismiss ({dedupSelected.size})
                        </button>
                      </div>
                    )}
                    {dedupBulkProgress && (
                      <span className="text-[11px] text-[var(--text-dim)] ml-auto">{dedupBulkProgress}</span>
                    )}
                  </div>
                )}

                {/* Pair list */}
                <div className="max-h-[60vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {dedupData.pairs.length === 0 && (
                    <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px] italic">
                      No duplicate pairs found
                    </div>
                  )}
                  {dedupData.pairs.map((pair) => {
                    const pairKey = `${pair.taskA.id}:${pair.taskB.id}`;
                    return (
                      <div key={pairKey} className="flex items-start gap-2 border-b border-[var(--border)]">
                        <div className="pt-4 pl-3 shrink-0">
                          <input
                            type="checkbox"
                            checked={dedupSelected.has(pairKey)}
                            onChange={() => dedupToggleSelect(pair)}
                            className="w-3.5 h-3.5 rounded accent-[var(--accent)] cursor-pointer"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <DedupPairCard
                            pair={pair}
                            isActioning={actionInFlight === pairKey}
                            onMerge={() => dedupMerge(pair)}
                            onDismiss={() => dedupDismiss(pair)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
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

function ModelSelector({
  pipelineId,
  currentModel,
  currentLabel,
  recommendation,
  availableModels,
  isUpdating,
  onUpdate,
}: {
  pipelineId: string;
  currentModel: string | null;
  currentLabel: string;
  recommendation: string;
  availableModels: AvailableModel[];
  isUpdating: boolean;
  onUpdate: (id: string, model: string | null) => void;
}) {
  const indicatorColor = modelIndicatorColor(currentLabel);
  const showRecommendation =
    recommendation.includes("HAIKU") && currentLabel !== "Haiku";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: indicatorColor }}
        />
        <select
          value={currentModel || ""}
          onChange={(e) => {
            const val = e.target.value || null;
            onUpdate(pipelineId, val);
          }}
          disabled={isUpdating}
          className="text-[12px] bg-[var(--bg)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[var(--text-bright)] cursor-pointer disabled:opacity-50 disabled:cursor-wait appearance-none pr-5"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath fill='%238b949e' d='M0 2l4 4 4-4z'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 6px center",
          }}
        >
          <option value="">Sonnet (default)</option>
          {availableModels
            .filter((m) => m.id !== "claude-sonnet-4-20250514")
            .map((m) => (
              <option key={m.id} value={m.id} disabled={!m.active}>
                {m.label}
                {!m.active ? " (not active)" : ""}
              </option>
            ))}
        </select>
      </div>
      {showRecommendation && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full w-fit"
          style={{
            background: "rgba(63,185,80,0.12)",
            color: "var(--green)",
          }}
        >
          {recommendation.includes("SCRIPT") ? "try Haiku" : "try Haiku"}
        </span>
      )}
    </div>
  );
}

function DedupScoreBadge({ score, action }: { score: number; action: string }) {
  const bg =
    action === "skip"
      ? "rgba(248,81,73,0.12)"
      : action === "merge"
        ? "rgba(227,179,65,0.12)"
        : "rgba(139,148,158,0.12)";
  const color =
    action === "skip"
      ? "var(--red)"
      : action === "merge"
        ? "var(--yellow)"
        : "var(--text-dim)";
  const label =
    action === "skip"
      ? "EXACT DUPE"
      : action === "merge"
        ? "MERGE"
        : "REVIEW";

  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider shrink-0"
      style={{ background: bg, color }}
    >
      {label}
    </span>
  );
}

function DedupSourceBadge({ source }: { source: string }) {
  const sourceColors: Record<string, string> = {
    "PLAUD Recording": "#a371f7",
    "PLAUD (Local)": "#a371f7",
    "Webex Transcript": "#58a6ff",
    "Webex Messages": "#58a6ff",
    "Webex (Local)": "#58a6ff",
    "Gmail": "#f0883e",
    "Gmail (Local)": "#f0883e",
    "Boox": "#3fb950",
    "Boox (Local)": "#3fb950",
    "Manual": "#8b949e",
  };

  const color = sourceColors[source] || "var(--text-dim)";

  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded border shrink-0 whitespace-nowrap"
      style={{ borderColor: color, color }}
    >
      {source || "---"}
    </span>
  );
}

function DedupPriorityBadge({ priority }: { priority: string }) {
  if (!priority) return null;
  const short = priority.replace(/ \u2014.*/, "");
  const color =
    short === "P0"
      ? "var(--red)"
      : short === "P1"
        ? "var(--yellow)"
        : "var(--text-dim)";
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded shrink-0 font-mono"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {short}
    </span>
  );
}

function DedupPairCard({
  pair,
  isActioning,
  onMerge,
  onDismiss,
}: {
  pair: DedupPair;
  isActioning: boolean;
  onMerge: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="px-4 py-3 border-b border-[var(--border)] hover:bg-[rgba(88,166,255,0.03)] transition-colors">
      {/* Header row: score badge + action buttons */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-mono text-[var(--text-dim)]">
            {pair.score.toFixed(2)}
          </span>
          <DedupScoreBadge score={pair.score} action={pair.action} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onMerge}
            disabled={isActioning}
            className="text-[11px] px-2.5 py-1 rounded border border-[var(--green)] text-[var(--green)] hover:bg-[rgba(63,185,80,0.08)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isActioning ? "..." : "Merge"}
          </button>
          <button
            onClick={onDismiss}
            disabled={isActioning}
            className="text-[11px] px-2.5 py-1 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[rgba(88,166,255,0.05)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>

      {/* Task A */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-bold text-[var(--text-dim)] w-3 shrink-0">A</span>
        <span className="text-[12px] text-[var(--text-bright)] truncate flex-1" title={pair.taskA.title}>
          {pair.taskA.title}
        </span>
        <DedupSourceBadge source={pair.taskA.source} />
        <DedupPriorityBadge priority={pair.taskA.priority} />
        {pair.taskA.project && (
          <span className="text-[10px] text-[var(--text-dim)] truncate max-w-[120px]" title={pair.taskA.project}>
            {pair.taskA.project}
          </span>
        )}
      </div>

      {/* Task B */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold text-[var(--text-dim)] w-3 shrink-0">B</span>
        <span className="text-[12px] text-[var(--text-bright)] truncate flex-1" title={pair.taskB.title}>
          {pair.taskB.title}
        </span>
        <DedupSourceBadge source={pair.taskB.source} />
        <DedupPriorityBadge priority={pair.taskB.priority} />
        {pair.taskB.project && (
          <span className="text-[10px] text-[var(--text-dim)] truncate max-w-[120px]" title={pair.taskB.project}>
            {pair.taskB.project}
          </span>
        )}
      </div>
    </div>
  );
}
