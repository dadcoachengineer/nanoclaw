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
const TOPIC_INDEX_PATH = path.join(STORE_DIR, "topic-index.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

// Known topics with keyword patterns
const TOPIC_PATTERNS: { name: string; keywords: string[] }[] = [
  { name: "Real Estate Accelerator", keywords: ["real estate", "accelerator", "design office hours"] },
  { name: "Cisco Spaces", keywords: ["spaces", "cisco spaces", "spatial intelligence"] },
  { name: "CADENAS / CAD", keywords: ["cadenas", "cad ", "bim ", "revit", "autocad"] },
  { name: "FPW (Future-Proofed Workplaces)", keywords: ["fpw", "future-proofed", "future proofed", "clamer"] },
  { name: "Smart Building / IoT", keywords: ["smart building", "smart room", "bms", "iot ", "cybervision", "ise "] },
  { name: "Coaching & Leadership", keywords: ["coaching", "smdd", "stldp", "leadership", "ipec", "momentumeq"] },
  { name: "Splunk", keywords: ["splunk", "vista"] },
  { name: "Energy / PoE", keywords: ["energy", "poe ", "power over ethernet"] },
  { name: "Cross Architecture", keywords: ["cross architecture", "cross arch"] },
  { name: "NTT / Gigaraku", keywords: ["ntt", "gigaraku"] },
  { name: "Workday", keywords: ["workday"] },
  { name: "Ordinary Epics", keywords: ["ordinary epics", "adventure"] },
  { name: "DBS / Skyline", keywords: ["dbs", "skyline"] },
  { name: "Partner Ecosystem", keywords: ["partner", "ecosystem", "wesco", "distributor"] },
];

interface TopicEntry {
  name: string;
  meetings: { id: string; topic: string; date: string }[];
  transcriptSnippets: { topic: string; date: string; speakers: string[]; keyLines: string[] }[];
  webexRooms: { id: string; title: string }[];
  notionTasks: { id: string; title: string; status: string; source: string }[];
  messageExcerpts: { text: string; date: string; roomTitle: string }[];
  people: string[]; // names of people associated with this topic
}

type TopicIndex = Record<string, TopicEntry>;

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
  avatar?: string;
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
  aiSummaries: {
    meetingId: string;
    title: string;
    date: string;
    summary: string;
    actionItems: string[];
  }[];
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
  if (!key) return { name, emails: [], webexRoomIds: [], webexGroupRooms: [], meetings: [], transcriptMentions: [], notionTasks: [], messageExcerpts: [], aiSummaries: [] };
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
      aiSummaries: [],
    };
  }
  // Keep the most "complete" version of the name
  if (name.length > index[key].name.length) index[key].name = name;
  return index[key];
}

function addUnique<T>(arr: T[], item: T): void {
  if (!arr.includes(item)) arr.push(item);
}

function getOrCreateTopic(index: TopicIndex, name: string): TopicEntry {
  const key = name.toLowerCase();
  if (!index[key]) {
    index[key] = {
      name,
      meetings: [],
      transcriptSnippets: [],
      webexRooms: [],
      notionTasks: [],
      messageExcerpts: [],
      aiSummaries: [],
      people: [],
    };
  }
  return index[key];
}

