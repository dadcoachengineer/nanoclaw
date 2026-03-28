"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Card, CardHeader, StatCard, GroupHeader } from "@/components/Card";
import TaskItem from "@/components/TaskItem";
import MeetingItem, { findConflicts, findGaps, scheduleInsights, isAllDay } from "@/components/MeetingItem";
import MeetingPrep from "@/components/MeetingPrep";
import TaskDetail from "@/components/TaskDetail";
import { NotionPage, prop, priorityRank, queryNotion } from "@/lib/notion";
import { WebexMeeting, fetchMeetings } from "@/lib/webex";
import { isoDate, timeAgo } from "@/lib/dates";
import { NOTION_DB } from "@/lib/notion";

const PRIORITY_OPTIONS = [
  { label: "P0", value: "P0 \u2014 Today" },
  { label: "P1", value: "P1 \u2014 This Week" },
  { label: "P2", value: "P2 \u2014 This Month" },
  { label: "P3", value: "P3 \u2014 Backlog" },
];

const STATUS_OPTIONS = [
  { label: "Not started", value: "Not started" },
  { label: "In progress", value: "In progress" },
  { label: "Done", value: "Done" },
];

async function bulkUpdateTasks(
  pageIds: string[],
  properties: Record<string, unknown>,
  onProgress: (done: number, total: number) => void,
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    pageIds.map(async (pageId, i) => {
      const resp = await fetch("/api/notion/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_id: pageId, properties }),
      });
      if (resp.ok) {
        succeeded++;
      } else {
        failed++;
      }
      onProgress(succeeded + failed, pageIds.length);
    }),
  );

  return { succeeded, failed };
}

/** Check if a task is a briefing/prep page (not an actionable task) */
function isBriefingPage(page: NotionPage): boolean {
  const title = prop(page, "Task") || prop(page, "Name") || "";
  return /daily briefing|meeting prep|weekly review|transcript summary/i.test(title);
}

/** Extract plain text from Notion rich_text */
function richText(rt: { plain_text: string }[] | undefined): string {
  return (rt || []).map((t) => t.plain_text).join("");
}

interface RunLog {
  task_id: string;
  run_at: string;
  status: string;
  result?: string;
}

