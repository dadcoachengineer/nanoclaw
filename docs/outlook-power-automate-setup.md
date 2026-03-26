# Outlook → Mission Control via Power Automate

## Overview

Three Power Automate flows that scan your Outlook inbox and create Notion tasks in Mission Control. Each flow handles a different heuristic. They run automatically — no clicks needed.

**What you need:**
- Power Automate access (flow.microsoft.com)
- A Notion API key (from notion.so/my-integrations)
- Your Mission Control database ID: `5b4e1d2d7259496ea237ef0525c3ce78`

---

## Step 0: Create a Notion Integration

1. Go to **notion.so/my-integrations**
2. Click **New integration**
3. Name: `Outlook Scanner`
4. Associated workspace: your workspace
5. Copy the **Internal Integration Secret** (starts with `secret_`)
6. Go to your Mission Control database in Notion
7. Click **...** → **Connections** → **Connect to** → select `Outlook Scanner`

---

## Flow 1: Flagged Emails

Catches any email you flag in Outlook.

### Setup

1. Go to **flow.microsoft.com** → **Create** → **Automated cloud flow**
2. Name: `MC: Flagged Emails`
3. Trigger: **When an email is flagged (V3)** (Office 365 Outlook)
   - Folder: Inbox
4. Add action: **HTTP**
   - Method: `POST`
   - URI: `https://api.notion.com/v1/pages`
   - Headers:
     - `Authorization`: `Bearer secret_YOUR_KEY_HERE`
     - `Content-Type`: `application/json`
     - `Notion-Version`: `2022-06-28`
   - Body:
```json
{
  "parent": { "database_id": "5b4e1d2d7259496ea237ef0525c3ce78" },
  "properties": {
    "Task": { "title": [{ "text": { "content": "Reply to @{triggerOutputs()?['body/from']} re: @{triggerOutputs()?['body/subject']}" } }] },
    "Priority": { "select": { "name": "P1 — This Week" } },
    "Status": { "status": { "name": "Not started" } },
    "Context": { "select": { "name": "Quick Win" } },
    "Zone": { "select": { "name": "Air-Gapped" } },
    "Source": { "select": { "name": "Email" } },
    "Project": { "select": { "name": "Cisco" } },
    "Delegated To": { "select": { "name": "Jason" } },
    "Notes": { "rich_text": [{ "type": "text", "text": { "content": "From: @{triggerOutputs()?['body/from']} on @{triggerOutputs()?['body/receivedDateTime']}\nFlagged in Outlook\n\nPreview: @{substring(triggerOutputs()?['body/bodyPreview'], 0, min(length(triggerOutputs()?['body/bodyPreview']), 300))}" } }] }
  }
}
```
5. **Save** and **Turn on**

---

## Flow 2: Direct Questions & Requests

Catches emails sent directly to you (not CC) that contain questions or action requests.

### Setup

1. **Create** → **Automated cloud flow**
2. Name: `MC: Direct Asks`
3. Trigger: **When a new email arrives (V3)** (Office 365 Outlook)
   - Folder: Inbox
   - To: `jasheare@cisco.com`
   - Include Attachments: No
   - Only with Importance: Normal, High
4. Add action: **Condition**
   - Check if body contains any action phrase. Use an **OR** group:
     - `body/bodyPreview` contains `?`
     - `body/bodyPreview` contains `can you`
     - `body/bodyPreview` contains `could you`
     - `body/bodyPreview` contains `please`
     - `body/bodyPreview` contains `your thoughts`
     - `body/bodyPreview` contains `action item`
     - `body/bodyPreview` contains `follow up`
     - `body/bodyPreview` contains `by EOD`
     - `body/bodyPreview` contains `ASAP`
5. In the **If yes** branch, add action: **HTTP** (same as Flow 1 but with these changes):
   - Body changes:
     - Priority: `"P0 — Today"` (direct asks are urgent)
     - Notes: change "Flagged in Outlook" to `"Direct ask / question detected"`
6. In the **If no** branch: leave empty (do nothing)
7. **Save** and **Turn on**

---

## Flow 3: VIP Senders

Catches any email from key collaborators regardless of content.

### Setup

1. **Create** → **Automated cloud flow**
2. Name: `MC: VIP Emails`
3. Trigger: **When a new email arrives (V3)** (Office 365 Outlook)
   - Folder: Inbox
   - From: *(leave blank — we'll filter in a condition)*
4. Add action: **Condition**
   - Use an **OR** group:
     - `from` contains `marcemon@cisco.com`
     - `from` contains `jlovisol@cisco.com`
     - `from` contains `tfeldgoi@cisco.com`
     - `from` contains `brduque@cisco.com`
     - `from` contains `rsweetzi@cisco.com`
     - `from` contains `rsia@cisco.com`
5. In the **If yes** branch, add: **HTTP** (same pattern):
   - Priority: `"P1 — This Week"`
   - Notes: `"VIP sender — @{triggerOutputs()?['body/from']}"`
6. **Save** and **Turn on**

---

## Flow 4 (Optional): Meeting-Related Emails

Catches agenda, recap, minutes, and follow-up emails.

### Setup

1. **Create** → **Automated cloud flow**
2. Name: `MC: Meeting Emails`
3. Trigger: **When a new email arrives (V3)**
   - Folder: Inbox
   - To: `jasheare@cisco.com`
4. Add action: **Condition** (OR group):
   - `subject` contains `agenda`
   - `subject` contains `recap`
   - `subject` contains `minutes`
   - `subject` contains `action item`
   - `subject` contains `follow up`
   - `subject` contains `prep`
5. **If yes** → **HTTP** with:
   - Priority: `"P1 — This Week"`
   - Context: `"Deep Work"` (meeting prep usually needs focus)
   - Notes: `"Meeting-related email"`
6. **Save** and **Turn on**

---

## Sensitivity Filter

To avoid capturing sensitive emails, add a **Condition** at the top of each flow (before the HTTP action) that checks the subject + body do NOT contain:

- `confidential`
- `compensation`
- `salary`
- `NDA`
- `acquisition`
- `merger`
- `deal value`
- `termination`
- `reorg`

Set this as an **AND** group of "does not contain" checks. Put the HTTP action inside the **If yes** (passed filter) branch.

---

## Deduplication

Power Automate triggers on each new email, so duplicates are rare. However, if the same email thread triggers multiple flows (e.g., a flagged VIP email), you may get duplicate tasks. To handle this:

1. Add a **Search** step before creating: HTTP GET to Notion API searching for the subject line
2. Only create if no matching task exists

Or just accept occasional duplicates — they're easy to spot and mark done in Mission Control.

---

## Testing

1. Send yourself a test email with "Can you review this?" in the body
2. Wait 1-2 minutes (Power Automate triggers aren't instant)
3. Check Mission Control — the task should appear with Source: Email, Zone: Air-Gapped

---

## What Happens Next

Once tasks land in Notion:
- Mission Control's hourly index rebuild picks them up
- They appear in Today's Action Items (filtered by priority)
- They correlate with Webex context (same people → linked in People view)
- The morning briefing agent includes them in the daily brief
- They can be assigned to Initiatives from the task modal

No data flows through NanoClaw. Power Automate reads your mailbox (server-side in Microsoft's cloud) and writes to Notion (SaaS). The Mac Mini only reads from Notion.
