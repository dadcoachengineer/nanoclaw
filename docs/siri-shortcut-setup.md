# Siri Shortcut: Add Task to Mission Control

Say "Hey Siri, Add Task" → dictate → task lands in Notion as P1, Source: Voice Memo.

## Setup (2 minutes)

1. Open **Shortcuts** app on iPhone
2. Tap **+** (top right) to create new shortcut
3. Name it: **Add Task**

### Add these actions in order:

**Action 1: Dictate Text**
- Search for "Dictate Text" and add it
- Leave default settings (stop after pause)

**Action 2: Get Contents of URL**
- Search for "Get Contents of URL" and add it
- URL: `https://api.notion.com/v1/pages`
- Show More:
  - Method: **POST**
  - Headers: Add these 3:
    | Key | Value |
    |-----|-------|
    | `Authorization` | `Bearer secret_YOUR_KEY` |
    | `Content-Type` | `application/json` |
    | `Notion-Version` | `2022-06-28` |
  - Request Body: **JSON**
  - Add these keys (you'll need to build the nested structure):

Since Shortcuts doesn't handle deeply nested JSON well, use **Action 2 alternative** instead:

**Action 2 (alternative): Text + Get Contents of URL**

Add a **Text** action first with this content (tap "Dictated Text" variable to insert it):
```
{"parent":{"database_id":"5b4e1d2d7259496ea237ef0525c3ce78"},"properties":{"Task":{"title":[{"text":{"content":"DICTATED_TEXT"}}]},"Priority":{"select":{"name":"P1 — This Week"}},"Status":{"status":{"name":"Not started"}},"Context":{"select":{"name":"Quick Win"}},"Zone":{"select":{"name":"Open"}},"Source":{"select":{"name":"Voice Memo"}},"Delegated To":{"select":{"name":"Jason"}}}}
```
Replace `DICTATED_TEXT` with the **Dictated Text** magic variable (long press the text, tap "Dictated Text" from the variable picker).

Then add **Get Contents of URL**:
- URL: `https://api.notion.com/v1/pages`
- Method: **POST**
- Headers:
  - `Authorization`: `Bearer secret_YOUR_KEY`
  - `Content-Type`: `application/json`
  - `Notion-Version`: `2022-06-28`
- Request Body: **File** → select the Text output from the previous step

**Action 3: Show Notification**
- Title: `Task Added`
- Body: `✅ ` + Dictated Text variable

### Get your Notion API Key

Use the same key from the Outlook Scanner integration, or:
1. Go to notion.so/my-integrations
2. Find your integration → copy the Internal Integration Secret
3. Paste it in the `Authorization` header (after "Bearer ")

## Usage

- **"Hey Siri, Add Task"** → dictate → done
- Works from lock screen, CarPlay, AirPods, Apple Watch
- Tasks appear in Mission Control within seconds
- Tagged as P1, Source: Voice Memo, Delegated To: Jason

## Optional: Priority Selector

To choose priority before adding:
1. Add a **Choose from Menu** action before the URL call
2. Options: "P0 — Today", "P1 — This Week", "P2 — This Month"
3. In each menu branch, set a variable with the priority value
4. Use that variable in the JSON body instead of hardcoded P1

## Optional: Share Sheet Integration

To add from any app's share sheet:
1. In shortcut settings, enable **Show in Share Sheet**
2. Accept: **Text**
3. Replace "Dictate Text" with **Shortcut Input**
4. Now you can select text anywhere → Share → Add Task
