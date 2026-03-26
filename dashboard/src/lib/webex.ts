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
}

export async function fetchMeetings(
  from: string,
  to: string
): Promise<WebexMeeting[]> {
  const resp = await fetch(
    `/api/webex/meetings?from=${from}&to=${to}`
  );
  const data = await resp.json();
  return data.items || [];
}

export function meetingDurationHours(m: WebexMeeting): number {
  return (
    (new Date(m.end).getTime() - new Date(m.start).getTime()) / 3600000
  );
}
