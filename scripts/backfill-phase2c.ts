/**
 * Phase 2c: Backfill person-index.json to normalized PostgreSQL tables.
 * This is the largest migration — denormalized JSON blob → relational tables.
 */
import pg from "pg";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "store");
const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });
  console.log("Phase 2c: Backfilling person-index.json → PostgreSQL\n");

  const index = JSON.parse(fs.readFileSync(path.join(STORE_DIR, "person-index.json"), "utf-8"));
  const entries = Object.entries(index) as [string, any][];

  let people = 0, emails = 0, rooms = 0, meetingsCreated = 0, participants = 0;
  let mentions = 0, excerpts = 0;
  const meetingIds = new Set<string>();

  for (const [key, person] of entries) {
    // 1. Insert person
    const result = await pool.query(
      `INSERT INTO people (key, name, company, job_title, avatar, linkedin_url, linkedin_headline, profile_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key) DO UPDATE SET
         name = $2, company = COALESCE($3, people.company), job_title = COALESCE($4, people.job_title),
         avatar = COALESCE($5, people.avatar), updated_at = now()
       RETURNING id`,
      [key, person.name, person.company || null, person.jobTitle || null,
       person.avatar || null, person.linkedinUrl || null, person.linkedinHeadline || null,
       person.profileNotes || null]
    );
    const personId = result.rows[0].id;
    people++;

    // 2. Emails
    for (const email of person.emails || []) {
      try {
        await pool.query(
          "INSERT INTO person_emails (person_id, email, is_primary) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [personId, email.toLowerCase(), emails === 0]
        );
        emails++;
      } catch {}
    }

    // 3. Webex rooms
    for (const roomId of person.webexRoomIds || []) {
      try {
        await pool.query(
          "INSERT INTO person_webex_rooms (person_id, room_id, room_type) VALUES ($1, $2, 'direct') ON CONFLICT DO NOTHING",
          [personId, roomId]
        );
        rooms++;
      } catch {}
    }
    for (const roomId of person.webexGroupRooms || []) {
      try {
        await pool.query(
          "INSERT INTO person_webex_rooms (person_id, room_id, room_type) VALUES ($1, $2, 'group') ON CONFLICT DO NOTHING",
          [personId, roomId]
        );
        rooms++;
      } catch {}
    }

    // 4. Meetings + participation
    for (const mtg of person.meetings || []) {
      const meetingId = mtg.id || `${mtg.topic}-${mtg.date}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 100);
      if (!meetingIds.has(meetingId)) {
        try {
          await pool.query(
            `INSERT INTO meetings (id, topic, date, source) VALUES ($1, $2, $3, 'webex')
             ON CONFLICT (id) DO NOTHING`,
            [meetingId, mtg.topic || "Unknown", mtg.date || "2026-01-01"]
          );
          meetingIds.add(meetingId);
          meetingsCreated++;
        } catch {}
      }
      try {
        await pool.query(
          "INSERT INTO meeting_participants (meeting_id, person_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [meetingId, personId, mtg.role || "attendee"]
        );
        participants++;
      } catch {}
    }

    // 5. Transcript mentions
    for (const tm of person.transcriptMentions || []) {
      const meetingId = tm.recordingId || `${tm.topic}-${tm.date}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 100);
      // Ensure meeting exists
      if (!meetingIds.has(meetingId)) {
        try {
          await pool.query(
            `INSERT INTO meetings (id, topic, date, source) VALUES ($1, $2, $3, 'webex')
             ON CONFLICT (id) DO NOTHING`,
            [meetingId, tm.topic || "Unknown", tm.date || "2026-01-01"]
          );
          meetingIds.add(meetingId);
          meetingsCreated++;
        } catch {}
      }
      try {
        await pool.query(
          `INSERT INTO transcript_mentions (person_id, meeting_id, snippet_count, snippets)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (person_id, meeting_id) DO NOTHING`,
          [personId, meetingId, tm.snippetCount || (tm.snippets || []).length, tm.snippets || []]
        );
        mentions++;
      } catch {}
    }

    // 6. Message excerpts
    for (const msg of person.messageExcerpts || []) {
      try {
        await pool.query(
          `INSERT INTO message_excerpts (person_id, text, date, room_title)
           VALUES ($1, $2, $3, $4)`,
          [personId, msg.text, msg.date, msg.roomTitle || null]
        );
        excerpts++;
      } catch {}
    }

    if (people % 50 === 0) console.log(`  Progress: ${people}/${entries.length} people...`);
  }

  console.log(`\n  people: ${people}`);
  console.log(`  person_emails: ${emails}`);
  console.log(`  person_webex_rooms: ${rooms}`);
  console.log(`  meetings: ${meetingsCreated}`);
  console.log(`  meeting_participants: ${participants}`);
  console.log(`  transcript_mentions: ${mentions}`);
  console.log(`  message_excerpts: ${excerpts}`);

  console.log("\nDone.");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