function matchTopics(text: string): string[] {
  const lower = text.toLowerCase();
  return TOPIC_PATTERNS
    .filter((p) => p.keywords.some((kw) => lower.includes(kw)))
    .map((p) => p.name);
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

async function indexWebexRooms(index: PersonIndex, topicIndex: TopicIndex): Promise<void> {
  console.log("Indexing Webex rooms...");
  const data = (await webexGet(
    "/rooms?sortBy=lastactivity&max=50"
  )) as { items?: { id: string; title: string; type: string }[] };

  for (const room of data.items || []) {
    if (room.type === "direct") {
      const entry = getOrCreate(index, room.title);
      addUnique(entry.webexRoomIds, room.id);
    }
    // Index group rooms by topic
    const topicMatches = matchTopics(room.title);
    for (const topicName of topicMatches) {
      const topic = getOrCreateTopic(topicIndex, topicName);
      if (!topic.webexRooms.find((r) => r.id === room.id)) {
        topic.webexRooms.push({ id: room.id, title: room.title });
      }
    }
  }
  console.log(
    `  ${(data.items || []).filter((r) => r.type === "direct").length} direct rooms, ${(data.items || []).filter((r) => r.type === "group").length} group rooms indexed`
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
      if (!m.text || m.text.length < 5) continue;
      const dedupKey = `${m.created}:${(m.text || "").slice(0, 50)}`;
      if (entry.messageExcerpts.some((e) => `${e.date}:${e.text.slice(0, 50)}` === dedupKey)) continue;
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

async function indexWebexRecordings(index: PersonIndex, topicIndex: TopicIndex): Promise<void> {
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
        if (!entry.transcriptMentions.some((t) => t.recordingId === rec.id)) {
          entry.transcriptMentions.push({
            recordingId: rec.id,
            topic: rec.topic,
            date: rec.createTime,
            snippetCount: sLines.length,
            snippets: sLines.slice(0, 5).map((s) => s.slice(0, 200)),
          });
        }
        if (!entry.meetings.some((m) => m.id === rec.id)) {
          entry.meetings.push({
            id: rec.id,
            topic: rec.topic,
            date: rec.createTime,
            role: "speaker",
          });
        }
      }

      // Index topics from this recording
      const topicMatches = matchTopics(rec.topic + " " + vtt.slice(0, 2000));
      for (const topicName of topicMatches) {
        const topic = getOrCreateTopic(topicIndex, topicName);
        if (!topic.meetings.find((m) => m.id === rec.id)) {
          topic.meetings.push({ id: rec.id, topic: rec.topic, date: rec.createTime });
        }
        // Add key transcript lines to topic
        const allLines = Object.entries(speakerLines).flatMap(([speaker, lines]) =>
          lines.slice(0, 3).map((l) => `${speaker}: ${l}`)
        );
        topic.transcriptSnippets.push({
          topic: rec.topic,
          date: rec.createTime,
          speakers: Object.keys(speakerLines).filter((s) => !s.toLowerCase().includes("jason shearer")),
          keyLines: allLines.slice(0, 8),
        });
        // Track people associated with this topic
        for (const speaker of Object.keys(speakerLines)) {
          if (!speaker.toLowerCase().includes("jason shearer") && !speaker.match(/^[A-Z]{2,}\d/)) {
            addUnique(topic.people, speaker);
          }
        }
      }

      transcriptCount++;
      console.log(
        `  Transcript: ${rec.topic.slice(0, 50)} — ${Object.keys(speakerLines).length} speakers — topics: ${topicMatches.join(", ") || "none"}`
      );
    } catch (err) {
      // Transcript not available for this recording
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`  ${transcriptCount} transcripts processed`);
}

async function indexNotionTasks(index: PersonIndex, topicIndex: TopicIndex): Promise<void> {
  console.log("Indexing Notion tasks...");

  let hasMore = true;
  let startCursor: string | undefined;
  let total = 0;
  const sourceCounts: Record<string, number> = {};

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
      const sourceProp = page.properties?.Source as {
        select?: { name: string };
      };

      const title = taskProp?.title?.[0]?.plain_text || "";
      const notes = notesProp?.rich_text?.[0]?.plain_text || "";
      const status = statusProp?.status?.name || "";
      const source = sourceProp?.select?.name || "";
      sourceCounts[source || "(none)"] = (sourceCounts[source || "(none)"] || 0) + 1;

      const text = `${title} ${notes}`;
      const textLower = text.toLowerCase();

      // Match against existing people in the index
      for (const [key, entry] of Object.entries(index)) {
        const nameParts = entry.name.split(" ");
        const lastName = nameParts[nameParts.length - 1];

        if (
          textLower.includes(entry.name.toLowerCase()) ||
          (lastName.length > 3 && textLower.includes(lastName.toLowerCase()))
        ) {
          if (!entry.notionTasks.find((t) => t.id === page.id)) {
            entry.notionTasks.push({ id: page.id, title, status });
          }
        }
      }

      // Match against topics
      for (const pattern of TOPIC_PATTERNS) {
        if (pattern.keywords.some((kw) => textLower.includes(kw))) {
          const topic = getOrCreateTopic(topicIndex, pattern.name);
          if (!topic.notionTasks.find((t) => t.id === page.id)) {
            topic.notionTasks.push({ id: page.id, title, status, source });
          }
        }
      }

      total++;
    }

    hasMore = data.has_more || false;
    startCursor = data.next_cursor;
  }
  console.log(`  ${total} tasks scanned`);
  console.log(`  Sources: ${JSON.stringify(sourceCounts)}`);
}

