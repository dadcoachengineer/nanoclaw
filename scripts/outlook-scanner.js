#!/usr/bin/env osascript -l JavaScript

/**
 * Outlook Email Scanner → Notion Task Creator
 *
 * Runs on the corp macOS laptop. Reads recent actionable emails from
 * Outlook via JXA (JavaScript for Automation), creates Notion tasks.
 *
 * Setup:
 *   1. Set NOTION_API_KEY environment variable
 *   2. Run: NOTION_API_KEY=secret_xxx osascript -l JavaScript outlook-scanner.js
 *   3. Schedule via launchd (see outlook-scanner-launchd.plist)
 */

ObjC.import("Foundation");

// === Configuration ===

var NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
var NOTION_API_KEY = $.NSProcessInfo.processInfo.environment.objectForKey("NOTION_API_KEY").js;
var LOOKBACK_HOURS = 4;
var MAX_EMAILS = 50;
var MY_EMAIL = "jasheare@cisco.com";

var VIP_SENDERS = [
  "marcemon@cisco.com",
  "jlovisol@cisco.com",
  "tfeldgoi@cisco.com",
  "brduque@cisco.com",
  "rsweetzi@cisco.com",
  "rsia@cisco.com"
];

var STATE_PATH = $.NSHomeDirectory().js + "/.outlook-scanner-state.json";

// === Helpers ===

function log(msg) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(
    $.NSString.stringWithString(msg + "\n").dataUsingEncoding($.NSUTF8StringEncoding)
  );
}

function arrayContains(arr, val) {
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === val) return true;
  }
  return false;
}

function textContains(text, pattern) {
  return text.indexOf(pattern) !== -1;
}

function loadState() {
  try {
    var data = $.NSString.stringWithContentsOfFileEncodingError(
      $.NSString.stringWithString(STATE_PATH), $.NSUTF8StringEncoding, null
    );
    return JSON.parse(data.js);
  } catch (e) {
    return { processedIds: [], lastRun: null };
  }
}

function saveState(state) {
  if (state.processedIds.length > 500) {
    state.processedIds = state.processedIds.slice(state.processedIds.length - 500);
  }
  state.lastRun = new Date().toISOString();
  var json = $.NSString.stringWithString(JSON.stringify(state, null, 2));
  json.writeToFileAtomicallyEncodingError(
    $.NSString.stringWithString(STATE_PATH), true, $.NSUTF8StringEncoding, null
  );
}

function notionPost(endpoint, body) {
  var url = $.NSURL.URLWithString("https://api.notion.com/v1" + endpoint);
  var request = $.NSMutableURLRequest.requestWithURL(url);
  request.setHTTPMethod("POST");
  request.setValueForHTTPHeaderField("application/json", "Content-Type");
  request.setValueForHTTPHeaderField("2022-06-28", "Notion-Version");
  request.setValueForHTTPHeaderField("Bearer " + NOTION_API_KEY, "Authorization");
  request.setHTTPBody(
    $.NSString.stringWithString(JSON.stringify(body)).dataUsingEncoding($.NSUTF8StringEncoding)
  );

  var response = Ref();
  var error = Ref();
  var data = $.NSURLConnection.sendSynchronousRequestReturningResponseError(
    request, response, error
  );

  if (data) {
    var text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    return JSON.parse(text.js);
  }
  return { error: "Request failed" };
}

// === Sensitivity filter ===

function isSensitive(subject, body) {
  var text = (subject + " " + body).toLowerCase();
  var patterns = [
    "confidential", "nda", "compensation", "salary", "bonus",
    "acquisition", "merger", "deal value", "revenue target",
    "stock", "rsu", "equity", "pip ", "performance improvement",
    "termination", "layoff", "reorg"
  ];
  for (var i = 0; i < patterns.length; i++) {
    if (textContains(text, patterns[i])) return true;
  }
  return false;
}

// === Task creation ===

function createNotionTask(subject, sender, senderEmail, dateStr, bodyPreview, reason) {
  var d = new Date(dateStr);
  var timestamp = (d.getMonth() + 1) + "/" + d.getDate() + " " + d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");

  var priority = "P2 \u2014 This Month";
  if (textContains(reason, "flagged") || textContains(reason, "unanswered")) {
    priority = "P1 \u2014 This Week";
  }
  if (textContains(reason, "urgent") || textContains(reason, "direct ask")) {
    priority = "P0 \u2014 Today";
  }

  var context = "Quick Win";
  if (bodyPreview.length > 500 || textContains(subject.toLowerCase(), "review")) {
    context = "Deep Work";
  }

  var notes = "From: " + sender + " (" + senderEmail + ") on " + timestamp +
    "\nReason: " + reason;
  if (bodyPreview) {
    notes = notes + "\n\nPreview: " + bodyPreview.substring(0, 300);
  }

  var taskTitle = "Reply to " + sender + ": " + subject;

  var result = notionPost("/pages", {
    parent: { database_id: NOTION_DB },
    properties: {
      Task: { title: [{ text: { content: taskTitle } }] },
      Priority: { select: { name: priority } },
      Status: { status: { name: "Not started" } },
      Context: { select: { name: context } },
      Zone: { select: { name: "Air-Gapped" } },
      Source: { select: { name: "Email" } },
      Project: { select: { name: "Cisco" } },
      "Delegated To": { select: { name: "Jason" } },
      Notes: { rich_text: [{ type: "text", text: { content: notes } }] }
    }
  });

  return result;
}

