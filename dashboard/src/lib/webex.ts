/**
 * Calendar helpers — Webex + Google Calendar.
 */

export interface WebexMeeting {
  id: string;
  title: string;
  start: string;
  end: string;
  state: "scheduled" | "ready" | "inProgress" | "ended" | "missed";
  hostDisplayName?: string;
  hostEmail?: string;
  meetingType?: string;
  webLink?: string;
  source?: "webex" | "google";
  calendarName?: string;
  location?: string;
}

export async function fetchMeetings(
  from: string,
  to: string
): Promise<WebexMeeting[]> {
  const resp = await fetch(
    `/api/webex/meetings?from=${from}&to=${to}`
  );
  if (resp.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/login";
    return [];
  }
  const data = await resp.json();
  return data.items || [];
}

export function meetingDurationHours(m: WebexMeeting): number {
  return (
    (new Date(m.end).getTime() - new Date(m.start).getTime()) / 3600000
  );
}

export function isAllDay(m: WebexMeeting): boolean {
  return meetingDurationHours(m) >= 12;
}

/** Filter out all-day events for time calculations */
export function timedMeetings(meetings: WebexMeeting[]): WebexMeeting[] {
  return meetings.filter((m) => !isAllDay(m));
}

/**
 * Fetch Google Calendar events and normalize to WebexMeeting shape.
 * Filters to events that fall within the given from/to range.
 */
export async function fetchGoogleCalendarEvents(
  from: string,
  to: string
): Promise<WebexMeeting[]> {
  const resp = await fetch("/api/calendar/events");
  if (!resp.ok) return [];
  const data = await resp.json();
  const events: { id: string; summary: string; start: string; end: string; location?: string; calendar?: string }[] = data.events || [];

  const fromDate = new Date(from);
  const toDate = new Date(to);
  const now = new Date();

  return events
    .filter((e) => {
      // All-day events have date-only strings (e.g. "2026-04-02")
      const startDate = new Date(e.start);
      const endDate = new Date(e.end);
      return startDate < toDate && endDate > fromDate;
    })
    .map((e): WebexMeeting => {
      const startDate = new Date(e.start);
      const endDate = new Date(e.end);
      const state: WebexMeeting["state"] =
        now >= startDate && now <= endDate ? "inProgress"
        : now > endDate ? "ended"
        : "scheduled";

      return {
        id: `gcal-${e.id}`,
        title: e.summary,
        start: e.start,
        end: e.end,
        state,
        source: "google",
        calendarName: e.calendar,
        location: e.location || undefined,
      };
    });
}
