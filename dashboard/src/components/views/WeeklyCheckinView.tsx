"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader } from "@/components/Card";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
interface PriorityArea {
  label: string;
  items: string[];
  tasksDone: number;
  tasksOpen: number;
}

interface CheckinData {
  weekOf: string;
  reflectWeek: { start: string; end: string };
  planWeek: { start: string; end: string };
  manager: string;
  drafts: {
    strengths: { suggested: number; reasoning: string };
    outstandingValue: { suggested: number; reasoning: string };
    managerConnect: { suggested: boolean; reasoning: string };
    loved: string;
    loathed: string;
    priorities: Record<string, PriorityArea>;
    managerHelp: string;
  };
  rawData: {
    completedTasks: any[];
    meetings: any[];
    topPeople: any[];
    openTasks: any[];
    triageStats: any;
  };
}

const STEPS = [
  "Reflect on last week",
  "Loved & Loathed",
  "Priorities Review",
  "Plan for this week",
];

const LIKERT_OPTIONS = [
  { value: 1, label: "Strongly Disagree" },
  { value: 2, label: "Disagree" },
  { value: 3, label: "Neutral" },
  { value: 4, label: "Agree" },
  { value: 5, label: "Strongly Agree" },
];

/* ------------------------------------------------------------------ */
/*  Copy helper                                                        */
/* ------------------------------------------------------------------ */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