// === Main ===

function run() {
  if (!NOTION_API_KEY) {
    log("ERROR: Set NOTION_API_KEY environment variable");
    return "Set NOTION_API_KEY";
  }

  var state = loadState();
  var processedIds = state.processedIds;

  var outlook;
  try {
    outlook = Application("Microsoft Outlook");
  } catch (e) {
    log("Cannot connect to Outlook: " + e);
    return "Cannot connect to Outlook";
  }

  if (!outlook.running()) {
    log("Outlook is not running — skipping");
    return "Outlook not running";
  }

  var since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  var inbox = outlook.inbox;
  var messages = inbox.messages.whose({ timeReceived: { _greaterThan: since } });
  var count = messages.length;
  log("Found " + count + " emails in last " + LOOKBACK_HOURS + "h");

  var created = 0;
  var skipped = 0;
  var limit = Math.min(count, MAX_EMAILS);

  for (var i = 0; i < limit; i++) {
    try {
      var msg = messages[i];
      var msgId = msg.id().toString();

      if (arrayContains(processedIds, msgId)) {
        skipped++;
        continue;
      }

      var subject = msg.subject() || "(no subject)";
      var sender = msg.sender().name() || "Unknown";
      var senderEmail = (msg.sender().address() || "").toLowerCase();
      var dateReceived = msg.timeReceived();
      var isRead = msg.isRead();
      var body = (msg.plainTextContent() || "").substring(0, 1000);

      var isFlagged = false;
      try { isFlagged = msg.flagged(); } catch (e2) { /* ignore */ }

      // Skip own emails
      if (senderEmail === MY_EMAIL) {
        processedIds.push(msgId);
        continue;
      }

      // Sensitivity filter
      if (isSensitive(subject, body)) {
        processedIds.push(msgId);
        continue;
      }

      // Check if directly addressed to me
      var isDirectTo = false;
      try {
        var toRecips = msg.toRecipients();
        for (var r = 0; r < toRecips.length; r++) {
          if ((toRecips[r].address() || "").toLowerCase() === MY_EMAIL) {
            isDirectTo = true;
            break;
          }
        }
      } catch (e3) { /* ignore */ }

      // Determine if actionable
      var reason = null;

      if (isFlagged) {
        reason = "flagged";
      } else if (arrayContains(VIP_SENDERS, senderEmail)) {
        reason = "VIP sender";
      } else if (!isRead && isDirectTo) {
        var lowerBody = body.toLowerCase();
        if (textContains(lowerBody, "?") ||
            textContains(lowerBody, "can you") ||
            textContains(lowerBody, "could you") ||
            textContains(lowerBody, "please") ||
            textContains(lowerBody, "would you") ||
            textContains(lowerBody, "need your") ||
            textContains(lowerBody, "your thoughts") ||
            textContains(lowerBody, "your input") ||
            textContains(lowerBody, "follow up") ||
            textContains(lowerBody, "action item") ||
            textContains(lowerBody, "by eod") ||
            textContains(lowerBody, "by end of") ||
            textContains(lowerBody, "asap")) {
          reason = "direct ask / question";
        }
      } else if (isDirectTo) {
        var lowerSubject = subject.toLowerCase();
        if (textContains(lowerSubject, "agenda") ||
            textContains(lowerSubject, "prep") ||
            textContains(lowerSubject, "follow up") ||
            textContains(lowerSubject, "action item") ||
            textContains(lowerSubject, "minutes") ||
            textContains(lowerSubject, "recap")) {
          reason = "meeting-related";
        }
      }

      processedIds.push(msgId);
      if (!reason) continue;

      log("  [" + reason + "] " + sender + ": " + subject.substring(0, 60));
      var result = createNotionTask(subject, sender, senderEmail, dateReceived, body, reason);

      if (result.id) {
        created++;
      } else {
        log("  ERROR: " + JSON.stringify(result).substring(0, 200));
      }

    } catch (e4) {
      log("  Error processing message " + i + ": " + e4);
    }
  }

  state.processedIds = processedIds;
  saveState(state);

  var summary = "Scanned " + count + " emails, created " + created + " tasks, skipped " + skipped + " already processed";
  log(summary);
  return summary;
}

run();
