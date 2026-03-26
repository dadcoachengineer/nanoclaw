/**
 * Build the person index — a cross-platform knowledge graph mapping people
 * across Webex, Plaud, Notion, and Boox data sources.
 *
 * Stores results in store/person-index.json
 *
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/build-person-index.ts
 */
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";

const STORE_DIR = path.join(process.cwd(), "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

// OneCLI proxy for Notion
const AGENT_TOKEN =
  "aoc_181429a83379e2122e9e0b6cde6eefd6b897809b92c08cc4bc788816e26e399a";
const proxyAgent = new HttpsProxyAgent(
  `http://x:${AGENT_TOKEN}@localhost:10255`
);

// Webex token (direct, not proxied — we're on the host)
const webexConfig = JSON.parse(
  fs.readFileSync(path.join(STORE_DIR, "webex-oauth.json"), "utf-8")
);
const WEBEX_TOKEN = webexConfig.access_token;

interface PersonEntry {
  name: string;
  emails: string[];
  webexRoomIds: string[]; // direct rooms
  webexGroupRooms: string[]; // group rooms they're in
  meetings: { id: string; topic: string; date: string; role: string }[];
  transcriptMentions: {
    recordingId: string;
    topic: string;
    date: string;
    snippetCount: number;
    snippets: string[];
  }[];
  notionTasks: { id: string; title: string; status: string }[];
  messageExcerpts: { text: string; date: string; roomTitle: string }[];
}

type PersonIndex = Record<string, PersonEntry>;

// --- Fetch helpers ---

async function webexGet(path: string): Promise<unknown> {
  const resp = await fetch(`https://webexapis.com/v1${path}`, {
    headers: { Authorization: `Bearer ${WEBEX_TOKEN}` },
  });
  return resp.json();
}

async function notionPost(
  endpoint: string,
  body: unknown
): Promise<unknown> {
  const nodeFetch = (await import("node-fetch")).default;
  const resp = await nodeFetch(
    `https://api.notion.com/v1${endpoint}`,
    {
      method: "POST",
      agent: proxyAgent,
      headers: {
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify(body),
    }
  );
  return resp.json();
}

function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

function getOrCreate(index: PersonIndex, name: string): PersonEntry {
  const key = normalizeKey(name);
  if (!key) return { name, emails: [], webexRoomIds: [], webexGroupRooms: [], meetings: [], transcriptMentions: [], notionTasks: [], messageExcerpts: [] };
  if (!index[key]) {
    index[key] = {
      name,
      emails: [],
      webexRoomIds: [],
      webexGroupRooms: [],
      meetings: [],
      transcriptMentions: [],
      notionTasks: [],
      messageExcerpts: [],
    };
  }
  // Keep the most "complete" version of the name
  if (name.length > index[key].name.length) index[key].name = name;
  return index[key];
}

function addUnique<T>(arr: T[], item: T): void {
  if (!arr.includes(item)) arr.push(item);
}

// --- Source indexers ---

async function indexWebexPeople(index: PersonIndex): Promise<void> {
  console.log("Indexing Webex people...");
  const data = (await webexGet("/people?max=200")) as {
    items?: { displayName: string; emails: string[]; id: string }[];
  };
  for (const p of data.items || []) {
    if (p.emails?.[0] === "jasheare@cisco.com") continue;
    const entry = getOrCreate(index, p.displayName);
    for (const email of p.emails || []) {
      addUnique(entry.emails, email);
    }
  }
  console.log(`  ${(data.items || []).length} people found`);
}

async function indexWebexRooms(index: PersonIndex): Promise<void> {
  console.log("Indexing Webex rooms...");
  const data = (await webexGet(
    "/rooms?sortBy=lastactivity&max=50"
  )) as { items?: { id: string; title: string; type: string }[] };

  for (const room of data.items || []) {
    if (room.type === "direct") {
      // Direct room title = the other person's name
      const entry = getOrCreate(index, room.title);
      addUnique(entry.webexRoomIds, room.id);
    }
  }
  console.log(
    `  ${(data.items || []).filter((r) => r.type === "direct").length} direct rooms indexed`
  );
}

async function indexWebexDirectMessages(index: PersonIndex): Promise<void> {
  console.log("Indexing Webex direct messages...");
  const data = (await webexGet(
    "/rooms?type=direct&sortBy=lastactivity&max=20"
  )) as { items?: { id: string; title: string }[] };

  let totalMsgs = 0;
  for (const room of (data.items || []).slice(0, 15)) {
    const entry = getOrCreate(index, room.title);
    const msgs = (await webexGet(
      `/messages?roomId=${room.id}&max=20`
    )) as {
      items?: {
        text: string;
        personEmail: string;
        created: string;
      }[];
    };

    for (const m of (msgs.items || []).slice(0, 10)) {
      entry.messageExcerpts.push({
        text: (m.text || "").slice(0, 300),
        date: m.created,
        roomTitle: room.title,
      });
      if (m.personEmail && m.personEmail !== "jasheare@cisco.com") {
        addUnique(entry.emails, m.personEmail);
      }
      totalMsgs++;
    }
    // Rate limit protection
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  ${totalMsgs} messages indexed from ${(data.items || []).length} rooms`);
}

async function indexWebexRecordings(index: PersonIndex): Promise<void> {
  console.log("Indexing Webex recordings and transcripts...");

  // Fetch recordings month by month going back 6 months
  const allRecordings: {
    id: string;
    topic: string;
    createTime: string;
    hostEmail?: string;
    hostDisplayName?: string;
  }[] = [];

  const now = new Date();
  for (let monthsBack = 0; monthsBack < 6; monthsBack++) {
    const from = new Date(now);
    from.setMonth(from.getMonth() - monthsBack - 1);
    from.setDate(1);
    const to = new Date(now);
    to.setMonth(to.getMonth() - monthsBack);
    to.setDate(0); // last day of previous month

    const data = (await webexGet(
      `/recordings?from=${from.toISOString()}&to=${to.toISOString()}&max=50`
    )) as { items?: typeof allRecordings };
    allRecordings.push(...(data.items || []));
    await new Promise((r) => setTimeout(r, 300));
  }

  // Also fetch current month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const curData = (await webexGet(
    `/recordings?from=${monthStart.toISOString()}&to=${now.toISOString()}&max=50`
  )) as { items?: typeof allRecordings };
  allRecordings.push(...(curData.items || []));

  console.log(`  ${allRecordings.length} total recordings found`);

  // For each recording, get detail (which has transcript download link)
  let transcriptCount = 0;
  for (const rec of allRecordings) {
    // Index the host
    if (rec.hostDisplayName && rec.hostEmail !== "jasheare@cisco.com") {
      const hostEntry = getOrCreate(index, rec.hostDisplayName);
      if (rec.hostEmail) addUnique(hostEntry.emails, rec.hostEmail);
      hostEntry.meetings.push({
        id: rec.id,
        topic: rec.topic,
        date: rec.createTime,
        role: "host",
      });
    }

    // Get recording detail for transcript
    try {
      const detail = (await webexGet(`/recordings/${rec.id}`)) as {
        temporaryDirectDownloadLinks?: {
          transcriptDownloadLink?: string;
        };
      };

      const transcriptUrl =
        detail.temporaryDirectDownloadLinks?.transcriptDownloadLink;
      if (!transcriptUrl) continue;

      // Download transcript
      const transResp = await fetch(transcriptUrl);
      const vtt = await transResp.text();

      // Parse VTT for speaker names and their lines
      const speakerLines: Record<string, string[]> = {};
      const speakerRegex =
        /^\d+\s+"([^"]+)"\s+\(\d+\)\s*$/;
      const lines = vtt.split("\n");

      let currentSpeaker = "";
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(speakerRegex);
        if (match) {
          currentSpeaker = match[1];
          if (!speakerLines[currentSpeaker])
            speakerLines[currentSpeaker] = [];
        } else if (
          currentSpeaker &&
          lines[i].trim() &&
          !lines[i].includes("-->") &&
          !lines[i].match(/^\d+$/) &&
          lines[i] !== "WEBVTT"
        ) {
          speakerLines[currentSpeaker].push(lines[i].trim());
        }
      }

      // Index each speaker
      for (const [speaker, sLines] of Object.entries(speakerLines)) {
        if (speaker.toLowerCase().includes("jason shearer")) continue;
        // Skip room/device names
        if (speaker.match(/^[A-Z]{2,}\d/)) continue;

        const entry = getOrCreate(index, speaker);
        entry.transcriptMentions.push({
          recordingId: rec.id,
          topic: rec.topic,
          date: rec.createTime,
          snippetCount: sLines.length,
          snippets: sLines.slice(0, 5).map((s) => s.slice(0, 200)),
        });
        entry.meetings.push({
          id: rec.id,
          topic: rec.topic,
          date: rec.createTime,
          role: "speaker",
        });
      }
      transcriptCount++;
      console.log(
        `  Transcript: ${rec.topic.slice(0, 50)} — ${Object.keys(speakerLines).length} speakers`
      );
    } catch (err) {
      // Transcript not available for this recording
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`  ${transcriptCount} transcripts processed`);
}

async function indexNotionTasks(index: PersonIndex): Promise<void> {
  console.log("Indexing Notion tasks...");

  let hasMore = true;
  let startCursor: string | undefined;
  let total = 0;

  while (hasMore) {
    const body: Record<string, unknown> = {
      page_size: 100,
    };
    if (startCursor) body.start_cursor = startCursor;

    const data = (await notionPost(
      `/databases/${NOTION_DB}/query`,
      body
    )) as {
      results?: {
        id: string;
        properties: Record<string, unknown>;
      }[];
      has_more?: boolean;
      next_cursor?: string;
    };

    for (const page of data.results || []) {
      const taskProp = page.properties?.Task as {
        title?: { plain_text: string }[];
      };
      const notesProp = page.properties?.Notes as {
        rich_text?: { plain_text: string }[];
      };
      const statusProp = page.properties?.Status as {
        status?: { name: string };
      };

      const title =
        taskProp?.title?.[0]?.plain_text || "";
      const notes =
        notesProp?.rich_text?.[0]?.plain_text || "";
      const status = statusProp?.status?.name || "";

      // Extract person names from title and notes
      // Look for common patterns: "Reply to X", "Follow up with X", "Meet with X", "X's"
      const text = `${title} ${notes}`;

      // Match against existing people in the index
      for (const [key, entry] of Object.entries(index)) {
        const nameParts = entry.name.split(" ");
        const lastName = nameParts[nameParts.length - 1];
        const firstName = nameParts[0];

        // Check if the task mentions this person (full name, last name, or first name if unique enough)
        if (
          text.toLowerCase().includes(entry.name.toLowerCase()) ||
          (lastName.length > 3 &&
            text.toLowerCase().includes(lastName.toLowerCase()))
        ) {
          // Avoid duplicate task entries
          if (!entry.notionTasks.find((t) => t.id === page.id)) {
            entry.notionTasks.push({ id: page.id, title, status });
          }
        }
      }
      total++;
    }

    hasMore = data.has_more || false;
    startCursor = data.next_cursor;
  }
  console.log(`  ${total} tasks scanned`);
}

// --- Merge duplicates ---

function mergeIndex(index: PersonIndex): PersonIndex {
  // Merge entries that share an email
  const emailMap = new Map<string, string>(); // email -> key
  const merged: PersonIndex = {};

  for (const [key, entry] of Object.entries(index)) {
    let mergeTarget: string | null = null;

    for (const email of entry.emails) {
      if (emailMap.has(email)) {
        mergeTarget = emailMap.get(email)!;
        break;
      }
    }

    if (mergeTarget && merged[mergeTarget]) {
      // Merge into existing
      const target = merged[mergeTarget];
      if (entry.name.length > target.name.length) target.name = entry.name;
      for (const e of entry.emails) addUnique(target.emails, e);
      for (const r of entry.webexRoomIds) addUnique(target.webexRoomIds, r);
      for (const r of entry.webexGroupRooms) addUnique(target.webexGroupRooms, r);
      target.meetings.push(...entry.meetings);
      target.transcriptMentions.push(...entry.transcriptMentions);
      target.notionTasks.push(...entry.notionTasks);
      target.messageExcerpts.push(...entry.messageExcerpts);
    } else {
      merged[key] = { ...entry };
    }

    for (const email of entry.emails) {
      emailMap.set(email, mergeTarget || key);
    }
  }

  return merged;
}

// --- Main ---

async function main() {
  console.log("Building person index...\n");

  const index: PersonIndex = {};

  // Load existing index if available (incremental updates)
  if (fs.existsSync(INDEX_PATH)) {
    const existing = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    Object.assign(index, existing);
    console.log(`Loaded existing index: ${Object.keys(index).length} people\n`);
  }

  await indexWebexPeople(index);
  await indexWebexRooms(index);
  await indexWebexDirectMessages(index);
  await indexWebexRecordings(index);
  await indexNotionTasks(index);

  // Merge duplicates
  const merged = mergeIndex(index);

  // Sort by interaction count
  const sorted = Object.fromEntries(
    Object.entries(merged).sort(
      ([, a], [, b]) =>
        b.meetings.length +
        b.transcriptMentions.length +
        b.messageExcerpts.length +
        b.notionTasks.length -
        (a.meetings.length +
          a.transcriptMentions.length +
          a.messageExcerpts.length +
          a.notionTasks.length)
    )
  );

  fs.writeFileSync(INDEX_PATH, JSON.stringify(sorted, null, 2));

  // Summary
  const people = Object.values(sorted);
  console.log(`\n=== Person Index Summary ===`);
  console.log(`Total people: ${people.length}`);
  console.log(
    `With emails: ${people.filter((p) => p.emails.length > 0).length}`
  );
  console.log(
    `With transcripts: ${people.filter((p) => p.transcriptMentions.length > 0).length}`
  );
  console.log(
    `With messages: ${people.filter((p) => p.messageExcerpts.length > 0).length}`
  );
  console.log(
    `With Notion tasks: ${people.filter((p) => p.notionTasks.length > 0).length}`
  );

  console.log(`\nTop 15 by interaction volume:`);
  for (const [key, p] of Object.entries(sorted).slice(0, 15)) {
    const total =
      p.meetings.length +
      p.transcriptMentions.length +
      p.messageExcerpts.length +
      p.notionTasks.length;
    console.log(
      `  ${p.name.padEnd(30)} ${total} interactions (${p.meetings.length} mtg, ${p.transcriptMentions.length} trans, ${p.messageExcerpts.length} msg, ${p.notionTasks.length} tasks)`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
