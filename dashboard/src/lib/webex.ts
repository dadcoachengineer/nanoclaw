/**
 * Webex API helpers.
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
