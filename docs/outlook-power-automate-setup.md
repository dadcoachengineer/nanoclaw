# Outlook → Mission Control via Power Automate + Webex

## Overview

Power Automate flows scan your Outlook inbox and post email summaries to a dedicated Webex space ("Email Triage"). The existing mc-webex-messages agent picks these up hourly and creates Notion tasks in Mission Control.

**Data path:** Power Automate → Webex (both Cisco infrastructure) → NanoClaw reads via Webex API → Notion

**What you need:**
- Power Automate access (flow.microsoft.com)
- Webex connector available in Power Automate
- The "Email Triage" Webex space (already created)

---

## Step 0: Email Triage Room ID

Use this Room ID in every Webex "Send a message" action:

```
Y2lzY29zcGFyazovL3VzL1JPT00vYTM1N2Y3OTAtMjk1Yi0xMWYxLTljMzAtZDExMmMxZGU0Yjhl
```

---

## Flow 1: Flagged Emails

Catches any email you flag in Outlook.

### Setup

1. Go to **flow.microsoft.com** → **Create** → **Automated cloud flow**
2. Name: `MC: Flagged Emails`
3. Trigger: **When an email is flagged (V3)** (Office 365 Outlook)
   - Folder: Inbox

4. Add action: **Condition** (sensitivity filter)
   - AND group — all must be true:
     - `subject` does not contain `confidential`
     - `subject` does not contain `NDA`
     - `subject` does not contain `compensation`
     - `subject` does not contain `salary`
     - `subject` does not contain `acquisition`
     - `subject` does not contain `termination`
     - `subject` does not contain `reorg`

5. In **If yes** branch, add: **Webex → Send a message**
   - Room ID: *paste the Email Triage room ID*
   - Message text:
   ```
   [EMAIL] From: @{triggerOutputs()?['body/from']}
   Subject: @{triggerOutputs()?['body/subject']}
   Reason: flagged
   Preview: @{substring(triggerOutputs()?['body/bodyPreview'], 0, min(length(triggerOutputs()?['body/bodyPreview']), 300))}
   ```

6. **Save** and **Turn on**

---

## Flow 2: Direct Questions & Requests

Catches emails sent directly to you that contain questions or action requests.

### Setup

1. **Create** → **Automated cloud flow**
2. Name: `MC: Direct Asks`
3. Trigger: **When a new email arrives (V3)** (Office 365 Outlook)
   - Folder: Inbox
   - To: `jasheare@cisco.com`
   - Only with Importance: Normal, High

4. Add action: **Condition** (sensitivity filter — same as Flow 1)

5. In **If yes**, add another **Condition** (action detection):
   - OR group — any must be true:
     - `bodyPreview` contains `?`
     - `bodyPreview` contains `can you`
     - `bodyPreview` contains `could you`
     - `bodyPreview` contains `please`
     - `bodyPreview` contains `would you`
     - `bodyPreview` contains `need your`
     - `bodyPreview` contains `your thoughts`
     - `bodyPreview` contains `your input`
     - `bodyPreview` contains `follow up`
     - `bodyPreview` contains `action item`
     - `bodyPreview` contains `by EOD`
     - `bodyPreview` contains `by end of`
     - `bodyPreview` contains `ASAP`

6. In the inner **If yes**, add: **Webex → Send a message**
   - Room ID: *Email Triage room ID*
   - Message text:
   ```
   [EMAIL] From: @{triggerOutputs()?['body/from']}
   Subject: @{triggerOutputs()?['body/subject']}
   Reason: direct ask
   Preview: @{substring(triggerOutputs()?['body/bodyPreview'], 0, min(length(triggerOutputs()?['body/bodyPreview']), 300))}
   ```

7. **Save** and **Turn on**

---

## Flow 3: VIP Senders

Catches any email from key collaborators.

### Setup

1. **Create** → **Automated cloud flow**
2. Name: `MC: VIP Emails`
3. Trigger: **When a new email arrives (V3)** (Office 365 Outlook)
   - Folder: Inbox

4. Add action: **Condition** (sensitivity filter — same as above)

5. In **If yes**, add **Condition** (VIP check):
   - OR group:
     - `from` contains `marcemon@cisco.com`
     - `from` contains `jlovisol@cisco.com`
     - `from` contains `tfeldgoi@cisco.com`
     - `from` contains `brduque@cisco.com`
     - `from` contains `rsweetzi@cisco.com`
     - `from` contains `rsia@cisco.com`

6. Inner **If yes** → **Webex → Send a message**
   - Room ID: *Email Triage room ID*
   - Message text:
   ```
   [EMAIL] From: @{triggerOutputs()?['body/from']}
   Subject: @{triggerOutputs()?['body/subject']}
   Reason: VIP sender
   Preview: @{substring(triggerOutputs()?['body/bodyPreview'], 0, min(length(triggerOutputs()?['body/bodyPreview']), 300))}
   ```

7. **Save** and **Turn on**

---

## Flow 4 (Optional): Meeting-Related Emails

### Setup

1. **Create** → **Automated cloud flow**
2. Name: `MC: Meeting Emails`
3. Trigger: **When a new email arrives (V3)**
   - Folder: Inbox
   - To: `jasheare@cisco.com`

4. Add: **Condition** (sensitivity filter)

5. In **If yes**, add **Condition** (meeting detection):
   - OR group:
     - `subject` contains `agenda`
     - `subject` contains `recap`
     - `subject` contains `minutes`
     - `subject` contains `action item`
     - `subject` contains `follow up`
     - `subject` contains `prep`

6. Inner **If yes** → **Webex → Send a message**
   - Room ID: *Email Triage room ID*
   - Message text:
   ```
   [EMAIL] From: @{triggerOutputs()?['body/from']}
   Subject: @{triggerOutputs()?['body/subject']}
   Reason: meeting-related
   Preview: @{substring(triggerOutputs()?['body/bodyPreview'], 0, min(length(triggerOutputs()?['body/bodyPreview']), 300))}
   ```

7. **Save** and **Turn on**

---

## How It Works End-to-End

```
Outlook Email
    ↓ (Power Automate trigger)
Sensitivity Filter
    ↓ (passes)
Heuristic Match (flagged/VIP/question/meeting)
    ↓ (matches)
Webex "Email Triage" Space
    ↓ (mc-webex-messages agent, hourly)
Parse [EMAIL] format
    ↓
Notion Task (Source: Email, Zone: Air-Gapped)
    ↓ (index rebuild)
Mission Control Dashboard
    → Today's Action Items
    → People view (correlated with Webex context)
    → Initiatives (auto-linked by keywords)
    → Morning Briefing
```

---

## Testing

1. Flag any email in Outlook (or send yourself a test from a VIP address)
2. Wait 1-2 minutes for Power Automate to trigger
3. Check the "Email Triage" Webex space — you should see the `[EMAIL]` message
4. Wait for the next mc-webex-messages run (hourly at :47) or trigger manually
5. Check Mission Control — task should appear with Source: Email

---

## Deduplication

If the same email triggers multiple flows (e.g., a flagged VIP email with a question), you'll get multiple messages in the Webex space. The mc-webex-messages agent should handle near-duplicates, but occasional doubles may appear. Easy to spot and dismiss in Mission Control.

---

## Adding/Removing VIPs

Edit Flow 3's condition to add or remove email addresses. No changes needed on the NanoClaw side.
