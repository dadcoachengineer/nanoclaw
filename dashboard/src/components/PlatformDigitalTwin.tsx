"use client";

import { useEffect, useState } from "react";

interface HealthData {
  status: string;
  checks: {
    postgresql?: { status: string; latencyMs?: number; size?: string; total_tasks?: number; open_tasks?: number; triage_inbox?: number; sync_pending?: number; sync_ok?: number; people?: number; vectors?: number; archive?: number };
    nanoclaw?: { status: string; uptime?: number; containers?: { active: number } };
    ollama?: { status: string; modelCount?: number; models?: { name: string; sizeGb: number }[] };
    nginx?: { status: string; certDaysLeft?: number; certStatus?: string };
    notionSync?: { status: string; last24h?: Record<string, number>; lastSuccess?: string };
    pipelines?: { id: string; lastStatus?: string; lastRun?: string; nextRun?: string }[];
  };
}

const STATUS_COLORS: Record<string, string> = {
  healthy: "#3fb950",
  active: "#3fb950",
  connected: "#3fb950",
  valid: "#3fb950",
  attention: "#d29922",
  expiring: "#d29922",
  degraded: "#d29922",
  unreachable: "#f85149",
  error: "#f85149",
  expired: "#f85149",
  unknown: "#8b949e",
};

