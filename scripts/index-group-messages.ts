/**
 * Index Webex group space messages into the person index.
 *
 * Fetches group rooms where Jason is mentioned, then indexes each message
 * sender into the person index with their message excerpts and group room IDs.
 *
 * Usage: npx tsx scripts/index-group-messages.ts
 */
import fs from "fs";
import path from "path";

const STORE_DIR = path.join(process.cwd(), "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const WEBEX_OAUTH_PATH = path.join(STORE_DIR, "webex-oauth.json");
const JASON_PERSON_ID =
  "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9iY2JjNTU0ZC0yNGZlLTQwNDUtYjQwMy1lZTQxZDcyZjVlYWM";

// --- Types (matching build-person-index.ts) ---

interface PersonEntry {
  name: string;
  emails: string[];
  avatar?: string;
  webexRoomIds: string[];
  webexGroupRooms: string[];
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

// --- Helpers ---

function normalizeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getOrCreate(index: PersonIndex, name: string): PersonEntry {
  const key = normalizeKey(name);
  if (!key)
    return {
      name,
      emails: [],
      webexRoomIds: [],
      webexGroupRooms: [],
      meetings: [],
      transcriptMentions: [],
      notionTasks: [],
      messageExcerpts: [],
    };
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
  if (name.length > index[key].name.length) index[key].name = name;
  return index[key];
}

function addUnique<T>(arr: T[], item: T): void {
  if (!arr.includes(item)) arr.push(item);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main() {
  // 1. Load person index
  if (!fs.existsSync(INDEX_PATH)) {
    console.error(`Person index not found at ${INDEX_PATH}`);
    process.exit(1);
  }
  const index: PersonIndex = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  console.log(`Loaded person index: ${Object.keys(index).length} people\n`);

  // 2. Load Webex token
  if (!fs.existsSync(WEBEX_OAUTH_PATH)) {
    console.error(`Webex OAuth config not found at ${WEBEX_OAUTH_PATH}`);
    process.exit(1);
  }
  const webexConfig = JSON.parse(fs.readFileSync(WEBEX_OAUTH_PATH, "utf-8"));
  const WEBEX_TOKEN: string = webexConfig.access_token;

  async function webexGet(apiPath: string): Promise<unknown> {
    const resp = await fetch(`https://webexapis.com/v1${apiPath}`, {
      headers: { Authorization: `Bearer ${WEBEX_TOKEN}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Webex API ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp.json();
  }

  // 3. Fetch group rooms
  console.log("Fetching group rooms...");
  const roomsData = (await webexGet(
    "/rooms?type=group&sortBy=lastactivity&max=37"
  )) as { items?: { id: string; title: string; type: string }[] };

  const rooms = roomsData.items || [];
  console.log(`Found ${rooms.length} group rooms\n`);

  await sleep(300);

  // 4. For each group room, fetch messages mentioning Jason
  let totalMessagesIndexed = 0;
  let roomsScanned = 0;

  for (const room of rooms) {
    roomsScanned++;
    const roomLabel = `[${roomsScanned}/${rooms.length}] ${room.title.slice(0, 60)}`;
    console.log(`${roomLabel}`);

    try {
      const msgsData = (await webexGet(
        `/messages?roomId=${encodeURIComponent(room.id)}&mentionedPeople=${JASON_PERSON_ID}&max=10`
      )) as {
        items?: {
          id: string;
          text: string;
          personEmail: string;
          personId: string;
          created: string;
        }[];
      };

      const messages = msgsData.items || [];
      let roomMsgCount = 0;

      for (const msg of messages) {
        if (!msg.text || msg.text.length < 3) continue;

        // Skip messages from Jason himself
        if (
          msg.personEmail === "jasheare@cisco.com" ||
          msg.personId === JASON_PERSON_ID
        )
          continue;

        // 5. Look up the sender in the person index by email
        let entry: PersonEntry | null = null;
        let senderKey: string | null = null;

        // Search by email
        for (const [key, person] of Object.entries(index)) {
          if (person.emails.includes(msg.personEmail)) {
            entry = person;
            senderKey = key;
            break;
          }
        }

        if (!entry) {
          // Person not in index — look up their display name from Webex
          try {
            const personData = (await webexGet(
              `/people/${msg.personId}`
            )) as { displayName?: string; emails?: string[] };

            await sleep(300);

            const displayName = personData.displayName || msg.personEmail.split("@")[0];
            entry = getOrCreate(index, displayName);
            addUnique(entry.emails, msg.personEmail);
            if (personData.emails) {
              for (const e of personData.emails) addUnique(entry.emails, e);
            }
            console.log(`  + New person: ${displayName} (${msg.personEmail})`);
          } catch {
            // Fall back to email-based entry
            const fallbackName = msg.personEmail.split("@")[0].replace(/[._]/g, " ");
            entry = getOrCreate(index, fallbackName);
            addUnique(entry.emails, msg.personEmail);
            console.log(`  + New person (fallback): ${fallbackName} (${msg.personEmail})`);
          }
        }

        // Dedup by date + text prefix
        const dedupKey = `${msg.created}:${msg.text.slice(0, 50)}`;
        if (
          entry.messageExcerpts.some(
            (e) => `${e.date}:${e.text.slice(0, 50)}` === dedupKey
          )
        ) {
          continue;
        }

        // Add message excerpt
        entry.messageExcerpts.push({
          text: msg.text.slice(0, 300),
          date: msg.created,
          roomTitle: room.title,
        });
        roomMsgCount++;
        totalMessagesIndexed++;

        // 6. Add group room to webexGroupRooms
        addUnique(entry.webexGroupRooms, room.id);
      }

      if (roomMsgCount > 0) {
        console.log(`  ${roomMsgCount} messages indexed`);
      } else {
        console.log(`  (no new messages)`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`  ERROR: ${errMsg.slice(0, 120)}`);
    }

    // 7. Rate limit
    await sleep(300);
  }

  // 8. Save updated person index
  // Sort by interaction count (same as build-person-index.ts)
  const sorted = Object.fromEntries(
    Object.entries(index).sort(
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
  console.log(`\nSaved person index to ${INDEX_PATH}`);

  // 9. Summary
  console.log(`\n=== Group Message Indexing Summary ===`);
  console.log(`Group rooms scanned: ${roomsScanned}`);
  console.log(`Messages indexed: ${totalMessagesIndexed}`);
  console.log(`Total people in index: ${Object.keys(sorted).length}`);

  const withGroupRooms = Object.values(sorted).filter(
    (p) => p.webexGroupRooms.length > 0
  );
  console.log(`People with group rooms: ${withGroupRooms.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
