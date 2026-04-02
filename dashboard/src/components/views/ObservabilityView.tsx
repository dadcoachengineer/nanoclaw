"use client";

import { useEffect, useState, useRef } from "react";
import { Card, CardHeader, StatCard } from "@/components/Card";

// ── Types ──────────────────────

interface Hop {
  id: string;
  label: string;
  type: string;
  position: number;
  status: string;
  latencyMs: number;
  metrics: any;
}

interface PipelineStat {
  id: string;
  runs: number;
  successes: number;
  errors: number;
  avgDurationMs: number;
  lastRun: string;
}

interface ObsData {
  timestamp: string;
  hops: Hop[];
  host: any;
  docker: any;
  nginx: any;
  pg: any;
  ollamaLocal: any;
  ollamaStudio: any;
  pipelines: {
    recentRuns: any[];
    pipelineStats: PipelineStat[];
    tasksPerDay: { day: string; count: number }[];
    triage: { inbox: number; accepted: number; dismissed: number };
    notionSync: { outboundOk: number; outboundErr: number; inboundOk: number };
  };
  dataFlow: {
    tasksBySource: { source: string; count: number }[];
    archiveBySource: { source: string; count: number }[];
  };
  sparklines: Record<string, { time: string; value: number }[]>;
}

// ── Helpers ──────────────────────

const STATUS_COLORS: Record<string, string> = {
  healthy: "#3fb950", degraded: "#d29922", down: "#f85149", unknown: "#8b949e",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / (1024 ** 2))}MB`;
  return `${(bytes / (1024 ** 3)).toFixed(1)}GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

// ── Sparkline SVG ──────────────────────

