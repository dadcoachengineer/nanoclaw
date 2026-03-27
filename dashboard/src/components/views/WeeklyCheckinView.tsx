"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader } from "@/components/Card";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */
interface RatingSection {
  score: number | null;
  evidence: string[];
}

interface LovedLoathedItem {
  activity: string;
  signal: string;
  source: string;
}

interface PriorityArea {
  label: string;
  items: string[];
  tasksDone: number;
  tasksOpen: number;
}

interface CheckinData {
  weekOf: string;
  generatedAt: string;
  ratings: {
    strengths: RatingSection;
    outstandingValue: RatingSection;
    managerConnect: RatingSection;
  };
  loved: LovedLoathedItem[];
  loathed: LovedLoathedItem[];
  priorities: Record<string, PriorityArea>;
  managerHelp: string;
}

/* ------------------------------------------------------------------ */
/*  Star Rating                                                       */
/* ------------------------------------------------------------------ */
function StarRating({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const display = hover ?? value ?? 0;

  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(null)}
          onClick={() => onChange(star)}
          className="text-lg cursor-pointer transition-colors focus:outline-none"
          style={{ color: star <= display ? "var(--yellow)" : "var(--text-dim)" }}
          aria-label={`${star} star${star > 1 ? "s" : ""}`}
        >
          {star <= display ? "\u2605" : "\u2606"}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Copy button                                                       */
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
    const text = getText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-HTTPS contexts
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [getText]);

  return (
    <button
      onClick={handleCopy}
      className={`text-xs px-2 py-1 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:border-[var(--accent)] transition-colors cursor-pointer ${className || ""}`}
    >
      {copied ? "Copied" : label || "Copy"}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Collapsible Section                                               */
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
  const [open, setOpen] = useState(defaultOpen ?? true);

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
/*  Plain-text formatters                                              */
/* ------------------------------------------------------------------ */
function formatRatingText(
  label: string,
  evidence: string[],
  score: number | null
): string {
  const stars = score ? `${"*".repeat(score)}/5` : "(not rated)";
  return `${label} ${stars}\n${evidence.map((e) => `  - ${e}`).join("\n")}`;
}

function formatLovedLoathedText(
  items: LovedLoathedItem[],
  sectionTitle: string
): string {
  if (items.length === 0) return `${sectionTitle}\n  (none)`;
  return `${sectionTitle}\n${items
    .map((item) => `  - ${item.activity} -- ${item.signal} [${item.source}]`)
    .join("\n")}`;
}

function formatPriorityText(key: string, area: PriorityArea): string {
  const lines = [`${area.label} (${area.tasksDone} done, ${area.tasksOpen} open)`];
  for (const item of area.items) {
    lines.push(`  [x] ${item}`);
  }
  if (area.tasksOpen > 0) {
    lines.push(`  [ ] ${area.tasksOpen} task${area.tasksOpen > 1 ? "s" : ""} still open`);
  }
  return lines.join("\n");
}

function formatAllText(
  data: CheckinData,
  ratings: Record<string, number | null>
): string {
  const sections: string[] = [];

  sections.push(`WEEKLY CHECK-IN -- Week of ${data.weekOf}`);
  sections.push("");

  sections.push("RATINGS");
  sections.push(
    formatRatingText("Strengths Every Day", data.ratings.strengths.evidence, ratings.strengths ?? null)
  );
  sections.push(
    formatRatingText("Outstanding Value", data.ratings.outstandingValue.evidence, ratings.outstandingValue ?? null)
  );
  sections.push(
    formatRatingText("Manager Connect", data.ratings.managerConnect.evidence, ratings.managerConnect ?? null)
  );
  sections.push("");

  sections.push(formatLovedLoathedText(data.loved, "WHAT I LOVED"));
  sections.push("");
  sections.push(formatLovedLoathedText(data.loathed, "WHAT I LOATHED"));
  sections.push("");

  sections.push("PRIORITIES");
  for (const [key, area] of Object.entries(data.priorities)) {
    sections.push(formatPriorityText(key, area));
  }
  sections.push("");

  sections.push(`HELP NEEDED FROM ALFREDO`);
  sections.push(data.managerHelp);

  return sections.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Source tag                                                         */
/* ------------------------------------------------------------------ */
function SourceTag({ label }: { label: string }) {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface2)] text-[var(--text-dim)] border border-[var(--border)] shrink-0">
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */
export default function WeeklyCheckinView() {
  const [data, setData] = useState<CheckinData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ratings, setRatings] = useState<Record<string, number | null>>({
    strengths: null,
    outstandingValue: null,
    managerConnect: null,
  });

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

  if (loading) {
    return (
      <div className="max-w-[800px] mx-auto px-8 py-12 text-center text-[var(--text-dim)]">
        Loading weekly check-in...
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

  const generatedTime = new Date(data.generatedAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="max-w-[800px] mx-auto px-8 py-6 space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-bright)]">
            Weekly Check-in &mdash; Week of {data.weekOf}
          </h1>
          <p className="text-xs text-[var(--text-dim)] mt-1">
            Last generated: {generatedTime}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton
            getText={() => formatAllText(data, ratings)}
            label="Copy All"
            className="px-3 py-1.5 text-sm"
          />
          <button
            onClick={fetchData}
            className="text-sm px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text-bright)] hover:border-[var(--accent)] transition-colors cursor-pointer"
          >
            Regenerate
          </button>
        </div>
      </div>

      {/* ---- Ratings ---- */}
      <div className="grid grid-cols-3 gap-4">
        {([
          { key: "strengths", label: "Strengths Every Day", data: data.ratings.strengths },
          { key: "outstandingValue", label: "Outstanding Value", data: data.ratings.outstandingValue },
          { key: "managerConnect", label: "Manager Connect", data: data.ratings.managerConnect },
        ] as const).map(({ key, label, data: section }) => (
          <Card key={key}>
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-[var(--text-bright)] uppercase tracking-wider">
                  {label}
                </h3>
                <CopyButton
                  getText={() =>
                    formatRatingText(label, section.evidence, ratings[key] ?? null)
                  }
                />
              </div>
              <div className="mb-3">
                <StarRating
                  value={ratings[key]}
                  onChange={(v) =>
                    setRatings((prev) => ({ ...prev, [key]: v }))
                  }
                />
              </div>
              <ul className="space-y-1.5">
                {section.evidence.map((e, i) => (
                  <li
                    key={i}
                    className="text-xs text-[var(--text)] flex items-start gap-1.5"
                  >
                    <span className="text-[var(--accent)] shrink-0 mt-0.5">
                      {"\u2022"}
                    </span>
                    <span>{e}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        ))}
      </div>

      {/* ---- What I Loved ---- */}
      <Card>
        <CardHeader
          title="What I Loved"
          right={
            <CopyButton
              getText={() =>
                formatLovedLoathedText(data.loved, "What I Loved")
              }
            />
          }
        />
        <div>
          {data.loved.length === 0 && (
            <div className="px-4 py-4 text-sm text-[var(--text-dim)] italic">
              No high-engagement activities detected this week
            </div>
          )}
          {data.loved.map((item, i) => (
            <div
              key={i}
              className="group/row flex items-start gap-3 px-4 py-3 border-b border-[var(--border)] last:border-0"
            >
              <span className="text-[var(--green)] shrink-0 mt-0.5">
                {"\u2764"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[var(--text-bright)]">
                  {item.activity}
                </div>
                <div className="text-xs text-[var(--text-dim)] mt-0.5">
                  {item.signal}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <SourceTag label={item.source} />
                <CopyButton
                  getText={() =>
                    `${item.activity} -- ${item.signal} [${item.source}]`
                  }
                />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ---- What I Loathed ---- */}
      <Card>
        <CardHeader
          title="What I Loathed"
          right={
            <CopyButton
              getText={() =>
                formatLovedLoathedText(data.loathed, "What I Loathed")
              }
            />
          }
        />
        <div>
          {data.loathed.length === 0 && (
            <div className="px-4 py-4 text-sm text-[var(--text-dim)] italic">
              No low-engagement activities detected this week
            </div>
          )}
          {data.loathed.map((item, i) => (
            <div
              key={i}
              className="group/row flex items-start gap-3 px-4 py-3 border-b border-[var(--border)] last:border-0"
            >
              <span className="text-[var(--red)] shrink-0 mt-0.5">
                {"\u2716"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[var(--text-bright)]">
                  {item.activity}
                </div>
                <div className="text-xs text-[var(--text-dim)] mt-0.5">
                  {item.signal}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <SourceTag label={item.source} />
                <CopyButton
                  getText={() =>
                    `${item.activity} -- ${item.signal} [${item.source}]`
                  }
                />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ---- Priorities Review ---- */}
      <Card>
        <CardHeader
          title="Priorities Review"
          right={
            <CopyButton
              getText={() => {
                const lines = ["PRIORITIES"];
                for (const [key, area] of Object.entries(data.priorities)) {
                  lines.push(formatPriorityText(key, area));
                }
                return lines.join("\n");
              }}
            />
          }
        />
        <div>
          {Object.entries(data.priorities).map(([key, area]) => (
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
                  <CopyButton getText={() => formatPriorityText(key, area)} />
                </div>
              }
            >
              {area.items.length === 0 && area.tasksDone === 0 && area.tasksOpen === 0 && (
                <p className="text-xs text-[var(--text-dim)] italic">
                  No activity this week
                </p>
              )}
              {area.items.map((item, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 py-1"
                >
                  <span className="text-[var(--green)] shrink-0">{"\u2713"}</span>
                  <span className="text-sm text-[var(--text)]">{item}</span>
                </div>
              ))}
              {area.tasksOpen > 0 && (
                <div className="flex items-start gap-2 py-1">
                  <span className="text-[var(--yellow)] shrink-0">{"\u25CF"}</span>
                  <span className="text-sm text-[var(--text-dim)]">
                    {area.tasksOpen} task{area.tasksOpen > 1 ? "s" : ""} still open
                  </span>
                </div>
              )}
            </Collapsible>
          ))}
        </div>
      </Card>

      {/* ---- Help Needed from Alfredo ---- */}
      <Card>
        <CardHeader
          title="Help Needed from Alfredo"
          right={<CopyButton getText={() => data.managerHelp} />}
        />
        <div className="px-4 py-4">
          <p className="text-sm text-[var(--text)]">{data.managerHelp}</p>
        </div>
      </Card>
    </div>
  );
}