async function fetchAvatars(index: PersonIndex): Promise<void> {
  console.log("Fetching avatars from Webex...");
  let fetched = 0;
  let skipped = 0;

  for (const [key, entry] of Object.entries(index)) {
    // Skip if already have avatar or no email
    if (entry.avatar || entry.emails.length === 0) {
      skipped++;
      continue;
    }

    try {
      const data = (await webexGet(
        `/people?email=${encodeURIComponent(entry.emails[0])}`
      )) as { items?: { avatar?: string }[] };

      const avatar = data.items?.[0]?.avatar;
      if (avatar) {
        entry.avatar = avatar;
        fetched++;
      }
    } catch {
      // Skip — person may not be in the Webex org
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  ${fetched} avatars fetched, ${skipped} skipped (already have or no email)`);
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

// --- AI Summaries (from store/webex-summaries.json) ---

const SUMMARIES_PATH = path.join(STORE_DIR, "webex-summaries.json");

async function indexAiSummaries(index: PersonIndex, topicIndex: TopicIndex) {
  if (!fs.existsSync(SUMMARIES_PATH)) {
    console.log("--- AI Summaries: no data file, skipping ---\n");
    return;
  }

  const summaries = JSON.parse(fs.readFileSync(SUMMARIES_PATH, "utf-8")) as Record<
    string,
    { title: string; date: string; host?: string; summary: string; actionItems: string[] }
  >;

  let linked = 0;
  for (const [meetingId, s] of Object.entries(summaries)) {
    // Match people mentioned in the summary or title
    for (const [key, person] of Object.entries(index)) {
      const nameLower = person.name.toLowerCase();
      const firstName = nameLower.split(" ")[0];
      const lastName = nameLower.split(" ").slice(-1)[0];

      // Check if person is mentioned in meeting title, summary text, or host
      const searchText = `${s.title} ${s.summary} ${s.host || ""}`.toLowerCase();
      const mentioned =
        searchText.includes(nameLower) ||
        (firstName.length > 3 && searchText.includes(firstName)) ||
        // Check if person was in a meeting with this title
        person.meetings.some((m) => m.id === meetingId || m.topic.toLowerCase() === s.title.toLowerCase());

      if (mentioned) {
        // Avoid duplicates
        if (!person.aiSummaries) person.aiSummaries = [];
        if (!person.aiSummaries.some((a) => a.meetingId === meetingId)) {
          person.aiSummaries.push({
            meetingId,
            title: s.title,
            date: s.date,
            summary: s.summary.slice(0, 500),
            actionItems: s.actionItems.slice(0, 5),
          });
          linked++;
        }
      }
    }

    // Index into topics
    const titleLower = s.title.toLowerCase();
    for (const pattern of TOPIC_PATTERNS) {
      if (pattern.keywords.some((kw) => titleLower.includes(kw) || s.summary.toLowerCase().includes(kw))) {
        if (!topicIndex[pattern.name]) {
          topicIndex[pattern.name] = {
            name: pattern.name,
            meetings: [],
            transcriptSnippets: [],
            webexRooms: [],
            notionTasks: [],
            messageExcerpts: [],
            people: [],
          };
        }
        // Add summary action items as transcript-like snippets
        if (!topicIndex[pattern.name].transcriptSnippets.some((t) => t.topic === s.title && t.date === s.date)) {
          topicIndex[pattern.name].transcriptSnippets.push({
            topic: s.title,
            date: s.date,
            speakers: [],
            keyLines: s.actionItems.slice(0, 3),
          });
        }
      }
    }
  }

  console.log(`--- AI Summaries: ${Object.keys(summaries).length} meetings, ${linked} person links ---\n`);
}

async function main() {
  console.log("Building person index...\n");

  const index: PersonIndex = {};
  const topicIndex: TopicIndex = {};

  // Load existing indexes if available (incremental updates)
  if (fs.existsSync(INDEX_PATH)) {
    const existing = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    Object.assign(index, existing);
    console.log(`Loaded existing person index: ${Object.keys(index).length} people`);
  }
  if (fs.existsSync(TOPIC_INDEX_PATH)) {
    const existing = JSON.parse(fs.readFileSync(TOPIC_INDEX_PATH, "utf-8"));
    Object.assign(topicIndex, existing);
    console.log(`Loaded existing topic index: ${Object.keys(topicIndex).length} topics`);
  }
  console.log();

  await indexWebexPeople(index);
  await indexWebexRooms(index, topicIndex);
  await indexWebexDirectMessages(index);
  await indexWebexRecordings(index, topicIndex);
  await indexNotionTasks(index, topicIndex);
  await indexAiSummaries(index, topicIndex);
  await fetchAvatars(index);

  // Merge duplicates
  const merged = mergeIndex(index);

  // Sort by interaction count
  const sorted = Object.fromEntries(
    Object.entries(merged).sort(
      ([, a], [, b]) =>
        b.meetings.length +
        b.transcriptMentions.length +
        b.messageExcerpts.length +
        b.notionTasks.length +
        (b.aiSummaries?.length || 0) -
        (a.meetings.length +
          a.transcriptMentions.length +
          a.messageExcerpts.length +
          a.notionTasks.length +
          (a.aiSummaries?.length || 0))
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

  // --- Save and summarize topic index ---
  // Sort topics by total content
  const sortedTopics = Object.fromEntries(
    Object.entries(topicIndex).sort(
      ([, a], [, b]) =>
        b.meetings.length + b.notionTasks.length + b.transcriptSnippets.length + b.webexRooms.length -
        (a.meetings.length + a.notionTasks.length + a.transcriptSnippets.length + a.webexRooms.length)
    )
  );

  fs.writeFileSync(TOPIC_INDEX_PATH, JSON.stringify(sortedTopics, null, 2));

  console.log(`\n=== Topic Index Summary ===`);
  console.log(`Total topics: ${Object.keys(sortedTopics).length}`);
  for (const [key, t] of Object.entries(sortedTopics)) {
    const total = t.meetings.length + t.notionTasks.length + t.transcriptSnippets.length + t.webexRooms.length;
    console.log(
      `  ${t.name.padEnd(35)} ${total} items (${t.meetings.length} mtg, ${t.transcriptSnippets.length} trans, ${t.notionTasks.length} tasks, ${t.webexRooms.length} rooms, ${t.people.length} people)`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
