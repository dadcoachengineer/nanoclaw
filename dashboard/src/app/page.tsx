"use client";

import { useState } from "react";
import { fmtDate } from "@/lib/dates";
import TodayView from "@/components/views/TodayView";
import WeekAheadView from "@/components/views/WeekAheadView";
import WeekReviewView from "@/components/views/WeekReviewView";
import TopicsView from "@/components/views/TopicsView";
import PeopleView from "@/components/views/PeopleView";
import InitiativesView from "@/components/views/ProjectsView";
import WeeklyCheckinView from "@/components/views/WeeklyCheckinView";
import SystemView from "@/components/views/SystemView";
import SearchBar from "@/components/SearchBar";

const TABS = [
  { id: "today", label: "Today" },
  { id: "week-ahead", label: "Week Ahead" },
  { id: "week-review", label: "Week in Review" },
  { id: "checkin", label: "Check-in" },
  { id: "initiatives", label: "Initiatives" },
  { id: "people", label: "People" },
  { id: "topics", label: "Topics" },
  { id: "system", label: "System" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export default function Home() {
  const [tab, setTab] = useState<Tab>("today");

  return (
    <>
      <header className="flex items-center justify-between px-8 py-5 border-b border-[var(--border)]">
        <h1 className="text-xl font-semibold text-[var(--text-bright)]">
          Mission Control
        </h1>
        <div className="flex items-center gap-4">
          <div className="flex gap-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-1.5 rounded-md text-[13px] border transition-colors ${
                  tab === t.id
                    ? "bg-[var(--surface)] border-[var(--border)] text-[var(--text-bright)]"
                    : "border-transparent text-[var(--text-dim)] hover:text-[var(--text)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <SearchBar />
          <span className="text-sm text-[var(--text-dim)]">
            {fmtDate(new Date())}
          </span>
        </div>
      </header>

      <main>
        {tab === "today" && <TodayView />}
        {tab === "week-ahead" && <WeekAheadView />}
        {tab === "week-review" && <WeekReviewView />}
        {tab === "checkin" && <WeeklyCheckinView />}
        {tab === "initiatives" && <InitiativesView />}
        {tab === "people" && <PeopleView />}
        {tab === "topics" && <TopicsView />}
        {tab === "system" && <SystemView />}
      </main>
    </>
  );
}