function statusColor(status?: string): string {
  return STATUS_COLORS[status || "unknown"] || "#8b949e";
}

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default function PlatformDigitalTwin() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const load = () => fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    load();
    const interval = setInterval(load, 15000);
    const animation = setInterval(() => setTick((t) => t + 1), 2000);
    return () => { clearInterval(interval); clearInterval(animation); };
  }, []);

  const c = health?.checks || {};
  const pg = c.postgresql || {} as NonNullable<HealthData["checks"]["postgresql"]>;
  const core = c.nanoclaw || {} as NonNullable<HealthData["checks"]["nanoclaw"]>;
  const ollama = c.ollama || {} as NonNullable<HealthData["checks"]["ollama"]>;
  const nginx = c.nginx || {} as NonNullable<HealthData["checks"]["nginx"]>;
  const sync = c.notionSync || {} as NonNullable<HealthData["checks"]["notionSync"]>;
  const pipelines = c.pipelines || [];

  // Animated dash offset for data flow lines
  const dashOffset = -(tick * 8) % 40;

  function tooltip(id: string): string {
    if (id === "pg") return `PostgreSQL · ${pg.size || "?"} · ${pg.latencyMs || "?"}ms · ${pg.total_tasks || 0} tasks`;
    if (id === "core") return `NanoClaw · ${core.uptime ? formatUptime(core.uptime) : "?"} uptime · ${pipelines.length} pipelines`;
    if (id === "ollama") return `Ollama · ${ollama.modelCount || 0} models · Mac Studio 96GB`;
    if (id === "nginx") return `Nginx · cert ${nginx.certDaysLeft || "?"}d · dashboard.shearer.live`;
    if (id === "notion") return `Notion · ${pg.sync_ok || 0} synced · ${pg.sync_pending || 0} pending`;
    if (id === "dashboard") return `Dashboard · Next.js · PG-native`;
    // Data sources — show pipeline details
    const srcMatch: Record<string, string[]> = { webex: ["webex-messages", "webex-transcripts"], plaud: ["plaud"], gmail: ["gmail"], boox: ["boox"], calendar: ["calendar"] };
    if (srcMatch[id]) {
      const matched = pipelines.filter((p) => srcMatch[id].some((m) => p.id.includes(m)));
      if (matched.length > 0) {
        return matched.map((p) => {
          const name = p.id.replace("mc-", "");
          const lastRun = p.lastRun ? new Date(p.lastRun).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
          return `${name}: ${p.lastStatus || "?"} · last: ${lastRun}`;
        }).join(" | ");
      }
      return `${id} · no pipeline data`;
    }
    return id;
  }

  return (
    <div className="relative">
      <svg viewBox="0 0 960 560" className="w-full" style={{ maxHeight: "560px" }}>
        <defs>
          {/* Animated flow pattern */}
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#58a6ff" opacity="0.6" />
          </marker>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Background */}
        <rect width="960" height="520" fill="transparent" rx="12" />

        {/* ── Data Flow Lines (animated) ────────────── */}
        {/* Pipelines → Core */}
        <path d="M 155 100 Q 250 100 305 200" stroke="#58a6ff" strokeWidth="1.5" fill="none" opacity="0.3" strokeDasharray="6 4" strokeDashoffset={dashOffset} />
        <path d="M 155 180 Q 250 180 305 220" stroke="#58a6ff" strokeWidth="1.5" fill="none" opacity="0.3" strokeDasharray="6 4" strokeDashoffset={dashOffset} />
        <path d="M 155 260 Q 250 260 305 240" stroke="#58a6ff" strokeWidth="1.5" fill="none" opacity="0.3" strokeDasharray="6 4" strokeDashoffset={dashOffset} />
        <path d="M 155 340 Q 250 340 305 260" stroke="#58a6ff" strokeWidth="1.5" fill="none" opacity="0.3" strokeDasharray="6 4" strokeDashoffset={dashOffset} />
        <path d="M 155 420 Q 250 400 305 270" stroke="#58a6ff" strokeWidth="1.5" fill="none" opacity="0.3" strokeDasharray="6 4" strokeDashoffset={dashOffset} />

        {/* Core → PostgreSQL */}
        <path d="M 415 240 L 510 240" stroke="#3fb950" strokeWidth="2" fill="none" opacity="0.5" strokeDasharray="6 4" strokeDashoffset={dashOffset} markerEnd="url(#arrowhead)" />

        {/* Core → DC Ollama :9001 → Ollama */}
        <path d="M 360 290 L 360 340" stroke="#d29922" strokeWidth="1.5" fill="none" opacity="0.4" strokeDasharray="6 4" strokeDashoffset={dashOffset} markerEnd="url(#arrowhead)" />
        <path d="M 360 365 L 360 400" stroke="#bc8cff" strokeWidth="1.5" fill="none" opacity="0.3" strokeDasharray="6 4" strokeDashoffset={dashOffset} markerEnd="url(#arrowhead)" />

        {/* Core → DC Anthropic :9002 → Anthropic API */}
        <path d="M 360 195 L 360 160" stroke="#d29922" strokeWidth="1.5" fill="none" opacity="0.4" strokeDasharray="6 4" strokeDashoffset={dashOffset} markerEnd="url(#arrowhead)" />
        <path d="M 360 135 L 360 110" stroke="#bc8cff" strokeWidth="1.5" fill="none" opacity="0.3" strokeDasharray="6 4" strokeDashoffset={dashOffset} markerEnd="url(#arrowhead)" />

        {/* PostgreSQL → Dashboard */}
        <path d="M 620 220 L 710 180" stroke="#3fb950" strokeWidth="2" fill="none" opacity="0.5" strokeDasharray="6 4" strokeDashoffset={dashOffset} markerEnd="url(#arrowhead)" />

        {/* PostgreSQL → Notion Sync */}
        <path d="M 620 260 L 710 320" stroke="#d29922" strokeWidth="1.5" fill="none" opacity="0.3" strokeDasharray="6 4" strokeDashoffset={dashOffset} markerEnd="url(#arrowhead)" />

        {/* Dashboard → Nginx */}
        <path d="M 810 160 L 880 120" stroke="#58a6ff" strokeWidth="1.5" fill="none" opacity="0.3" strokeDasharray="6 4" strokeDashoffset={dashOffset} />

        {/* pgvector inside PG */}
        <path d="M 565 280 L 565 340" stroke="#bc8cff" strokeWidth="1" fill="none" opacity="0.3" />

        {/* ── Data Source Nodes (left) ────────────── */}
        {[
          { id: "webex", y: 80, label: "Webex", sub: "Messages · Transcripts · Summaries", icon: "W", pipelineMatch: ["webex-messages", "webex-transcripts"] },
          { id: "plaud", y: 160, label: "Plaud", sub: "Recordings · NotePin", icon: "P", pipelineMatch: ["plaud"] },
          { id: "gmail", y: 240, label: "Gmail", sub: "Emails · OAuth · Local", icon: "G", pipelineMatch: ["gmail"] },
          { id: "boox", y: 320, label: "Boox", sub: "Handwritten Notes · OCR", icon: "B", pipelineMatch: ["boox"] },
          { id: "calendar", y: 400, label: "Calendar", sub: "Google Calendar · Local", icon: "C", pipelineMatch: ["calendar"] },
        ].map((src) => {
          const matchedPipelines = pipelines.filter((p) => src.pipelineMatch.some((m) => p.id.includes(m)));
          const hasError = matchedPipelines.some((p) => p.lastStatus === "error");
          const hasSuccess = matchedPipelines.some((p) => p.lastStatus === "success");
          const color = hasError ? "#f85149" : hasSuccess ? "#3fb950" : "#8b949e";
          const pipelineCount = matchedPipelines.length;
          return (
            <g key={src.id} onMouseEnter={() => setHovered(src.id)} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
              <rect x="30" y={src.y - 20} width="125" height="44" rx="8" fill={hovered === src.id ? "rgba(88,166,255,0.12)" : "rgba(88,166,255,0.06)"} stroke={color} strokeWidth="1.5" />
              <circle cx="48" cy={src.y} r="10" fill={color} opacity="0.2" />
              <text x="48" y={src.y + 4} textAnchor="middle" fill={color} fontSize="10" fontWeight="bold">{src.icon}</text>
              <text x="65" y={src.y - 3} fill="#e6edf3" fontSize="11" fontWeight="600">{src.label}</text>
              {pipelineCount > 1 && <text x="148" y={src.y - 3} fill="#8b949e" fontSize="8">{pipelineCount}x</text>}
              <text x="65" y={src.y + 11} fill="#8b949e" fontSize="8">{src.sub}</text>
            </g>
          );
        })}

        {/* ── NanoClaw Core (center-left) ────────────── */}
        <g onMouseEnter={() => setHovered("core")} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
          <rect x="290" y="195" width="130" height="90" rx="12" fill={hovered === "core" ? "rgba(63,185,80,0.15)" : "rgba(63,185,80,0.08)"} stroke={statusColor(core.status)} strokeWidth="2" />
          <text x="355" y="225" textAnchor="middle" fill="#e6edf3" fontSize="13" fontWeight="700">NanoClaw</text>
          <text x="355" y="243" textAnchor="middle" fill="#8b949e" fontSize="9">Orchestrator</text>
          <text x="355" y="258" textAnchor="middle" fill={statusColor(core.status)} fontSize="9">{core.uptime ? formatUptime(core.uptime) + " uptime" : "..."}</text>
          <text x="355" y="273" textAnchor="middle" fill="#8b949e" fontSize="8">{core.containers?.active || 0} containers · {pipelines.length} pipelines</text>
        </g>

        {/* ── DefenseClaw Anthropic (between Core and Anthropic API) ──── */}
        <g>
          <rect x="300" y="135" width="110" height="25" rx="6" fill="rgba(210,153,34,0.08)" stroke="#d29922" strokeWidth="1" />
          <text x="355" y="151" textAnchor="middle" fill="#d29922" fontSize="8" fontWeight="600">DefenseClaw :9002</text>
        </g>

        {/* ── Anthropic API (top center) ────────────── */}
        <g onMouseEnter={() => setHovered("anthropic")} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
          <rect x="305" y="70" width="100" height="40" rx="8" fill="rgba(188,140,255,0.08)" stroke="#bc8cff" strokeWidth="1" strokeDasharray="4 2" />
          <text x="355" y="90" textAnchor="middle" fill="#bc8cff" fontSize="10" fontWeight="600">Anthropic API</text>
          <text x="355" y="103" textAnchor="middle" fill="#8b949e" fontSize="8">Sonnet · Opus</text>
        </g>

        {/* ── DefenseClaw Ollama (between Core and Ollama) ──────────── */}
        <g>
          <rect x="300" y="340" width="110" height="25" rx="6" fill="rgba(210,153,34,0.08)" stroke="#d29922" strokeWidth="1" />
          <text x="355" y="356" textAnchor="middle" fill="#d29922" fontSize="8" fontWeight="600">DefenseClaw :9001</text>
        </g>

        {/* ── Ollama / Mac Studio (bottom center) ────────────── */}
        <g onMouseEnter={() => setHovered("ollama")} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
          <rect x="290" y="400" width="130" height="50" rx="8" fill={hovered === "ollama" ? "rgba(188,140,255,0.12)" : "rgba(188,140,255,0.06)"} stroke={statusColor(ollama.status)} strokeWidth="1.5" />
          <text x="355" y="420" textAnchor="middle" fill="#e6edf3" fontSize="11" fontWeight="600">Ollama</text>
          <text x="355" y="434" textAnchor="middle" fill="#8b949e" fontSize="8">Mac Studio · 96GB</text>
          <text x="355" y="446" textAnchor="middle" fill={statusColor(ollama.status)} fontSize="8">{ollama.modelCount || 0} models loaded</text>
        </g>

        {/* ── PostgreSQL (center) ────────────── */}
        <g onMouseEnter={() => setHovered("pg")} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
          <rect x="500" y="190" width="130" height="100" rx="12" fill={hovered === "pg" ? "rgba(63,185,80,0.15)" : "rgba(63,185,80,0.08)"} stroke={statusColor(pg.status)} strokeWidth="2" filter={pg.status === "healthy" ? "url(#glow)" : undefined} />
          <text x="565" y="218" textAnchor="middle" fill="#e6edf3" fontSize="14" fontWeight="700">PostgreSQL</text>
          <text x="565" y="235" textAnchor="middle" fill={statusColor(pg.status)} fontSize="9">{pg.size || "?"} · {pg.latencyMs || "?"}ms</text>
          <text x="565" y="252" textAnchor="middle" fill="#58a6ff" fontSize="9">{pg.total_tasks || 0} tasks · {pg.people || 0} people</text>
          <text x="565" y="267" textAnchor="middle" fill="#8b949e" fontSize="8">{pg.vectors || 0} vectors · {pg.archive || 0} archive</text>
          <text x="565" y="282" textAnchor="middle" fill="#e6edf3" fontSize="8" fontWeight="600">System of Record</text>
        </g>

        {/* pgvector sub-node */}
        <g>
          <rect x="525" y="340" width="80" height="30" rx="6" fill="rgba(188,140,255,0.06)" stroke="#bc8cff" strokeWidth="1" />
          <text x="565" y="359" textAnchor="middle" fill="#bc8cff" fontSize="9">pgvector</text>
        </g>

        {/* ── Dashboard (right-top) ────────────── */}
        <g onMouseEnter={() => setHovered("dashboard")} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
          <rect x="700" y="140" width="120" height="55" rx="8" fill={hovered === "dashboard" ? "rgba(88,166,255,0.12)" : "rgba(88,166,255,0.06)"} stroke="#58a6ff" strokeWidth="1.5" />
          <text x="760" y="163" textAnchor="middle" fill="#e6edf3" fontSize="11" fontWeight="600">Dashboard</text>
          <text x="760" y="177" textAnchor="middle" fill="#8b949e" fontSize="8">Next.js · PG-native</text>
          <text x="760" y="189" textAnchor="middle" fill="#58a6ff" fontSize="8">Mission Control</text>
        </g>

        {/* ── Nginx (far right) ────────────── */}
        <g onMouseEnter={() => setHovered("nginx")} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
          <rect x="850" y="85" width="90" height="50" rx="8" fill="rgba(88,166,255,0.06)" stroke={statusColor(nginx.certStatus || nginx.status)} strokeWidth="1" />
          <text x="895" y="106" textAnchor="middle" fill="#e6edf3" fontSize="10" fontWeight="600">Nginx</text>
          <text x="895" y="119" textAnchor="middle" fill={statusColor(nginx.certStatus || nginx.status)} fontSize="8">
            {nginx.certDaysLeft ? `cert ${nginx.certDaysLeft}d` : "TLS"}
          </text>
          <text x="895" y="130" textAnchor="middle" fill="#8b949e" fontSize="7">Let's Encrypt</text>
        </g>

        {/* ── Notion (right-bottom) ────────────── */}
        <g onMouseEnter={() => setHovered("notion")} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
          <rect x="700" y="300" width="120" height="55" rx="8" fill="rgba(210,153,34,0.06)" stroke="#d29922" strokeWidth="1" strokeDasharray="4 2" />
          <text x="760" y="323" textAnchor="middle" fill="#e6edf3" fontSize="11" fontWeight="600">Notion</text>
          <text x="760" y="337" textAnchor="middle" fill="#d29922" fontSize="8">Sync Target (async)</text>
          <text x="760" y="349" textAnchor="middle" fill="#8b949e" fontSize="8">{pg.sync_ok || 0} synced · {pg.sync_pending || 0} pending</text>
        </g>

        {/* ── Access Flow: Browser → Nginx → Dashboard ────────────── */}
        <g>
          <rect x="850" y="155" width="90" height="35" rx="6" fill="rgba(88,166,255,0.06)" stroke="#58a6ff" strokeWidth="1" />
          <text x="895" y="172" textAnchor="middle" fill="#58a6ff" fontSize="9" fontWeight="600">Browser</text>
          <text x="895" y="183" textAnchor="middle" fill="#8b949e" fontSize="7">LAN only</text>
        </g>
        {/* Browser → Nginx */}
        <path d="M 895 155 L 895 135" stroke="#58a6ff" strokeWidth="1.5" fill="none" opacity="0.4" strokeDasharray="4 3" strokeDashoffset={dashOffset} markerEnd="url(#arrowhead)" />
        {/* Nginx → Dashboard */}
        <path d="M 850 110 L 820 165" stroke="#58a6ff" strokeWidth="1.5" fill="none" opacity="0.4" strokeDasharray="4 3" strokeDashoffset={dashOffset} markerEnd="url(#arrowhead)" />

        {/* ── OneCLI (bottom right) ────────────── */}
        <g>
          <rect x="700" y="400" width="100" height="35" rx="6" fill="rgba(139,148,158,0.06)" stroke="#8b949e" strokeWidth="1" />
          <text x="750" y="418" textAnchor="middle" fill="#8b949e" fontSize="9">OneCLI Proxy</text>
          <text x="750" y="430" textAnchor="middle" fill="#8b949e" fontSize="7">Secrets · :10255</text>
        </g>

        {/* ── WhatsApp (bottom left) ────────────── */}
        <g>
          <rect x="30" y="465" width="100" height="35" rx="6" fill="rgba(63,185,80,0.06)" stroke="#3fb950" strokeWidth="1" />
          <text x="80" y="483" textAnchor="middle" fill="#3fb950" fontSize="9">WhatsApp</text>
          <text x="80" y="495" textAnchor="middle" fill="#8b949e" fontSize="7">Baileys · Chat</text>
        </g>
        <path d="M 130 482 Q 220 470 290 280" stroke="#3fb950" strokeWidth="1" fill="none" opacity="0.2" strokeDasharray="4 3" />

        {/* ── Labels ────────────── */}
        <text x="92" y="55" textAnchor="middle" fill="#8b949e" fontSize="9" fontWeight="600" letterSpacing="1">DATA SOURCES</text>
        <text x="355" y="55" textAnchor="middle" fill="#8b949e" fontSize="9" fontWeight="600" letterSpacing="1">PROCESSING</text>
        <text x="565" y="175" textAnchor="middle" fill="#8b949e" fontSize="9" fontWeight="600" letterSpacing="1">STORAGE</text>
        <text x="810" y="75" textAnchor="middle" fill="#8b949e" fontSize="9" fontWeight="600" letterSpacing="1">ACCESS</text>
      </svg>

      {/* Tooltip */}
      {hovered && (
        <div className="absolute top-2 right-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text)] shadow-lg">
          {tooltip(hovered)}
        </div>
      )}
    </div>
  );
}