/* ------------------------------------------------------------------ */
/*  CopyButton                                                         */
/* ------------------------------------------------------------------ */
function CopyButton({
  getText,
  label,
  className,
}: {
  getText: () => string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await copyToClipboard(getText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [getText]);

  return (
    <button
      onClick={handleCopy}
      className={`text-xs px-2 py-1 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:border-[var(--accent)] transition-colors cursor-pointer ${className || ""}`}
    >
      {copied ? "Copied!" : label || "Copy"}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  RegenerateButton                                                   */
/* ------------------------------------------------------------------ */
function RegenerateButton({
  field,
  onResult,
}: {
  field: string;
  onResult: (draft: string) => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleRegenerate = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/weekly-checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field }),
      });
      if (resp.ok) {
        const data = await resp.json();
        onResult(data.draft || "");
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [field, onResult]);

  return (
    <button
      onClick={handleRegenerate}
      disabled={loading}
      className="text-xs px-2 py-1 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {loading ? "Generating..." : "Regenerate"}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  EditableTextarea — with char counter, copy, regenerate             */
/* ------------------------------------------------------------------ */
function EditableTextarea({
  value,
  onChange,
  field,
  maxChars = 2000,
  rows = 6,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  field: string;
  maxChars?: number;
  rows?: number;
  placeholder?: string;
}) {
  const charCount = value.length;
  const overLimit = charCount > maxChars;

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full bg-[var(--surface2)] border border-[var(--border)] rounded-md px-3 py-2.5 text-sm text-[var(--text)] resize-y focus:outline-none focus:border-[var(--accent)] transition-colors placeholder:text-[var(--text-dim)]"
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CopyButton getText={() => value} />
          <RegenerateButton field={field} onResult={onChange} />
        </div>
        <span
          className={`text-xs ${overLimit ? "text-[var(--red)]" : "text-[var(--text-dim)]"}`}
        >
          {charCount}/{maxChars}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  LikertScale — radio group                                          */
/* ------------------------------------------------------------------ */
function LikertScale({
  value,
  onChange,
  aiSuggested,
  aiReasoning,
}: {
  value: number | null;
  onChange: (v: number) => void;
  aiSuggested?: number;
  aiReasoning?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {LIKERT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex-1 py-2 px-1 text-xs rounded border transition-all cursor-pointer ${
              value === opt.value
                ? "bg-[var(--accent)] border-[var(--accent)] text-white font-medium"
                : "bg-[var(--surface2)] border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--text)]"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {aiSuggested && aiReasoning && (
        <p className="text-xs text-[var(--text-dim)] italic pl-1">
          AI suggests: <span className="text-[var(--accent)]">{LIKERT_OPTIONS.find((o) => o.value === aiSuggested)?.label}</span>
          {" -- "}
          {aiReasoning}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  YesNoToggle                                                        */
/* ------------------------------------------------------------------ */
function YesNoToggle({
  value,
  onChange,
  aiSuggested,
  aiReasoning,
}: {
  value: boolean | null;
  onChange: (v: boolean) => void;
  aiSuggested?: boolean;
  aiReasoning?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {[
          { val: true, label: "Yes" },
          { val: false, label: "No" },
        ].map((opt) => (
          <button
            key={String(opt.val)}
            onClick={() => onChange(opt.val)}
            className={`px-6 py-2 text-sm rounded border transition-all cursor-pointer ${
              value === opt.val
                ? "bg-[var(--accent)] border-[var(--accent)] text-white font-medium"
                : "bg-[var(--surface2)] border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--text)]"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {aiReasoning && (
        <p className="text-xs text-[var(--text-dim)] italic pl-1">
          AI suggests: <span className="text-[var(--accent)]">{aiSuggested ? "Yes" : "No"}</span>
          {" -- "}
          {aiReasoning}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  StepIndicator                                                      */
/* ------------------------------------------------------------------ */
function StepIndicator({
  current,
  total,
  labels,
  onStep,
}: {
  current: number;
  total: number;
  labels: string[];
  onStep: (s: number) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-3">
      {Array.from({ length: total }, (_, i) => (
        <button
          key={i}
          onClick={() => onStep(i)}
          className="flex items-center gap-2 cursor-pointer group"
          title={labels[i]}
        >
          <div
            className={`w-3 h-3 rounded-full transition-all ${
              i === current
                ? "bg-[var(--accent)] ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--surface)]"
                : i < current
                  ? "bg-[var(--green)]"
                  : "bg-[var(--surface2)] border border-[var(--border)]"
            }`}
          />
          <span
            className={`text-xs hidden sm:inline transition-colors ${
              i === current
                ? "text-[var(--text-bright)] font-medium"
                : "text-[var(--text-dim)] group-hover:text-[var(--text)]"
            }`}
          >
            {labels[i]}
          </span>
          {i < total - 1 && (
            <div
              className={`w-8 h-px ${
                i < current ? "bg-[var(--green)]" : "bg-[var(--border)]"
              }`}
            />
          )}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Collapsible                                                        */
/* ------------------------------------------------------------------ */
function Collapsible({
  title,
  defaultOpen,
  children,
  right,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <div className="border-b border-[var(--border)] last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-[rgba(88,166,255,0.03)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span
            className="text-xs text-[var(--text-dim)] transition-transform"
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            {"\u25B6"}
          </span>
          <span className="text-sm font-medium text-[var(--text-bright)]">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {right}
        </div>
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Format all fields as text for "Copy All"                           */
/* ------------------------------------------------------------------ */
function formatAllText(
  data: CheckinData,
  state: {
    strengths: number | null;
    outstandingValue: number | null;
    managerConnect: boolean | null;
    loved: string;
    loathed: string;
    managerHelp: string;
  },
): string {
  const lines: string[] = [];

  lines.push(`WEEKLY CHECK-IN -- ${data.reflectWeek.start} - ${data.reflectWeek.end}`);
  lines.push("");

  // Step 1 — Reflect
  lines.push("REFLECT ON LAST WEEK");
  const sLabel = state.strengths ? LIKERT_OPTIONS.find((o) => o.value === state.strengths)?.label : "(not rated)";
  lines.push(`  Strengths every day: ${sLabel}`);
  const vLabel = state.outstandingValue ? LIKERT_OPTIONS.find((o) => o.value === state.outstandingValue)?.label : "(not rated)";
  lines.push(`  Outstanding value: ${vLabel}`);
  lines.push(`  Manager connected: ${state.managerConnect === null ? "(not answered)" : state.managerConnect ? "Yes" : "No"}`);
  lines.push("");

  // Step 2 — Loved / Loathed
  lines.push("WHAT I LOVED");
  lines.push(state.loved || "(none)");
  lines.push("");
  lines.push("WHAT I LOATHED");
  lines.push(state.loathed || "(none)");
  lines.push("");

  // Step 3 — Priorities
  lines.push("PRIORITIES REVIEW");
  for (const [, area] of Object.entries(data.drafts.priorities || {})) {
    if (area.tasksDone === 0 && area.tasksOpen === 0) continue;
    lines.push(`  ${area.label} (${area.tasksDone} done, ${area.tasksOpen} open)`);
    for (const item of area.items.slice(0, 5)) {
      lines.push(`    - ${item}`);
    }
  }
  lines.push("");

  // Step 4 — Manager help
  lines.push(`HELP NEEDED FROM ${data.manager.toUpperCase()}`);
  lines.push(state.managerHelp || "(none)");

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
export default function WeeklyCheckinView() {
  const [data, setData] = useState<CheckinData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  // Editable state
  const [strengths, setStrengths] = useState<number | null>(null);
  const [outstandingValue, setOutstandingValue] = useState<number | null>(null);
  const [managerConnect, setManagerConnect] = useState<boolean | null>(null);
  const [loved, setLoved] = useState("");
  const [loathed, setLoathed] = useState("");
  const [managerHelp, setManagerHelp] = useState("");
  const [copyAllDone, setCopyAllDone] = useState(false);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/weekly-checkin")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: CheckinData) => {
        setData(d);
        // Pre-fill from AI drafts
        setStrengths(d.drafts.strengths.suggested);
        setOutstandingValue(d.drafts.outstandingValue.suggested);
        setManagerConnect(d.drafts.managerConnect.suggested);
        setLoved(d.drafts.loved);
        setLoathed(d.drafts.loathed);
        setManagerHelp(d.drafts.managerHelp);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Failed to load");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* ---- Loading / Error states ---- */
  if (loading) {
    return (
      <div className="max-w-[800px] mx-auto px-8 py-12">
        <Card>
          <div className="p-8 text-center">
            <div className="inline-block w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-sm text-[var(--text-dim)]">
              Gathering week data and synthesizing drafts...
            </p>
            <p className="text-xs text-[var(--text-dim)] mt-2">
              This may take 15-30 seconds while the local LLM generates your check-in.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-[800px] mx-auto px-8 py-12">
        <Card>
          <div className="p-6 text-center">
            <p className="text-[var(--red)] mb-3">Failed to load check-in data</p>
            <p className="text-sm text-[var(--text-dim)] mb-4">{error}</p>
            <button
              onClick={fetchData}
              className="text-sm px-4 py-2 rounded border border-[var(--border)] text-[var(--text-bright)] hover:border-[var(--accent)] cursor-pointer"
            >
              Retry
            </button>
          </div>
        </Card>
      </div>
    );
  }

  const handleCopyAll = async () => {
    const text = formatAllText(data, {
      strengths,
      outstandingValue,
      managerConnect,
      loved,
      loathed,
      managerHelp,
    });
    await copyToClipboard(text);
    setCopyAllDone(true);
    setTimeout(() => setCopyAllDone(false), 2000);
  };

  const prev = () => setStep((s) => Math.max(0, s - 1));
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));

  /* ================================================================ */
  /*  STEP 1 — Reflect on last week                                    */
  /* ================================================================ */
  const renderStep1 = () => (
    <Card>
      <div className="p-6 space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-base font-semibold text-[var(--text-bright)]">
              Reflect on last week
            </h2>
          </div>
          <p className="text-xs text-[var(--text-dim)]">
            {data.reflectWeek.start} - {data.reflectWeek.end}
          </p>
          <p className="text-xs text-[var(--text-dim)] mt-1">
            Sharing with <span className="text-[var(--accent)] font-medium">{data.manager}</span>
          </p>
        </div>

        {/* Strengths */}
        <div className="space-y-2">
          <label className="text-sm text-[var(--text-bright)] font-medium">
            Last week, I had a chance to use my strengths every day
          </label>
          <LikertScale
            value={strengths}
            onChange={setStrengths}
            aiSuggested={data.drafts.strengths.suggested}
            aiReasoning={data.drafts.strengths.reasoning}
          />
        </div>

        {/* Outstanding value */}
        <div className="space-y-2">
          <label className="text-sm text-[var(--text-bright)] font-medium">
            Last week, I added outstanding value
          </label>
          <LikertScale
            value={outstandingValue}
            onChange={setOutstandingValue}
            aiSuggested={data.drafts.outstandingValue.suggested}
            aiReasoning={data.drafts.outstandingValue.reasoning}
          />
        </div>

        {/* Manager connect */}
        <div className="space-y-2">
          <label className="text-sm text-[var(--text-bright)] font-medium">
            Last week, did {data.manager} connect with you about your work priorities?
          </label>
          <YesNoToggle
            value={managerConnect}
            onChange={setManagerConnect}
            aiSuggested={data.drafts.managerConnect.suggested}
            aiReasoning={data.drafts.managerConnect.reasoning}
          />
        </div>

        {/* Raw data context */}
        <div className="pt-4 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--text-dim)] mb-2 uppercase tracking-wider font-semibold">
            Week at a glance
          </p>
          <div className="grid grid-cols-4 gap-3">
            <div className="text-center">
              <div className="text-lg font-bold text-[var(--green)]">
                {data.rawData.completedTasks.length}
              </div>
              <div className="text-[10px] text-[var(--text-dim)] uppercase">Tasks done</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-[var(--accent)]">
                {data.rawData.meetings.length}
              </div>
              <div className="text-[10px] text-[var(--text-dim)] uppercase">Meetings</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-[var(--purple)]">
                {data.rawData.topPeople.length}
              </div>
              <div className="text-[10px] text-[var(--text-dim)] uppercase">People</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-[var(--yellow)]">
                {data.rawData.openTasks.length}
              </div>
              <div className="text-[10px] text-[var(--text-dim)] uppercase">Open tasks</div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );

  /* ================================================================ */
  /*  STEP 2 — Loved & Loathed                                        */
  /* ================================================================ */
  const renderStep2 = () => (
    <div className="space-y-6">
      <Card>
        <div className="p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-bright)] mb-1">
              What activities did you love last week?
            </h2>
            <p className="text-xs text-[var(--text-dim)]">
              Think about what made you feel fulfilled, focused, or energized.
            </p>
          </div>
          <EditableTextarea
            value={loved}
            onChange={setLoved}
            field="loved"
            placeholder="- Spending time with...\n- Great session on..."
          />
        </div>
      </Card>

      <Card>
        <div className="p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-bright)] mb-1">
              What activities did you loathe last week?
            </h2>
            <p className="text-xs text-[var(--text-dim)]">
              Think about what felt draining, laborious, or was avoided/postponed.
            </p>
          </div>
          <EditableTextarea
            value={loathed}
            onChange={setLoathed}
            field="loathed"
            placeholder="- Not enough time in the day...\n- Postponed..."
          />
        </div>
      </Card>
    </div>
  );

  /* ================================================================ */
  /*  STEP 3 — Priorities Review                                       */
  /* ================================================================ */
  const renderStep3 = () => {
    const priorityEntries = Object.entries(data.drafts.priorities || {});

    const generatePrioritySummary = () => {
      const lines: string[] = [];
      for (const [, area] of priorityEntries) {
        if (area.tasksDone === 0 && area.tasksOpen === 0) continue;
        lines.push(`${area.label} (${area.tasksDone} done, ${area.tasksOpen} open)`);
        for (const item of area.items.slice(0, 5)) {
          lines.push(`  - ${item}`);
        }
      }
      return lines.join("\n");
    };

    return (
      <Card>
        <CardHeader
          title="Priorities Review"
          right={
            <CopyButton getText={generatePrioritySummary} label="Copy Summary" />
          }
        />
        <div className="px-6 py-3">
          <p className="text-xs text-[var(--text-dim)] mb-3">
            {data.reflectWeek.start} - {data.reflectWeek.end}
          </p>
        </div>
        <div>
          {priorityEntries.map(([key, area]) => (
            <Collapsible
              key={key}
              title={area.label}
              defaultOpen={area.tasksDone > 0 || area.items.length > 0}
              right={
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[var(--text-dim)]">
                    <span className="text-[var(--green)]">{area.tasksDone}</span>
                    {" done / "}
                    <span className="text-[var(--yellow)]">{area.tasksOpen}</span>
                    {" open"}
                  </span>
                  <CopyButton
                    getText={() => {
                      const lines = [`${area.label} (${area.tasksDone} done, ${area.tasksOpen} open)`];
                      for (const item of area.items) lines.push(`  - ${item}`);
                      return lines.join("\n");
                    }}
                  />
                </div>
              }
            >
              {area.items.length === 0 && area.tasksDone === 0 && area.tasksOpen === 0 && (
                <p className="text-xs text-[var(--text-dim)] italic">
                  No activity this week
                </p>
              )}
              {area.items.slice(0, area.tasksDone).map((item, i) => (
                <div key={`done-${i}`} className="flex items-start gap-2 py-1">
                  <span className="text-[var(--green)] shrink-0">{"\u2713"}</span>
                  <span className="text-sm text-[var(--text)]">{item}</span>
                </div>
              ))}
              {area.items.slice(area.tasksDone).map((item, i) => (
                <div key={`open-${i}`} className="flex items-start gap-2 py-1">
                  <span className="text-[var(--yellow)] shrink-0">{"\u25CB"}</span>
                  <span className="text-sm text-[var(--text-dim)]">{item}</span>
                </div>
              ))}
            </Collapsible>
          ))}
        </div>
      </Card>
    );
  };

  /* ================================================================ */
  /*  STEP 4 — Plan for this week                                      */
  /* ================================================================ */
  const renderStep4 = () => (
    <div className="space-y-6">
      <Card>
        <div className="p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-bright)] mb-1">
              Plan for this week
            </h2>
            <p className="text-xs text-[var(--text-dim)]">
              {data.planWeek.start} - {data.planWeek.end}
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-[var(--text-bright)] font-medium">
              What help do you need from {data.manager} this week?
            </label>
            <EditableTextarea
              value={managerHelp}
              onChange={setManagerHelp}
              field="managerHelp"
              placeholder="Would love to connect on..."
              rows={5}
            />
          </div>
        </div>
      </Card>

      {/* Upcoming context — open tasks carry-forward */}
      <Card>
        <CardHeader title="Carry-forward tasks" />
        <div className="divide-y divide-[var(--border)]">
          {data.rawData.openTasks.length === 0 && (
            <div className="px-4 py-4 text-sm text-[var(--text-dim)] italic">
              No open tasks
            </div>
          )}
          {data.rawData.openTasks.slice(0, 10).map((task: any, i: number) => (
            <div key={i} className="flex items-start gap-3 px-4 py-2.5">
              <span
                className={`text-xs px-1.5 py-0.5 rounded font-mono shrink-0 ${
                  task.priority?.includes("P0")
                    ? "bg-[var(--red)] bg-opacity-20 text-[var(--red)]"
                    : task.priority?.includes("P1")
                      ? "bg-[var(--orange)] bg-opacity-20 text-[var(--orange)]"
                      : "bg-[var(--surface2)] text-[var(--text-dim)]"
                }`}
              >
                {task.priority || "P3"}
              </span>
              <span className="text-sm text-[var(--text)]">{task.title}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */
  const stepRenderers = [renderStep1, renderStep2, renderStep3, renderStep4];

  return (
    <div className="max-w-[800px] mx-auto px-8 py-6 space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-bright)]">
            Weekly Check-in
          </h1>
          <p className="text-xs text-[var(--text-dim)] mt-0.5">
            Week of {data.reflectWeek.start} - {data.reflectWeek.end}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyAll}
            className="text-sm px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:border-[var(--accent)] transition-colors cursor-pointer"
          >
            {copyAllDone ? "Copied!" : "Copy All"}
          </button>
          <button
            onClick={fetchData}
            className="text-sm px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:border-[var(--accent)] transition-colors cursor-pointer"
          >
            Regenerate All
          </button>
        </div>
      </div>

      {/* ---- Step indicator ---- */}
      <StepIndicator
        current={step}
        total={STEPS.length}
        labels={STEPS}
        onStep={setStep}
      />

      {/* ---- Current step content ---- */}
      {stepRenderers[step]()}

      {/* ---- Navigation ---- */}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={prev}
          disabled={step === 0}
          className="text-sm px-4 py-2 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:border-[var(--accent)] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <span className="text-xs text-[var(--text-dim)]">
          Step {step + 1} of {STEPS.length}
        </span>
        {step < STEPS.length - 1 ? (
          <button
            onClick={next}
            className="text-sm px-4 py-2 rounded bg-[var(--accent)] text-white border border-[var(--accent)] hover:opacity-90 transition-colors cursor-pointer"
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleCopyAll}
            className="text-sm px-4 py-2 rounded bg-[var(--green)] text-white border border-[var(--green)] hover:opacity-90 transition-colors cursor-pointer"
          >
            {copyAllDone ? "Copied!" : "Copy All & Finish"}
          </button>
        )}
      </div>
    </div>
  );
}