export default function TodayView() {
  const [tasks, setTasks] = useState<NotionPage[]>([]);
  const [meetings, setMeetings] = useState<WebexMeeting[]>([]);
  const [runs, setRuns] = useState<RunLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<WebexMeeting | null>(null);
  const [selectedTask, setSelectedTask] = useState<NotionPage | null>(null);
  const [briefingBlocks, setBriefingBlocks] = useState<any[] | null>(null);
  const [briefingUrl, setBriefingUrl] = useState<string | null>(null);

  // Bulk edit state
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [bulkDropdown, setBulkDropdown] = useState<"priority" | "status" | null>(null);
  const bulkDropdownRef = useRef<HTMLDivElement>(null);

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeSourceFilters, setActiveSourceFilters] = useState<Set<string>>(new Set());
  const [activeProjectFilters, setActiveProjectFilters] = useState<Set<string>>(new Set());
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchQuery]);

  // Close bulk dropdown on outside click
  useEffect(() => {
    if (!bulkDropdown) return;
    function handleClick(e: MouseEvent) {
      if (bulkDropdownRef.current && !bulkDropdownRef.current.contains(e.target as Node)) {
        setBulkDropdown(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [bulkDropdown]);

  const toggleSelect = useCallback((page: NotionPage, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(page.id);
      else next.delete(page.id);
      return next;
    });
  }, []);

  const exitBulkMode = useCallback(() => {
    setBulkMode(false);
    setSelectedIds(new Set());
    setBulkProgress(null);
    setBulkDropdown(null);
  }, []);

  const handleBulkAction = useCallback(
    async (properties: Record<string, unknown>, actionLabel: string) => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;
      setBulkDropdown(null);
      setBulkProgress(`Updating 0 of ${ids.length}...`);

      const { succeeded, failed } = await bulkUpdateTasks(ids, properties, (done, total) => {
        setBulkProgress(`Updating ${done} of ${total}...`);
      });

      const isDoneAction = (properties as { Status?: { status?: { name?: string } } }).Status?.status?.name === "Done";

      if (isDoneAction) {
        // Remove completed tasks from the list
        setTasks((prev) => prev.filter((t) => !selectedIds.has(t.id)));
      } else {
        // Update tasks in place to reflect new property values
        setTasks((prev) =>
          prev.map((t) => {
            if (!selectedIds.has(t.id)) return t;
            const updated = { ...t, properties: { ...t.properties } };
            for (const [key, val] of Object.entries(properties)) {
              updated.properties[key] = { ...updated.properties[key], ...(val as Record<string, unknown>) };
            }
            return updated;
          }),
        );
      }

      const msg = failed > 0
        ? `Updated ${succeeded} tasks (${failed} failed)`
        : `Updated ${succeeded} tasks`;
      setBulkProgress(msg);
      setTimeout(() => exitBulkMode(), 1500);
    },
    [selectedIds, exitBulkMode],
  );

  const handleBulkMerge = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length < 2) return;

    const currentTasks = tasks.filter((t) => !isBriefingPage(t));
    const selectedTasks = currentTasks.filter((t) => ids.includes(t.id));
    if (selectedTasks.length < 2) return;

    if (!confirm(`Merge ${selectedTasks.length} tasks into one? The task with the highest priority will be kept.`)) return;

    setBulkDropdown(null);

    // Determine keeper: highest priority, then longest notes as tiebreaker
    const sorted = [...selectedTasks].sort((a, b) => {
      const rankDiff = priorityRank(prop(a, "Priority")) - priorityRank(prop(b, "Priority"));
      if (rankDiff !== 0) return rankDiff;
      return (prop(b, "Notes") || "").length - (prop(a, "Notes") || "").length;
    });
    const keeper = sorted[0];
    const mergeTargets = sorted.slice(1);

    let done = 0;
    const total = mergeTargets.length;
    setBulkProgress(`Merging 0 of ${total}...`);

    // Build the text to append to the keeper's notes
    const mergeLines = mergeTargets.map((t) => {
      const title = prop(t, "Task") || prop(t, "Name") || "Untitled";
      const source = prop(t, "Source") || "unknown";
      return `[Merged] "${title}" (Source: ${source})`;
    }).join("\n\n");

    // Update keeper notes via appendNote
    try {
      await fetch("/api/notion/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page_id: keeper.id,
          properties: {},
          appendNote: mergeLines,
        }),
      });
    } catch {
      // continue even if note append fails
    }

    // Mark non-keepers as Done
    let failed = 0;
    for (const target of mergeTargets) {
      try {
        const resp = await fetch("/api/notion/update", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            page_id: target.id,
            properties: { Status: { status: { name: "Done" } } },
          }),
        });
        if (!resp.ok) failed++;
      } catch {
        failed++;
      }
      done++;
      setBulkProgress(`Merging ${done} of ${total}...`);
    }

    // Remove merged tasks from the list, keep the survivor
    const mergedIds = new Set(mergeTargets.map((t) => t.id));
    setTasks((prev) => prev.filter((t) => !mergedIds.has(t.id)));

    const msg = failed > 0
      ? `Merged ${done - failed} tasks (${failed} failed)`
      : `Merged ${done} tasks into keeper`;
    setBulkProgress(msg);
    setTimeout(() => exitBulkMode(), 1500);
  }, [selectedIds, tasks, exitBulkMode]);

  useEffect(() => {
    async function load() {
      // Use local midnight boundaries (not UTC) so the calendar matches the user's day
      const now = new Date();
      const localStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const localEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

      // Fetch today's briefing page
      const todayStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      fetch("/api/notion/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          database_id: NOTION_DB,
          filter: { and: [
            { property: "Task", title: { contains: "Daily Briefing" } },
            { property: "Task", title: { contains: todayStr.split(",")[0] } },
          ]},
          page_size: 1,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          const page = data.results?.[0];
          if (page) {
            setBriefingUrl(page.url);
            return fetch(`/api/notion/blocks?page_id=${page.id}`).then((r) => r.json());
          }
          return null;
        })
        .then((data) => { if (data?.blocks) setBriefingBlocks(data.blocks); })
        .catch(() => {});

      // Fetch independently so one failure doesn't block the others
      const [taskResult, mtgResult, runResult] = await Promise.allSettled([
        queryNotion({
          and: [
            { property: "Status", status: { does_not_equal: "Done" } },
            {
              or: [
                { property: "Priority", select: { equals: "P0 \u2014 Today" } },
                { property: "Priority", select: { equals: "P1 \u2014 This Week" } },
                { property: "Priority", select: { equals: "P2 \u2014 This Month" } },
              ],
            },
          ],
        }),
        fetchMeetings(localStart.toISOString(), localEnd.toISOString()),
        fetch(`/api/system?path=${encodeURIComponent("/api/runs/recent?limit=10")}`).then((r) =>
          r.json()
        ),
      ]);

      const errors: string[] = [];
      if (taskResult.status === "fulfilled") {
        setTasks(taskResult.value.sort((a: NotionPage, b: NotionPage) => priorityRank(prop(a, "Priority")) - priorityRank(prop(b, "Priority"))));
      } else {
        errors.push(`Tasks: ${taskResult.reason}`);
      }
      if (mtgResult.status === "fulfilled") {
        setMeetings(mtgResult.value.sort((a: WebexMeeting, b: WebexMeeting) => a.start.localeCompare(b.start)));
      } else {
        errors.push(`Calendar: ${mtgResult.reason}`);
      }
      if (runResult.status === "fulfilled") {
        setRuns(runResult.value);
      } else {
        errors.push(`Runs: ${runResult.reason}`);
      }
      if (errors.length > 0) setError(errors.join(" | "));
      setLoading(false);
    }
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  // Filter out briefing/prep pages from actionable tasks
  const actionableTasks = tasks.filter((t) => !isBriefingPage(t));

  // Extract unique sources and projects for filter pills
  const uniqueSources = Array.from(new Set(actionableTasks.map((t) => prop(t, "Source")).filter(Boolean))).sort();
  const uniqueProjects = Array.from(new Set(actionableTasks.map((t) => prop(t, "Project")).filter(Boolean))).sort();

  // Apply search + source + project filters
  const filteredTasks = actionableTasks.filter((t) => {
    // Text search
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      const title = (prop(t, "Task") || prop(t, "Name") || "").toLowerCase();
      const notes = (prop(t, "Notes") || "").toLowerCase();
      const source = (prop(t, "Source") || "").toLowerCase();
      const project = (prop(t, "Project") || "").toLowerCase();
      if (!title.includes(q) && !notes.includes(q) && !source.includes(q) && !project.includes(q)) {
        return false;
      }
    }
    // Source filter
    if (activeSourceFilters.size > 0) {
      const source = prop(t, "Source") || "";
      if (!activeSourceFilters.has(source)) return false;
    }
    // Project filter
    if (activeProjectFilters.size > 0) {
      const project = prop(t, "Project") || "";
      if (!activeProjectFilters.has(project)) return false;
    }
    return true;
  });

  // Unfiltered counts for the briefing header
  const allP0 = actionableTasks.filter((t) => prop(t, "Priority").includes("P0"));
  const allP1 = actionableTasks.filter((t) => prop(t, "Priority").includes("P1"));

  // Filtered groups for the task list
  const p0 = filteredTasks.filter((t) => prop(t, "Priority").includes("P0"));
  const p1 = filteredTasks.filter((t) => prop(t, "Priority").includes("P1"));
  const p2 = filteredTasks.filter((t) => prop(t, "Priority").includes("P2"));
  const activeMeetings = meetings.filter((m) => m.state !== "missed");

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-6">
      {error && (
        <div className="mb-4 p-3 bg-[rgba(248,81,73,0.1)] border border-[var(--red)] rounded-lg text-sm text-[var(--red)]">
          {error}
        </div>
      )}
      {/* Daily Briefing */}
      <Card>
        <div className="px-5 py-4">
          {/* Compact stat bar */}
          <div className="flex items-center gap-6 mb-3">
            <span className="text-sm font-semibold text-[var(--text-bright)]">Daily Briefing</span>
            <div className="flex items-center gap-4 text-xs">
              <span><span className="font-bold text-[var(--red)]">{allP0.length}</span> <span className="text-[var(--text-dim)]">P0</span></span>
              <span><span className="font-bold text-[var(--orange)]">{allP1.length}</span> <span className="text-[var(--text-dim)]">P1</span></span>
              <span><span className="font-bold text-[var(--accent)]">{activeMeetings.length}</span> <span className="text-[var(--text-dim)]">meetings</span></span>
              <span><span className="font-bold text-[var(--text-dim)]">{actionableTasks.length}</span> <span className="text-[var(--text-dim)]">open</span></span>
            </div>
            {briefingUrl && (
              <a href={briefingUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-[var(--accent)] hover:underline ml-auto">
                Open in Notion ↗
              </a>
            )}
          </div>

          {/* Briefing content */}
          {briefingBlocks && briefingBlocks.length > 0 ? (
            <div className="max-h-[180px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden bg-[var(--bg)] rounded-lg px-4 py-3 space-y-1">
              {briefingBlocks.map((block, i) => {
                const type = block.type;
                if (type === "heading_1") return <div key={i} className="text-xs font-bold text-[var(--text-bright)] mt-2">{richText(block.heading_1?.rich_text)}</div>;
                if (type === "heading_2") return <div key={i} className="text-xs font-bold text-[var(--text)] mt-1.5">{richText(block.heading_2?.rich_text)}</div>;
                if (type === "heading_3") return <div key={i} className="text-xs font-semibold text-[var(--text)] mt-1">{richText(block.heading_3?.rich_text)}</div>;
                if (type === "callout") return (
                  <div key={i} className="text-xs bg-[rgba(88,166,255,0.06)] rounded px-2 py-1.5 my-1">
                    <span>{block.callout?.icon?.emoji || "💡"} </span>
                    <span className="text-[var(--text)]">{richText(block.callout?.rich_text)}</span>
                  </div>
                );
                if (type === "to_do") {
                  const checked = block.to_do?.checked;
                  return (
                    <div key={i} className="flex items-start gap-1.5 text-xs">
                      <span className={checked ? "text-[var(--green)]" : "text-[var(--text-dim)]"}>{checked ? "☑" : "☐"}</span>
                      <span className={checked ? "text-[var(--text-dim)] line-through" : "text-[var(--text)]"}>{richText(block.to_do?.rich_text)}</span>
                    </div>
                  );
                }
                if (type === "bulleted_list_item") return (
                  <div key={i} className="flex gap-1.5 text-xs text-[var(--text)]">
                    <span className="text-[var(--text-dim)]">•</span>
                    <span>{richText(block.bulleted_list_item?.rich_text)}</span>
                  </div>
                );
                if (type === "paragraph") {
                  const text = richText(block.paragraph?.rich_text);
                  if (!text) return null;
                  return <p key={i} className="text-xs text-[var(--text)]">{text}</p>;
                }
                if (type === "divider") return <hr key={i} className="border-[var(--border)] my-1" />;
                return null;
              })}
            </div>
          ) : !loading ? (
            <div className="text-xs text-[var(--text-dim)] italic py-2">
              No briefing available yet — the morning agent runs at 7:03 AM
            </div>
          ) : null}
        </div>
      </Card>

      <div className="h-4" />

      {/* Two columns */}
      <div className="grid grid-cols-[1fr_380px] gap-6">
        {/* Left: Tasks */}
        <div>
          <Card>
            <CardHeader
              title="Action Items"
              right={
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--accent)] bg-[rgba(88,166,255,0.08)] px-2 py-0.5 rounded-full">
                    {actionableTasks.length} open
                  </span>
                  {!bulkMode ? (
                    <button
                      onClick={() => setBulkMode(true)}
                      className="text-xs text-[var(--text-dim)] hover:text-[var(--text)] px-2 py-0.5 rounded hover:bg-[rgba(88,166,255,0.06)] transition-colors"
                    >
                      Edit
                    </button>
                  ) : (
                    <button
                      onClick={exitBulkMode}
                      className="text-xs text-[var(--text-dim)] hover:text-[var(--text)] px-2 py-0.5 rounded hover:bg-[rgba(88,166,255,0.06)] transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              }
            />
            {/* Search and filter bar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] flex-wrap">
              <input
                type="text"
                placeholder="Search tasks..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 px-2.5 text-xs bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)] min-w-[140px] max-w-[200px]"
              />
              {uniqueSources.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {uniqueSources.map((src) => (
                    <button
                      key={src}
                      onClick={() => {
                        setActiveSourceFilters((prev) => {
                          const next = new Set(prev);
                          if (next.has(src)) next.delete(src);
                          else next.add(src);
                          return next;
                        });
                      }}
                      className={`px-2 py-0.5 rounded-full text-[11px] transition-colors ${
                        activeSourceFilters.has(src)
                          ? "bg-[rgba(88,166,255,0.15)] text-[var(--accent)] font-medium"
                          : "bg-[var(--bg)] text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[rgba(88,166,255,0.06)]"
                      }`}
                    >
                      {src}
                    </button>
                  ))}
                </div>
              )}
              {uniqueProjects.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {uniqueProjects.map((proj) => (
                    <button
                      key={proj}
                      onClick={() => {
                        setActiveProjectFilters((prev) => {
                          const next = new Set(prev);
                          if (next.has(proj)) next.delete(proj);
                          else next.add(proj);
                          return next;
                        });
                      }}
                      className={`px-2 py-0.5 rounded-full text-[11px] transition-colors ${
                        activeProjectFilters.has(proj)
                          ? "bg-[rgba(210,153,34,0.15)] text-[var(--yellow)] font-medium"
                          : "bg-[var(--bg)] text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[rgba(210,153,34,0.06)]"
                      }`}
                    >
                      {proj}
                    </button>
                  ))}
                </div>
              )}
              {(debouncedSearch || activeSourceFilters.size > 0 || activeProjectFilters.size > 0) && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setDebouncedSearch("");
                    setActiveSourceFilters(new Set());
                    setActiveProjectFilters(new Set());
                  }}
                  className="px-2 py-0.5 text-[11px] text-[var(--text-dim)] hover:text-[var(--text)] rounded-full hover:bg-[rgba(248,81,73,0.06)] transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            {/* Bulk action bar */}
            {bulkMode && selectedIds.size > 0 && (
              <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2.5 bg-[var(--surface2)] border-b border-[var(--border)]">
                <span className="text-xs font-medium text-[var(--text-bright)]">
                  {selectedIds.size} selected
                </span>
                <div className="flex items-center gap-2 ml-auto">
                  {bulkProgress ? (
                    <span className="text-xs text-[var(--text-dim)]">{bulkProgress}</span>
                  ) : (
                    <>
                      {/* Mark Done */}
                      <button
                        onClick={() =>
                          handleBulkAction(
                            { Status: { status: { name: "Done" } } },
                            "Mark Done",
                          )
                        }
                        className="px-3 py-1 text-xs font-medium bg-[var(--green)] text-[var(--bg)] rounded-md hover:opacity-90 transition-opacity"
                      >
                        Mark Done
                      </button>

                      {/* Set Priority dropdown */}
                      <div ref={bulkDropdown === "priority" ? bulkDropdownRef : undefined} className="relative">
                        <button
                          onClick={() => setBulkDropdown(bulkDropdown === "priority" ? null : "priority")}
                          className="px-3 py-1 text-xs font-medium text-[var(--text)] bg-[var(--bg)] border border-[var(--border)] rounded-md hover:border-[var(--accent)] transition-colors"
                        >
                          Set Priority
                        </button>
                        {bulkDropdown === "priority" && (
                          <div className="absolute top-full left-0 mt-1 z-[60] min-w-[180px] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg py-1 space-y-0.5">
                            <div className="px-3 py-1 text-[10px] text-[var(--text-dim)] uppercase tracking-wider">
                              Priority
                            </div>
                            {PRIORITY_OPTIONS.map((opt) => (
                              <button
                                key={opt.value}
                                className={`block w-full text-left px-3 py-1.5 text-xs rounded-md transition-colors ${
                                  opt.label === "P0" ? "text-[var(--red)] hover:bg-[rgba(248,81,73,0.1)]" :
                                  opt.label === "P1" ? "text-[var(--orange)] hover:bg-[rgba(219,109,40,0.1)]" :
                                  opt.label === "P2" ? "text-[var(--yellow)] hover:bg-[rgba(210,153,34,0.1)]" :
                                  "text-[var(--text-dim)] hover:bg-[rgba(139,148,158,0.1)]"
                                }`}
                                onClick={() =>
                                  handleBulkAction(
                                    { Priority: { select: { name: opt.value } } },
                                    `Set ${opt.label}`,
                                  )
                                }
                              >
                                {opt.value}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Set Status dropdown */}
                      <div ref={bulkDropdown === "status" ? bulkDropdownRef : undefined} className="relative">
                        <button
                          onClick={() => setBulkDropdown(bulkDropdown === "status" ? null : "status")}
                          className="px-3 py-1 text-xs font-medium text-[var(--text)] bg-[var(--bg)] border border-[var(--border)] rounded-md hover:border-[var(--accent)] transition-colors"
                        >
                          Set Status
                        </button>
                        {bulkDropdown === "status" && (
                          <div className="absolute top-full right-0 mt-1 z-[60] min-w-[180px] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg py-1 space-y-0.5">
                            <div className="px-3 py-1 text-[10px] text-[var(--text-dim)] uppercase tracking-wider">
                              Status
                            </div>
                            {STATUS_OPTIONS.map((opt) => (
                              <button
                                key={opt.value}
                                className={`block w-full text-left px-3 py-1.5 text-xs rounded-md transition-colors ${
                                  opt.value === "Done" ? "text-[var(--green)] hover:bg-[rgba(63,185,80,0.1)]" :
                                  opt.value === "In progress" ? "text-[var(--accent)] hover:bg-[rgba(88,166,255,0.1)]" :
                                  "text-[var(--text-dim)] hover:bg-[rgba(139,148,158,0.1)]"
                                }`}
                                onClick={() =>
                                  handleBulkAction(
                                    { Status: { status: { name: opt.value } } },
                                    `Set ${opt.label}`,
                                  )
                                }
                              >
                                {opt.value}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Merge */}
                      <button
                        onClick={handleBulkMerge}
                        disabled={selectedIds.size < 2}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-opacity ${
                          selectedIds.size >= 2
                            ? "bg-[rgb(139,92,246)] text-white hover:opacity-90"
                            : "bg-[rgba(139,92,246,0.3)] text-[rgba(139,92,246,0.5)] cursor-not-allowed"
                        }`}
                      >
                        Merge ({selectedIds.size})
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            {/* Select All row when in bulk mode with no selection yet */}
            {bulkMode && (
              <div className="flex items-center gap-3 px-4 py-1.5 border-b border-[var(--border)] bg-[var(--bg)]">
                <input
                  type="checkbox"
                  checked={filteredTasks.length > 0 && selectedIds.size === filteredTasks.length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedIds(new Set(filteredTasks.map((t) => t.id)));
                    } else {
                      setSelectedIds(new Set());
                    }
                  }}
                  className="w-4 h-4 rounded border-[var(--border)] bg-[var(--bg)] accent-[var(--accent)] cursor-pointer"
                />
                <span className="text-xs text-[var(--text-dim)]">Select all</span>
              </div>
            )}
            <div>
              {loading && (
                <div className="p-6 text-center text-[var(--text-dim)]">
                  Loading tasks...
                </div>
              )}
              {error && (
                <div className="p-6 text-center text-[var(--red)] text-sm">
                  {error}
                </div>
              )}
              {!loading && !error && actionableTasks.length === 0 && (
                <div className="p-6 text-center text-[var(--text-dim)] italic">
                  No open tasks
                </div>
              )}
              {!loading && !error && actionableTasks.length > 0 && filteredTasks.length === 0 && (
                <div className="p-6 text-center text-[var(--text-dim)] italic">
                  No tasks match current filters
                </div>
              )}
              {p0.length > 0 && (
                <>
                  <GroupHeader title="P0 — Today" />
                  {p0.map((t) => (
                    <TaskItem
                      key={t.id}
                      page={t}
                      onClick={setSelectedTask}
                      selectable={bulkMode}
                      selected={selectedIds.has(t.id)}
                      onSelect={toggleSelect}
                    />
                  ))}
                </>
              )}
              {p1.length > 0 && (
                <>
                  <GroupHeader title="P1 — This Week" />
                  {p1.map((t) => (
                    <TaskItem
                      key={t.id}
                      page={t}
                      onClick={setSelectedTask}
                      selectable={bulkMode}
                      selected={selectedIds.has(t.id)}
                      onSelect={toggleSelect}
                    />
                  ))}
                </>
              )}
              {p2.length > 0 && (
                <>
                  <GroupHeader title="P2 — This Month" />
                  {p2.map((t) => (
                    <TaskItem
                      key={t.id}
                      page={t}
                      onClick={setSelectedTask}
                      selectable={bulkMode}
                      selected={selectedIds.has(t.id)}
                      onSelect={toggleSelect}
                    />
                  ))}
                </>
              )}
            </div>
          </Card>
        </div>

        {/* Right: Calendar + Activity */}
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Today's Calendar"
              right={
                activeMeetings.length > 0 ? (
                  <span className="text-xs text-[var(--text-dim)]">
                    {activeMeetings.length} meetings
                  </span>
                ) : null
              }
            />
            {/* Schedule insights */}
            {(() => {
              const insights = scheduleInsights(meetings);
              return insights.length > 0 ? (
                <div className="px-4 py-2 border-b border-[var(--border)] bg-[rgba(210,153,34,0.04)] space-y-1">
                  {insights.map((text, i) => (
                    <div key={i} className="text-[11px] text-[var(--text-dim)]">{text}</div>
                  ))}
                </div>
              ) : null;
            })()}
            {/* Scrollable meeting list — hidden scrollbar */}
            <div className="max-h-[60vh] overflow-y-auto [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
              {meetings.length === 0 && !loading && (
                <div className="p-6 text-center text-[var(--text-dim)] italic">
                  No meetings today
                </div>
              )}
              {(() => {
                const now = new Date();
                const conflicts = findConflicts(meetings);
                const gaps = findGaps(meetings);
                const sorted = [...meetings].sort((a, b) => a.start.localeCompare(b.start));
                const gapMap = new Map(gaps.map((g) => [g.after, g]));

                const allDay = sorted.filter((m) => isAllDay(m));
                const timed = sorted.filter((m) => !isAllDay(m));
                const upcoming = timed.filter((m) => new Date(m.end) > now);
                const past = timed.filter((m) => new Date(m.end) <= now);

                // Find the next meeting for highlighting
                const nextMeeting = upcoming.find((m) => new Date(m.start) > now);

                return (
                  <>
                    {/* All-day events always shown */}
                    {allDay.map((m) => (
                      <MeetingItem key={m.id} meeting={m} onClick={setSelectedMeeting} />
                    ))}

                    {/* Next up label */}
                    {nextMeeting && upcoming.length > 0 && (
                      <div className="px-4 py-1.5 bg-[rgba(63,185,80,0.06)] border-b border-[var(--border)]">
                        <span className="text-[10px] uppercase tracking-wider text-[var(--green)] font-medium">
                          Up Next
                        </span>
                      </div>
                    )}

                    {/* Upcoming / in-progress meetings */}
                    {upcoming.map((m) => (
                      <MeetingItem
                        key={m.id}
                        meeting={m}
                        onClick={setSelectedMeeting}
                        isConflict={conflicts.has(m.id)}
                        gap={gapMap.get(m.id) || null}
                      />
                    ))}

                    {/* Past meetings — collapsed */}
                    {past.length > 0 && (
                      <details className="group/past">
                        <summary className="px-4 py-1.5 border-b border-[var(--border)] cursor-pointer hover:bg-[rgba(88,166,255,0.03)] list-none">
                          <span className="text-[10px] uppercase tracking-wider text-[var(--text-dim)]">
                            Earlier Today ({past.length})
                            <span className="ml-1 group-open/past:hidden">▸</span>
                            <span className="ml-1 hidden group-open/past:inline">▾</span>
                          </span>
                        </summary>
                        <div className="opacity-60">
                          {past.map((m) => (
                            <MeetingItem
                              key={m.id}
                              meeting={m}
                              onClick={setSelectedMeeting}
                              isConflict={conflicts.has(m.id)}
                            />
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                );
              })()}
            </div>
          </Card>

          <Card>
            <CardHeader title="Recent Agent Activity" />
            <div>
              {(runs || []).map((r, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)]"
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      background:
                        r.status === "success"
                          ? "var(--green)"
                          : "var(--red)",
                    }}
                  />
                  <span className="text-[13px] text-[var(--text-dim)] w-16 shrink-0">
                    {timeAgo(r.run_at)}
                  </span>
                  <span className="text-[13px] truncate">{r.task_id}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Task detail modal */}
      {selectedTask && (
        <TaskDetail
          page={selectedTask}
          onClose={() => setSelectedTask(null)}
          onComplete={(id) => {
            setTasks((prev) => prev.filter((p) => p.id !== id));
            setSelectedTask(null);
          }}
        />
      )}

      {/* Meeting prep slide-over */}
      {selectedMeeting && (
        <MeetingPrep
          meeting={selectedMeeting}
          onClose={() => setSelectedMeeting(null)}
        />
      )}
    </div>
  );
}
