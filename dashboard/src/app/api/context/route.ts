import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import fs from "fs";
import path from "path";

const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");

function getWebexToken(): string | null {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(STORE_DIR, "webex-oauth.json"), "utf-8")
    );
    return config.access_token;
  } catch {
    return null;
  }
}

/**
 * GET /api/context?email=person@cisco.com&name=Marcela
 *
 * Searches across Webex messages, recordings, and Notion tasks
 * for context related to a person (by email or name).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const email = searchParams.get("email") || "";
  const name = searchParams.get("name") || "";

  if (!email && !name) {
    return NextResponse.json({ error: "email or name required" }, { status: 400 });
  }

  const results: Record<string, unknown> = {};

  // --- Webex: recent 1:1 messages with this person ---
  if (email) {
    try {
      // Find the direct room with this person
      const roomsResp = await proxiedFetch(
        `https://webexapis.com/v1/rooms?type=direct&sortBy=lastactivity&max=50`,
        { headers: { Accept: "application/json" } }
      );
      const roomsData = (await roomsResp.json()) as { items?: { id: string; title: string }[] };

      // Webex direct room titles show the other person's name
      const searchName = name || email.split("@")[0];
      const matchRoom = roomsData.items?.find(
        (r) => r.title.toLowerCase().includes(searchName.toLowerCase())
      );

      if (matchRoom) {
        const msgsResp = await proxiedFetch(
          `https://webexapis.com/v1/messages?roomId=${matchRoom.id}&max=10`,
          { headers: { Accept: "application/json" } }
        );
        const msgsData = (await msgsResp.json()) as { items?: { text: string; personEmail: string; created: string }[] };
        results.directMessages = (msgsData.items || []).map((m) => ({
          text: m.text?.slice(0, 200),
          from: m.personEmail,
          created: m.created,
        }));
      }
    } catch (err) {
      results.directMessagesError = String(err);
    }
  }

  // --- Webex: recent recordings/transcripts from meetings with this person ---
  if (email) {
    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
      const recsResp = await proxiedFetch(
        `https://webexapis.com/v1/recordings?from=${thirtyDaysAgo.toISOString()}&to=${now.toISOString()}&max=20`,
        { headers: { Accept: "application/json" } }
      );
      const recsData = (await recsResp.json()) as { items?: { id: string; topic: string; createTime: string }[] };

      // Filter recordings whose topic mentions the person's name
      const searchTerm = name || email.split("@")[0];
      const relevant = (recsData.items || []).filter(
        (r) => r.topic.toLowerCase().includes(searchTerm.toLowerCase())
      );
      results.recentMeetings = relevant.slice(0, 5).map((r) => ({
        topic: r.topic,
        date: r.createTime,
      }));
    } catch (err) {
      results.recentMeetingsError = String(err);
    }
  }

  // --- Webex: group space mentions ---
  // (Skip for now — would need to scan many rooms, too slow for a single request)

  // --- Notion: tasks mentioning this person ---
  const searchTerm = name || email.split("@")[0];
  try {
    const notionResp = await proxiedFetch(
      `https://api.notion.com/v1/databases/${NOTION_DB}/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify({
          filter: {
            or: [
              {
                property: "Task",
                title: { contains: searchTerm },
              },
              {
                property: "Notes",
                rich_text: { contains: searchTerm },
              },
            ],
          },
          page_size: 10,
        }),
      }
    );
    const notionData = (await notionResp.json()) as { results?: { id: string; properties: Record<string, unknown> }[] };
    results.relatedTasks = (notionData.results || []).map((p) => {
      const taskProp = p.properties?.Task as { title?: { plain_text: string }[] } | undefined;
      const statusProp = p.properties?.Status as { status?: { name: string } } | undefined;
      return {
        id: p.id,
        title: taskProp?.title?.[0]?.plain_text || "?",
        status: statusProp?.status?.name || "?",
      };
    });
  } catch (err) {
    results.relatedTasksError = String(err);
  }

  // --- Webex: upcoming meetings with this person ---
  if (email) {
    try {
      const now = new Date();
      const weekAhead = new Date(now.getTime() + 7 * 86400000);
      const mtgsResp = await proxiedFetch(
        `https://webexapis.com/v1/meetings?from=${now.toISOString()}&to=${weekAhead.toISOString()}&max=20&meetingType=scheduledMeeting`,
        { headers: { Accept: "application/json" } }
      );
      const mtgsData = (await mtgsResp.json()) as { items?: { id: string; title: string; start: string; hostEmail: string }[] };
      const searchName = name || email.split("@")[0];
      const upcoming = (mtgsData.items || []).filter(
        (m) =>
          m.title.toLowerCase().includes(searchName.toLowerCase()) ||
          m.hostEmail === email
      );
      results.upcomingMeetings = upcoming.slice(0, 5).map((m) => ({
        title: m.title,
        start: m.start,
      }));
    } catch (err) {
      results.upcomingMeetingsError = String(err);
    }
  }

  return NextResponse.json(results);
}