function Sparkline({ data, width = 120, height = 28, color = "#58a6ff" }: { data: number[]; width?: number; height?: number; color?: string }) {
  if (data.length < 2) return <div style={{ width, height }} className="bg-[var(--bg)] rounded" />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Bar Chart ──────────────────────

function BarChart({ data, width = 200, height = 60 }: { data: { label: string; value: number }[]; width?: number; height?: number }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const barW = Math.floor((width - data.length * 2) / data.length);
  return (
    <svg width={width} height={height + 16}>
      {data.map((d, i) => {
        const barH = (d.value / max) * height;
        const x = i * (barW + 2);
        return (
          <g key={i}>
            <rect x={x} y={height - barH} width={barW} height={barH} rx={2} fill="#58a6ff" opacity={0.7} />
            <text x={x + barW / 2} y={height + 12} textAnchor="middle" fontSize="8" fill="#8b949e">{d.label.slice(5)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Hop Card ──────────────────────

function HopCard({ hop, expanded, onToggle }: { hop: Hop; expanded: boolean; onToggle: () => void }) {
  const color = STATUS_COLORS[hop.status] || STATUS_COLORS.unknown;
  const typeIcons: Record<string, string> = {
    host: "H", proxy: "P", service: "S", inference: "AI", database: "DB", gateway: "GW", channel: "CH",
  };
  return (
    <div className="bg-[var(--surface)] rounded-lg border border-[var(--border)] overflow-hidden">
      <button onClick={onToggle} className="w-full px-3 py-2.5 flex items-center gap-2 hover:bg-[rgba(88,166,255,0.04)] transition-colors">
        <div className="w-2 h-2 rounded-full shrink-0 animate-pulse" style={{ backgroundColor: color }} />
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[rgba(139,148,158,0.1)] text-[var(--text-dim)]">{typeIcons[hop.type] || "?"}</span>
        <span className="text-xs font-medium text-[var(--text-bright)] flex-1 text-left">{hop.label}</span>
        {hop.latencyMs > 0 && <span className="text-[10px] font-mono text-[var(--text-dim)]">{hop.latencyMs}ms</span>}
        <span className="text-[10px]" style={{ color }}>{hop.status}</span>
      </button>
      {expanded && hop.metrics && Object.keys(hop.metrics).length > 0 && (
        <div className="px-3 pb-3 border-t border-[var(--border)]">
          <MetricDetails hop={hop} />
        </div>
      )}
    </div>
  );
}

function MetricDetails({ hop }: { hop: Hop }) {
  const m = hop.metrics;
  if (hop.id === "mac-mini" && m.memTotalGb) {
    return (
      <div className="grid grid-cols-3 gap-3 pt-2 text-[10px]">
        <div><div className="text-[var(--text-dim)]">CPU Load</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.load1?.toFixed(1)} / {m.load5?.toFixed(1)} / {m.load15?.toFixed(1)}</div></div>
        <div><div className="text-[var(--text-dim)]">Memory</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.memUsedGb}GB / {m.memTotalGb}GB</div>
          <div className="h-1 bg-[var(--border)] rounded-full mt-1"><div className="h-full bg-[var(--accent)] rounded-full" style={{ width: `${(m.memUsedGb / m.memTotalGb) * 100}%` }} /></div>
        </div>
        <div><div className="text-[var(--text-dim)]">Disk</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.diskUsedGb}GB / {m.diskTotalGb}GB</div>
          <div className="h-1 bg-[var(--border)] rounded-full mt-1"><div className="h-full bg-[var(--yellow)] rounded-full" style={{ width: `${m.diskUsedPct}%` }} /></div>
        </div>
        <div><div className="text-[var(--text-dim)]">Uptime</div><div className="text-sm font-mono text-[var(--text-bright)]">{formatUptime(m.uptimeSeconds)}</div></div>
      </div>
    );
  }
  if (hop.id === "postgresql" && m.sizeMb) {
    return (
      <div className="grid grid-cols-3 gap-3 pt-2 text-[10px]">
        <div><div className="text-[var(--text-dim)]">Size</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.sizeMb}MB</div></div>
        <div><div className="text-[var(--text-dim)]">Connections</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.activeConnections} active / {m.connections} total</div></div>
        <div><div className="text-[var(--text-dim)]">Cache Hit</div><div className="text-sm font-mono text-[var(--green)]">{m.cacheHitRatio}%</div></div>
        <div><div className="text-[var(--text-dim)]">Latency</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.latencyMs}ms</div></div>
        {m.topTables && (
          <div className="col-span-3">
            <div className="text-[var(--text-dim)] mb-1">Top Tables</div>
            <div className="space-y-0.5">
              {m.topTables.slice(0, 5).map((t: any) => (
                <div key={t.name} className="flex items-center gap-2 font-mono">
                  <span className="text-[var(--text)]">{t.name}</span>
                  <span className="text-[var(--text-dim)] ml-auto">{t.rows.toLocaleString()} rows</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  if ((hop.id === "defenseclaw-ollama" || hop.id === "defenseclaw-anthropic") && m.mode) {
    return (
      <div className="grid grid-cols-3 gap-3 pt-2 text-[10px]">
        <div><div className="text-[var(--text-dim)]">Mode</div><div className={`text-sm font-mono ${m.mode === "observe" ? "text-[var(--yellow)]" : m.mode === "action" ? "text-[var(--green)]" : "text-[var(--text)]"}`}>{m.mode}</div></div>
        <div><div className="text-[var(--text-dim)]">State</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.state}</div></div>
        <div><div className="text-[var(--text-dim)]">Latency</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.latencyMs}ms</div></div>
        <div><div className="text-[var(--text-dim)]">Uptime</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.uptime ? formatUptime(m.uptime) : "?"}</div></div>
        <div><div className="text-[var(--text-dim)]">Port</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.port}</div></div>
      </div>
    );
  }
  if (hop.id === "ollama-studio" && m.loaded) {
    return (
      <div className="pt-2 text-[10px]">
        <div className="text-[var(--text-dim)] mb-1">Loaded Models ({m.totalVramGb}GB VRAM)</div>
        <div className="space-y-1">
          {m.loaded.map((model: any) => (
            <div key={model.name} className="flex items-center gap-2 font-mono">
              <div className="w-2 h-2 rounded-full bg-[var(--green)]" />
              <span className="text-[var(--text-bright)]">{model.name}</span>
              <span className="text-[var(--text-dim)] ml-auto">{model.vramGb}GB</span>
            </div>
          ))}
        </div>
        <div className="text-[var(--text-dim)] mt-2">{m.modelCount} models installed, latency: {m.latencyMs}ms</div>
      </div>
    );
  }
  if (hop.id === "docker" && m.containers) {
    return (
      <div className="pt-2 text-[10px]">
        <div className="text-[var(--text-dim)] mb-1">{m.running} running containers</div>
        {m.containers.map((c: any) => (
          <div key={c.name} className="flex items-center gap-2 font-mono py-0.5">
            <div className="w-2 h-2 rounded-full bg-[var(--green)]" />
            <span className="text-[var(--text)]">{c.name}</span>
            <span className="text-[var(--text-dim)] ml-auto">{c.status}</span>
          </div>
        ))}
        {m.diskUsage && m.diskUsage.map((d: any) => (
          <div key={d.type} className="flex items-center gap-2 font-mono py-0.5 text-[var(--text-dim)]">
            <span>{d.type}:</span><span>{d.size}</span><span className="ml-auto">reclaimable: {d.reclaimable}</span>
          </div>
        ))}
      </div>
    );
  }
  if (hop.id === "nginx") {
    return (
      <div className="grid grid-cols-2 gap-3 pt-2 text-[10px]">
        <div><div className="text-[var(--text-dim)]">Status</div><div className="text-sm font-mono text-[var(--text-bright)]">{m.running ? "Running" : "Down"}</div></div>
        <div><div className="text-[var(--text-dim)]">Cert Expiry</div><div className={`text-sm font-mono ${m.certDaysLeft > 14 ? "text-[var(--green)]" : "text-[var(--red)]"}`}>{m.certDaysLeft >= 0 ? `${m.certDaysLeft} days` : "Unknown"}</div></div>
      </div>
    );
  }
  // Generic JSON fallback
  return (
    <pre className="pt-2 text-[9px] font-mono text-[var(--text-dim)] max-h-[150px] overflow-y-auto">
      {JSON.stringify(m, null, 2)}
    </pre>
  );
}

// ── Service Topology SVG ──────────────────────

// Application-level service connections (not physical hosts)
// Traces actual request flows between services
// Verified application service connections (audited 2026-04-01)
const TOPOLOGY_EDGES: [string, string, string][] = [
  // Ingress
  ["browser", "nginx", "HTTPS :443"],
  ["nginx", "dashboard", "HTTP :3940"],
  // Dashboard → backend services
  ["dashboard", "postgresql", "TCP :5432"],
  ["dashboard", "defenseclaw-ollama", "HTTP :9001"], // chat, synthesize, triage via DefenseClaw
  ["dashboard", "onecli", "HTTPS :10255"],        // proxiedFetch for Notion blocks, Webex
  // NanoClaw Core → services
  ["nanoclaw-core", "postgresql", "TCP :5432"],
  ["nanoclaw-core", "defenseclaw-ollama", "HTTP :9001"], // pipeline scripts via DefenseClaw
  ["nanoclaw-core", "docker", "Docker API"],
  ["nanoclaw-core", "onecli", "HTTPS :10255"],
  // DefenseClaw → upstream
  ["defenseclaw-ollama", "ollama-studio", "HTTP :11434"], // DC inspects then forwards to Ollama
  // Container agents → cloud (DefenseClaw pending — streaming format mismatch)
  ["docker", "onecli", "HTTPS :10255"],
  // Notion bidirectional sync
  // OneCLI → external APIs (only Notion, Plaud, Boox/Nextcloud)
  ["onecli", "notion-api", "HTTPS"],
  ["onecli", "plaud-api", "HTTPS"],
  // ALL external API calls now route through OneCLI (as of 2026-04-01)
  ["onecli", "webex-api", "HTTPS"],
  ["onecli", "anthropic-api", "HTTPS"],
  ["onecli", "google-api", "HTTPS"],
];

// Verified service positions — 4 columns, accurate connections
// INGRESS | CORE | INFRA | EXTERNAL
const TOPOLOGY_POSITIONS: Record<string, { x: number; y: number; color: string }> = {
  // Column 1: Ingress
  "browser":        { x: 70,  y: 45,  color: "#8b949e" },
  "nginx":          { x: 70,  y: 115, color: "#3fb950" },
  // Column 2: Core services
  "dashboard":      { x: 240, y: 45,  color: "#58a6ff" },
  "nanoclaw-core":  { x: 240, y: 115, color: "#58a6ff" },
  // Column 3: Security + Infrastructure
  "defenseclaw-ollama":    { x: 420, y: 45,  color: "#d29922" },
  "defenseclaw-anthropic": { x: 420, y: 115, color: "#d29922" },
  "docker":                { x: 420, y: 185, color: "#bc8cff" },
  "onecli":                { x: 240, y: 185, color: "#d29922" },
  // Column 4: Upstream
  "postgresql":     { x: 560, y: 45,  color: "#3fb950" },
  "ollama-studio":  { x: 560, y: 115, color: "#3fb950" },
  // Column 5: External APIs
  "notion-api":     { x: 700, y: 35,  color: "#8b949e" },
  "webex-api":      { x: 700, y: 75,  color: "#8b949e" },
  "anthropic-api":  { x: 700, y: 115, color: "#8b949e" },
  "plaud-api":      { x: 700, y: 155, color: "#8b949e" },
  "google-api":     { x: 700, y: 195, color: "#8b949e" },
};

const TOPOLOGY_LABELS: Record<string, string> = {
  "browser": "Browser",
  "nginx": "Nginx :443",
  "dashboard": "Dashboard :3940",
  "nanoclaw-core": "NanoClaw :3939",
  "defenseclaw-ollama": "DC :9001",
  "defenseclaw-anthropic": "DC :9002",
  "docker": "Docker",
  "onecli": "OneCLI :10255",
  "postgresql": "PG :5432",
  "ollama-studio": "Ollama :11434",
  "notion-api": "Notion",
  "webex-api": "Webex",
  "anthropic-api": "Anthropic",
  "plaud-api": "Plaud",
  "google-api": "Google",
};

function ServiceTopology({ hops, sparklines, expandedHop, onHopClick }: {
  hops: Hop[];
  sparklines: Record<string, { time: string; value: number }[]>;
  expandedHop: string | null;
  onHopClick: (id: string) => void;
}) {
  const svgW = 800;
  const svgH = 230;

  // Get status for a node (from hops data or default)
  const getStatus = (id: string): string => {
    const hop = hops.find((h) => h.id === id);
    if (hop) return hop.status;
    // External APIs are always "healthy" (we don't monitor them directly)
    if (id === "browser" || id.endsWith("-api")) return "healthy";
    return "unknown";
  };

  const columns = [
    { x: 70, label: "ENTRY" },
    { x: 240, label: "CORE" },
    { x: 420, label: "SECURITY" },
    { x: 560, label: "UPSTREAM" },
    { x: 700, label: "EXTERNAL" },
  ];

  return (
    <svg width="100%" viewBox={`0 0 ${svgW} ${svgH}`} className="w-full">
      {/* Column headers */}
      {columns.map((col) => (
        <text key={col.label} x={col.x} y={14} textAnchor="middle" fontSize="8" fontWeight="600" fill="#484f58" letterSpacing="0.5">{col.label}</text>
      ))}

      {/* Connection lines with protocol labels */}
      {TOPOLOGY_EDGES.map(([from, to, protocol], i) => {
        const fromPos = TOPOLOGY_POSITIONS[from];
        const toPos = TOPOLOGY_POSITIONS[to];
        if (!fromPos || !toPos) return null;
        const fromOk = getStatus(from) === "healthy";
        const toOk = getStatus(to) === "healthy";
        const healthy = fromOk && toOk;
        // Bezier curve for non-straight connections
        const dx = toPos.x - fromPos.x;
        const midX = fromPos.x + dx * 0.5;
        const path = `M${fromPos.x + 40},${fromPos.y} C${midX},${fromPos.y} ${midX},${toPos.y} ${toPos.x - 40},${toPos.y}`;
        return (
          <g key={`edge-${i}`}>
            <path d={path} fill="none"
              stroke={healthy ? "#30363d" : "#f85149"}
              strokeWidth={1} strokeDasharray={healthy ? "none" : "4 3"} opacity={0.3} />
            {/* Animated flow dot */}
            {healthy && (
              <circle r={1.5} fill="#58a6ff" opacity={0.5}>
                <animateMotion dur={`${1.5 + (i % 4) * 0.5}s`} repeatCount="indefinite" path={path} />
              </circle>
            )}
          </g>
        );
      })}

      {/* Service nodes */}
      {Object.entries(TOPOLOGY_POSITIONS).map(([id, pos]) => {
        const status = getStatus(id);
        const color = STATUS_COLORS[status] || STATUS_COLORS.unknown;
        const nodeColor = pos.color;
        const isSelected = expandedHop === id;
        const isClickable = hops.some((h) => h.id === id);
        const label = TOPOLOGY_LABELS[id] || id;
        const sparkData = (sparklines[id] || []).map((s) => s.value);
        const isExternal = id.endsWith("-api") || id === "browser";
        const boxW = isExternal ? 65 : 90;
        const boxH = isExternal ? 24 : 34;

        return (
          <g key={id}
            onClick={isClickable ? () => onHopClick(id) : undefined}
            style={{ cursor: isClickable ? "pointer" : "default" }}>
            {/* Selection highlight */}
            {isSelected && <rect x={pos.x - boxW / 2 - 3} y={pos.y - boxH / 2 - 3} width={boxW + 6} height={boxH + 6} rx={9} fill="none" stroke="#58a6ff" strokeWidth={1.5} />}
            {/* Node box */}
            <rect x={pos.x - boxW / 2} y={pos.y - boxH / 2} width={boxW} height={boxH} rx={6}
              fill={isSelected ? "rgba(88,166,255,0.1)" : isExternal ? "rgba(139,148,158,0.06)" : "rgba(22,27,34,0.95)"}
              stroke={isExternal ? "#30363d" : nodeColor} strokeWidth={isExternal ? 0.5 : 1} />
            {/* Status dot */}
            <circle cx={pos.x - boxW / 2 + 8} cy={pos.y - 4} r={2.5} fill={color}>
              {status === "healthy" && <animate attributeName="opacity" values="1;0.5;1" dur="3s" repeatCount="indefinite" />}
            </circle>
            {/* Label */}
            <text x={pos.x} y={pos.y - 2} textAnchor="middle" fontSize="8" fontWeight="500" fill={isExternal ? "#8b949e" : "#e6edf3"}>{label.split(" :")[0]}</text>
            {/* Port/subtitle */}
            {label.includes(":") && (
              <text x={pos.x} y={pos.y + 8} textAnchor="middle" fontSize="7" fill="#484f58" fontFamily="monospace">:{label.split(":")[1]}</text>
            )}
            {!label.includes(":") && !isExternal && (
              <text x={pos.x} y={pos.y + 8} textAnchor="middle" fontSize="7" fill="#484f58">{hops.find((h) => h.id === id)?.type || ""}</text>
            )}
            {/* Sparkline removed — too small to be useful, caused visual clutter */}
          </g>
        );
      })}
    </svg>
  );
}

// ── Data Flow Sankey ──────────────────────

// Model routing map: which sources go to which model (verified from pipeline scripts)
const SOURCE_MODEL_MAP: Record<string, string> = {
  "Webex Message": "gemma3:27b", "Webex Message (Local)": "gemma3:27b",
  "Webex Transcript": "gemma3:27b", "Webex Transcript (Local)": "gemma3:27b",
  "PLAUD Recording": "gemma3:27b", "PLAUD Recording (Local)": "gemma3:27b",
  "Boox Note": "gemma3:27b", "Boox Note (Local)": "gemma3:27b",
  "Gmail": "gemma3:27b", "Gmail (Local)": "gemma3:27b",
  "Calendar": "granite3.3:8b",
  "Webex AI Summary": "gemma3:27b",
  "Claude": "anthropic", // Container agents → Anthropic API
  "Documentation": "anthropic",
};

const MODEL_COLORS: Record<string, string> = {
  "gemma3:27b": "#58a6ff",
  "granite3.3:8b": "#3fb950",
  "anthropic": "#bc8cff",
};

const MODEL_LABELS: Record<string, string> = {
  "gemma3:27b": "Gemma 27B",
  "granite3.3:8b": "Granite 8B",
  "anthropic": "Anthropic API",
};

function DataFlowSankey({ sources, triage }: {
  sources: { source: string; count: number }[];
  triage: { inbox: number; accepted: number; dismissed: number };
}) {
  const total = sources.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <div className="text-xs text-[var(--text-dim)] italic py-4">No data flow in the last 7 days</div>;

  // Deduplicate sources: merge "(Local)" variants
  const deduped: Record<string, number> = {};
  for (const src of sources) {
    if (!src.source) continue;
    let key = src.source.replace(" (Local)", "").replace("PLAUD ", "Plaud ");
    if (key === "Claude") key = "Container Agents";
    deduped[key] = (deduped[key] || 0) + src.count;
  }
  const leftItems = Object.entries(deduped).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Map cleaned source names to models
  const cleanSourceModelMap: Record<string, string> = {
    "Webex Message": "gemma3:27b", "Webex Transcript": "gemma3:27b",
    "Plaud Recording": "gemma3:27b", "Boox Note": "gemma3:27b",
    "Gmail": "gemma3:27b", "Webex AI Summary": "gemma3:27b",
    "Calendar": "granite3.3:8b",
    "Container Agents": "anthropic", "Claude": "anthropic", "Documentation": "anthropic",
    "Webex Meeting": "gemma3:27b",
  };

  const sourceColors: Record<string, string> = {
    "Webex Message": "#58a6ff", "Plaud Recording": "#bc8cff",
    "Boox Note": "#d29922", "Gmail": "#f85149", "Calendar": "#3fb950",
    "Webex Transcript": "#79c0ff", "Webex AI Summary": "#8b949e",
    "Container Agents": "#bc8cff", "Claude": "#bc8cff", "Webex Meeting": "#8b949e",
  };

  // Group by model
  const modelCounts: Record<string, number> = {};
  for (const [name, count] of leftItems) {
    const model = cleanSourceModelMap[name] || "gemma3:27b";
    modelCounts[model] = (modelCounts[model] || 0) + count;
  }
  const models = Object.entries(modelCounts).sort((a, b) => b[1] - a[1]);

  // Outcomes
  const accepted = triage.accepted || 0;
  const dismissed = triage.dismissed || 0;
  const inbox = triage.inbox || 0;
  const outcomes = [
    { label: "Accepted", count: accepted, color: "#3fb950" },
    { label: "In Triage", count: inbox, color: "#d29922" },
    { label: "Dismissed", count: dismissed, color: "#8b949e" },
  ].filter((o) => o.count > 0);
  const rightTotal = outcomes.reduce((s, o) => s + o.count, 0);

  // Layout constants
  const svgW = 700;
  const rowH = 22;
  const srcCount = leftItems.length;
  const svgH = Math.max(srcCount * rowH + 40, models.length * 50 + 40, 160);
  const topY = 28;

  // Fixed column positions
  const srcX = 10;
  const srcLabelX = 24;
  const srcCountX = 165;
  const modelX = 320;
  const modelW = 100;
  const outcomeBarX = 580;
  const outcomeLabelX = 596;

  return (
    <svg width="100%" viewBox={`0 0 ${svgW} ${svgH}`} className="w-full">
      {/* Column labels */}
      <text x={80} y={16} textAnchor="middle" fontSize="9" fontWeight="600" fill="#484f58" letterSpacing="0.5">SOURCES</text>
      <text x={modelX + modelW / 2} y={16} textAnchor="middle" fontSize="9" fontWeight="600" fill="#484f58" letterSpacing="0.5">MODEL</text>
      <text x={630} y={16} textAnchor="middle" fontSize="9" fontWeight="600" fill="#484f58" letterSpacing="0.5">OUTCOMES</text>

      {/* Source rows — evenly spaced */}
      {leftItems.map(([name, count], i) => {
        const y = topY + i * rowH + rowH / 2;
        const color = sourceColors[name] || "#8b949e";
        const model = cleanSourceModelMap[name] || "gemma3:27b";
        const modelIdx = models.findIndex(([m]) => m === model);
        const modelCenterY = topY + modelIdx * (svgH - topY - 10) / models.length + (svgH - topY - 10) / models.length / 2;

        return (
          <g key={name}>
            <rect x={srcX} y={y - 4} width={8} height={8} rx={2} fill={color} opacity={0.8} />
            <text x={srcLabelX} y={y + 3} fontSize="9" fill="#e6edf3">{name}</text>
            <text x={srcCountX} y={y + 3} fontSize="9" fill="#8b949e" fontFamily="monospace">{count}</text>
            <path d={`M ${srcCountX + 25} ${y} C ${srcCountX + 80} ${y}, ${modelX - 40} ${modelCenterY}, ${modelX} ${modelCenterY}`}
              fill="none" stroke={MODEL_COLORS[model] || "#8b949e"} strokeWidth={Math.max(0.8, Math.min(3, count / 200))} opacity={0.2} />
          </g>
        );
      })}

      {/* Model boxes — evenly distributed vertically */}
      {models.map(([model, count], i) => {
        const sectionH = (svgH - topY - 10) / models.length;
        const y = topY + i * sectionH;
        const boxH = Math.min(sectionH - 6, 40);
        const centerY = y + sectionH / 2;
        const color = MODEL_COLORS[model] || "#8b949e";
        const label = MODEL_LABELS[model] || model;
        const isLocal = model !== "anthropic";
        return (
          <g key={model}>
            <rect x={modelX} y={centerY - boxH / 2} width={modelW} height={boxH} rx={6}
              fill={`${color}10`} stroke={color} strokeWidth={1}
              strokeDasharray={isLocal ? "none" : "4 2"} />
            <text x={modelX + modelW / 2} y={centerY - 3} textAnchor="middle" fontSize="10" fontWeight="600" fill={color}>{label}</text>
            <text x={modelX + modelW / 2} y={centerY + 10} textAnchor="middle" fontSize="8" fill="#8b949e">{count} items</text>
          </g>
        );
      })}

      {/* Outcome rows */}
      {outcomes.map((item, i) => {
        const sectionH = (svgH - topY - 10) / outcomes.length;
        const centerY = topY + i * sectionH + sectionH / 2;
        const barH = Math.max(10, (item.count / rightTotal) * (svgH - topY - 20) * 0.7);

        return (
          <g key={item.label}>
            {/* Flow lines from models to this outcome */}
            {models.map(([model], mi) => {
              const modelSectionH = (svgH - topY - 10) / models.length;
              const modelCenterY = topY + mi * modelSectionH + modelSectionH / 2;
              return (
                <path key={`${model}-${item.label}`}
                  d={`M ${modelX + modelW} ${modelCenterY} C ${modelX + modelW + 60} ${modelCenterY}, ${outcomeBarX - 60} ${centerY}, ${outcomeBarX} ${centerY}`}
                  fill="none" stroke={item.color}
                  strokeWidth={Math.max(0.5, (item.count / rightTotal) * 2)}
                  opacity={0.15} />
              );
            })}
            <rect x={outcomeBarX} y={centerY - barH / 2} width={10} height={barH} rx={3} fill={item.color} opacity={0.8} />
            <text x={outcomeLabelX} y={centerY + 3} fontSize="9" fill="#e6edf3">{item.label}</text>
            <text x={670} y={centerY + 3} fontSize="9" fill="#8b949e" fontFamily="monospace">{item.count}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Main Component ──────────────────────

export default function ObservabilityView() {
  const [data, setData] = useState<ObsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedHop, setExpandedHop] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const [dcInstances, setDcInstances] = useState<{ id: string; label: string; healthy: boolean; mode: string; uptime: number; state: string }[]>([]);
  const [dcUpdating, setDcUpdating] = useState<string | null>(null);

  function loadDcInstances() {
    fetch("/api/defenseclaw").then((r) => r.json()).then((d) => {
      if (d.instances) setDcInstances(d.instances);
    }).catch(() => {});
  }

  function load(sample = false) {
    fetch(`/api/observability${sample ? "?sample=true" : ""}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(true);
    loadDcInstances();
    if (autoRefresh) {
      intervalRef.current = setInterval(() => { load(true); loadDcInstances(); }, 15000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh]);

  if (loading || !data) return <div className="w-full px-6 py-6"><div className="text-center text-[var(--text-dim)] py-20">Loading observability data...</div></div>;

  const { hops, host, pg, ollamaStudio, pipelines, dataFlow } = data;

  return (
    <div className="w-full px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--text-bright)]">Observability</h2>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-[var(--text-dim)]">Last: {new Date(data.timestamp).toLocaleTimeString()}</span>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`text-[10px] px-2 py-1 rounded ${autoRefresh ? "bg-[rgba(63,185,80,0.15)] text-[var(--green)]" : "bg-[var(--bg)] text-[var(--text-dim)]"}`}
          >
            {autoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF"}
          </button>
          <button onClick={() => load(true)} className="text-[10px] text-[var(--accent)] hover:underline">Refresh</button>
        </div>
      </div>

      {/* Row 1: Top stats */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard label="SYSTEM LOAD" value={host?.load1?.toFixed(2) || "?"} />
        <StatCard label="MEMORY" value={`${host?.memUsedGb || "?"}GB / ${host?.memTotalGb || "?"}GB`} />
        <StatCard label="PG LATENCY" value={`${pg?.latencyMs || "?"}ms`} />
        <StatCard label="STUDIO VRAM" value={`${ollamaStudio?.totalVramGb || "?"}GB`} />
        <StatCard label="TASKS (7d)" value={`${pipelines?.tasksPerDay?.reduce((s: number, d: { count: number }) => s + d.count, 0) || 0}`} />
      </div>

      {/* Row 2: Service Topology */}
      <Card>
        <CardHeader title="Service Topology" right={
          <span className="text-[10px] text-[var(--text-dim)]">{hops.filter((h) => h.status === "healthy").length}/{hops.length} healthy</span>
        } />
        <div className="px-4 py-3">
          <ServiceTopology hops={hops} sparklines={data.sparklines} expandedHop={expandedHop} onHopClick={(id) => setExpandedHop(expandedHop === id ? null : id)} />
          {/* Expanded hop detail */}
          {expandedHop && (() => {
            const hop = hops.find((h) => h.id === expandedHop);
            if (!hop) return null;
            return (
              <div className="mt-3 pt-3 border-t border-[var(--border)]">
                <HopCard hop={hop} expanded={true} onToggle={() => setExpandedHop(null)} />
              </div>
            );
          })()}
        </div>
      </Card>

      {/* Row 2b: Data Flow Sankey */}
      <Card>
        <CardHeader title="Data Flow (7d)" />
        <div className="px-4 py-3">
          <DataFlowSankey sources={dataFlow.tasksBySource} triage={pipelines.triage} />
        </div>
      </Card>

      {/* Row 3: Pipeline Performance (full width) */}
      <div className="grid grid-cols-1 gap-4">
        <Card>
          <CardHeader title="Pipeline Performance (7d)" right={
            <span className="text-[10px] text-[var(--text-dim)]">{pipelines.pipelineStats.length} pipelines</span>
          } />
          <div className="max-h-[350px] overflow-y-auto">
            {pipelines.pipelineStats.map((p) => {
              const successRate = p.runs > 0 ? Math.round((p.successes / p.runs) * 100) : 0;
              return (
                <div key={p.id} className="px-4 py-2 border-b border-[var(--border)] last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-[var(--text)] flex-1 truncate">{p.id.replace("mc-", "")}</span>
                    <span className={`text-[10px] font-mono ${successRate >= 90 ? "text-[var(--green)]" : successRate >= 50 ? "text-[var(--yellow)]" : "text-[var(--red)]"}`}>
                      {successRate}%
                    </span>
                    <span className="text-[10px] text-[var(--text-dim)] font-mono">{p.runs} runs</span>
                    <span className="text-[10px] text-[var(--text-dim)] font-mono">{formatDuration(p.avgDurationMs)} avg</span>
                  </div>
                  <div className="h-1 bg-[var(--border)] rounded-full mt-1">
                    <div className="h-full bg-[var(--green)] rounded-full" style={{ width: `${successRate}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

      </div>

      {/* Row 3b: DefenseClaw Security */}
      {dcInstances.length > 0 && (
        <Card>
          <CardHeader title="DefenseClaw Security" right={
            <span className="text-[10px] text-[var(--text-dim)]">
              {dcInstances.filter((i) => i.healthy).length}/{dcInstances.length} healthy
            </span>
          } />
          <div className="px-4 py-3">
            <div className="grid grid-cols-2 gap-4">
              {dcInstances.map((inst) => (
                <div key={inst.id} className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: inst.healthy ? "#3fb950" : "#f85149" }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-[var(--text-bright)]">{inst.label}</div>
                    <div className="text-[10px] text-[var(--text-dim)]">
                      {inst.state === "running" ? `uptime ${formatUptime(inst.uptime)}` : inst.state}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={inst.mode}
                      onChange={async (e) => {
                        setDcUpdating(inst.id);
                        await fetch("/api/defenseclaw", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ instance: inst.id, mode: e.target.value }),
                        });
                        setDcUpdating(null);
                        loadDcInstances();
                      }}
                      disabled={dcUpdating === inst.id || !inst.healthy}
                      className={`text-[10px] px-2 py-0.5 rounded border cursor-pointer ${
                        inst.mode === "observe"
                          ? "border-[var(--yellow)] text-[var(--yellow)] bg-[rgba(210,153,34,0.08)]"
                          : inst.mode === "action"
                          ? "border-[var(--green)] text-[var(--green)] bg-[rgba(63,185,80,0.08)]"
                          : "border-[var(--border)] text-[var(--text-dim)]"
                      } disabled:opacity-40`}
                    >
                      <option value="observe">observe</option>
                      <option value="action">action</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Row 4: Triage + Notion Sync + AI Models */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader title="Triage (7d)" />
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-dim)]">Inbox</span>
              <span className="font-mono text-[var(--yellow)]">{pipelines.triage.inbox}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-dim)]">Accepted</span>
              <span className="font-mono text-[var(--green)]">{pipelines.triage.accepted}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-dim)]">Dismissed</span>
              <span className="font-mono text-[var(--text-dim)]">{pipelines.triage.dismissed}</span>
            </div>
            {pipelines.triage.accepted + pipelines.triage.dismissed > 0 && (
              <div className="pt-2 border-t border-[var(--border)]">
                <div className="text-[10px] text-[var(--text-dim)]">Accept Rate</div>
                <div className="text-lg font-mono text-[var(--green)]">
                  {Math.round((pipelines.triage.accepted / (pipelines.triage.accepted + pipelines.triage.dismissed)) * 100)}%
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Notion Sync (24h)" />
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-dim)]">Pushed to Notion</span>
              <span className="font-mono text-[var(--green)]">{pipelines.notionSync.outboundOk}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-dim)]">Push Errors</span>
              <span className={`font-mono ${pipelines.notionSync.outboundErr > 0 ? "text-[var(--red)]" : "text-[var(--text-dim)]"}`}>{pipelines.notionSync.outboundErr}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--text-dim)]">Pulled from Notion</span>
              <span className="font-mono text-[var(--accent)]">{pipelines.notionSync.inboundOk}</span>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="AI Models" />
          <div className="px-4 py-3 space-y-2">
            {ollamaStudio?.loaded?.map((model: any) => (
              <div key={model.name} className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[var(--green)]" />
                <span className="text-xs font-mono text-[var(--text)]">{model.name}</span>
                <span className="text-[10px] text-[var(--text-dim)] ml-auto">{model.vramGb}GB VRAM</span>
              </div>
            ))}
            {ollamaStudio?.loaded?.length === 0 && (
              <div className="text-xs text-[var(--text-dim)] italic">No models loaded</div>
            )}
            <div className="pt-2 border-t border-[var(--border)] text-[10px] text-[var(--text-dim)]">
              Studio: {ollamaStudio?.modelCount || 0} models, {ollamaStudio?.totalVramGb || 0}GB VRAM
            </div>
          </div>
        </Card>
      </div>

      {/* Row 5: Recent Pipeline Runs */}
      <Card>
        <CardHeader title="Recent Pipeline Runs (24h)" right={
          <span className="text-[10px] text-[var(--text-dim)]">{pipelines.recentRuns.length} runs</span>
        } />
        <div className="max-h-[300px] overflow-y-auto">
          {pipelines.recentRuns.slice(0, 20).map((r, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-1.5 border-b border-[var(--border)] last:border-0 text-xs">
              <div className={`w-2 h-2 rounded-full ${r.status === "success" ? "bg-[var(--green)]" : "bg-[var(--red)]"}`} />
              <span className="font-mono text-[var(--text)] w-36 truncate">{r.task_id.replace("mc-", "")}</span>
              <span className="text-[var(--text-dim)] font-mono">{formatDuration(r.duration_ms)}</span>
              <span className="text-[var(--text-dim)] ml-auto">{new Date(r.run_at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
