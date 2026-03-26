#!/usr/bin/env osascript -l JavaScript

/**
 * Outlook Email Scanner → Notion Task Creator
 *
 * Runs on the corp macOS laptop. Reads recent actionable emails from
 * Outlook via JXA (JavaScript for Automation), creates Notion tasks
 * for items that need attention.
 *
 * Setup:
 *   1. Set NOTION_API_KEY environment variable (or edit the fallback below)
 *   2. Run: osascript -l JavaScript outlook-scanner.js
 *   3. Optional: schedule via launchd or cron on the corp laptop
 *
 * No data flows through NanoClaw — this script talks directly to Notion.
 * Mission Control picks up the tasks on its next index rebuild.
 */

// === Configuration ===

const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const NOTION_API_KEY = $.NSProcessInfo.processInfo.environment.objectForKey("NOTION_API_KEY").js;
const LOOKBACK_HOURS = 4;
const MAX_EMAILS = 50;
const MY_EMAIL = "jasheare@cisco.com";
const MY_NAME = "Jason Shearer";

// People whose emails are always worth tracking
const VIP_SENDERS = [
  "marcemon@cisco.com",  // Marcela
  "jlovisol@cisco.com",  // Jake Lovisolo
  "tfeldgoi@cisco.com",  // Thea Feldgoise
  "brduque@cisco.com",   // Bryan Duque
  "rsweetzi@cisco.com",  // Ross Sweetzir
  "rsia@cisco.com",      // Rodney Sia
];

// State file to avoid duplicates
const STATE_FILE = $.NSString.stringWithString(
  $.NSHomeDirectory().js + "/.outlook-scanner-state.json"
);

// === Helpers ===

function loadState() {
  try {
    const data = $.NSString.stringWithContentsOfFileEncodingError(STATE_FILE, $.NSUTF8StringEncoding, null);
    return JSON.parse(data.js);
  } catch {
    return { processedIds: [], lastRun: null };
  }
}

function saveState(state) {
  // Keep last 500 IDs to prevent unbounded growth
  state.processedIds = state.processedIds.slice(-500);
  state.lastRun = new Date().toISOString();
  const json = $.NSString.stringWithString(JSON.stringify(state, null, 2));
  json.writeToFileAtomicallyEncodingError(STATE_FILE, true, $.NSUTF8StringEncoding, null);
}

function notionPost(endpoint, body) {
  const url = $.NSURL.URLWithString("https://api.notion.com/v1" + endpoint);
  const request = $.NSMutableURLRequest.requestWithURL(url);
  request.setHTTPMethod("POST");
  request.setValueForHTTPHeaderField("application/json", "Content-Type");
  request.setValueForHTTPHeaderField("2022-06-28", "Notion-Version");
  request.setValueForHTTPHeaderField("Bearer " + NOTION_API_KEY, "Authorization");
  request.setHTTPBody($.NSString.stringWithString(JSON.stringify(body))
    .dataUsingEncoding($.NSUTF8StringEncoding));

  let response = Ref();
  let error = Ref();
  const data = $.NSURLConnection.sendSynchronousRequestReturningResponseError(
    request, response, error
  );

  if (data) {
    const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    return JSON.parse(text.js);
  }
  return { error: "Request failed" };
}

function createNotionTask(subject, sender, senderEmail, dateStr, bodyPreview, reason) {
  const timestamp = new Date(dateStr).toLocaleDateString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  });

  // Infer priority from heuristics
  let priority = "P2 — This Month";
  if (reason.includes("flagged") || reason.includes("unanswered")) priority = "P1 — This Week";
  if (reason.includes("urgent") || reason.includes("direct ask")) priority = "P0 — Today";

  // Infer context
  let context = "Quick Win";
  if (bodyPreview.length > 500 || subject.toLowerCase().includes("review")) context = "Deep Work";

  const notes = [
    `From: ${sender} (${senderEmail}) on ${timestamp}`,
    `Reason: ${reason}`,
    bodyPreview ? `\nPreview: ${bodyPreview.substring(0, 300)}` : "",
  ].filter(Boolean).join("\n");

  const result = notionPost("/pages", {
    parent: { database_id: NOTION_DB },
    properties: {
      Task: { title: [{ text: { content: `Reply to ${sender}: ${subject}` } }] },
      Priority: { select: { name: priority } },
      Status: { status: { name: "Not started" } },
      Context: { select: { name: context } },
      Zone: { select: { name: "Air-Gapped" } },
      Source: { select: { name: "Email" } },
      Project: { select: { name: "Cisco" } },
      "Delegated To": { select: { name: "Jason" } },
      Notes: { rich_text: [{ type: "text", text: { content: notes } }] },
    },
  });

  return result;
}

// === Sensitivity filter ===

function isSensitive(subject, body) {
  const text = (subject + " " + body).toLowerCase();
  const patterns = [
    "confidential", "nda", "compensation", "salary", "bonus",
    "acquisition", "merger", "deal value", "revenue target",
    "stock", "rsu", "equity", "pip ", "performance improvement",
    "termination", "layoff", "reorg",
  ];
  return patterns.some(p => text.includes(p));
}

// === Main ===

function run() {
  ObjC.import("Foundation");

  if (!NOTION_API_KEY) {
    console.log("ERROR: Set NOTION_API_KEY environment variable");
    return "Set NOTION_API_KEY";
  }

  const state = loadState();
  const processedSet = new Set(state.processedIds);

  // Get Outlook app
  const outlook = Application("Microsoft Outlook");

  if (!outlook.running()) {
    console.log("Outlook is not running — skipping");
    return "Outlook not running";
  }

  // Calculate lookback time
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  // Get inbox messages
  const inbox = outlook.inbox;
  const messages = inbox.messages.whose({
    timeReceived: { _greaterThan: since }
  });

  const count = messages.length;
  console.log(`Found ${count} emails in last ${LOOKBACK_HOURS}h`);

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < Math.min(count, MAX_EMAILS); i++) {
    try {
      const msg = messages[i];
      const msgId = msg.id().toString();

      // Skip already processed
      if (processedSet.has(msgId)) { skipped++; continue; }

      const subject = msg.subject() || "(no subject)";
      const sender = msg.sender().name() || "Unknown";
      const senderEmail = (msg.sender().address() || "").toLowerCase();
      const dateReceived = msg.timeReceived();
      const isRead = msg.isRead();
      const isFlagged = msg.flagged ? msg.flagged() : false;
      const body = (msg.plainTextContent() || "").substring(0, 1000);

      // Skip my own sent items that might appear
      if (senderEmail === MY_EMAIL) { state.processedIds.push(msgId); continue; }

      // Sensitivity filter
      if (isSensitive(subject, body)) {
        state.processedIds.push(msgId);
        continue;
      }

      // Check if I'm in the To line (not just CC)
      let isDirectTo = false;
      try {
        const toRecips = msg.toRecipients();
        for (let r = 0; r < toRecips.length; r++) {
          if ((toRecips[r].address() || "").toLowerCase() === MY_EMAIL) {
            isDirectTo = true;
            break;
          }
        }
      } catch { /* some messages may not have parseable recipients */ }

      // Determine if this email is actionable
      let reason = null;

      // 1. Flagged emails — always actionable
      if (isFlagged) {
        reason = "flagged";
      }
      // 2. VIP senders — always track
      else if (VIP_SENDERS.includes(senderEmail)) {
        reason = "VIP sender";
      }
      // 3. Unread, directly addressed to me, looks like a question or request
      else if (!isRead && isDirectTo) {
        const lowerBody = body.toLowerCase();
        const hasQuestion = lowerBody.includes("?") ||
          lowerBody.includes("can you") ||
          lowerBody.includes("could you") ||
          lowerBody.includes("please") ||
          lowerBody.includes("would you") ||
          lowerBody.includes("need your") ||
          lowerBody.includes("your thoughts") ||
          lowerBody.includes("your input") ||
          lowerBody.includes("follow up") ||
          lowerBody.includes("action item") ||
          lowerBody.includes("by eod") ||
          lowerBody.includes("by end of") ||
          lowerBody.includes("asap");
        if (hasQuestion) {
          reason = "direct ask / question";
        }
      }
      // 4. Meeting-related emails (agenda, prep, follow-up)
      else if (isDirectTo) {
        const lowerSubject = subject.toLowerCase();
        if (lowerSubject.includes("agenda") ||
            lowerSubject.includes("prep") ||
            lowerSubject.includes("follow up") ||
            lowerSubject.includes("action item") ||
            lowerSubject.includes("minutes") ||
            lowerSubject.includes("recap")) {
          reason = "meeting-related";
        }
      }

      // Mark as processed regardless
      state.processedIds.push(msgId);

      if (!reason) continue;

      // Create the Notion task
      console.log(`  [${reason}] ${sender}: ${subject.substring(0, 60)}`);
      const result = createNotionTask(subject, sender, senderEmail, dateReceived, body, reason);

      if (result.id) {
        created++;
      } else {
        console.log(`  ERROR: ${JSON.stringify(result).substring(0, 200)}`);
      }

    } catch (e) {
      console.log(`  Error processing message ${i}: ${e}`);
    }
  }

  saveState(state);

  const summary = `Scanned ${count} emails, created ${created} tasks, skipped ${skipped} already processed`;
  console.log(`\n${summary}`);
  return summary;
}

run();
