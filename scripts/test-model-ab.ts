/**
 * Semantic A/B Testing — Compare current (non-compliant) models
 * against Cisco GREEN-approved replacements.
 *
 * Tests each pipeline use case with identical prompts across models,
 * scoring: accuracy, format compliance, hallucination, latency.
 *
 * Usage: npx tsx scripts/test-model-ab.ts
 */

const OLLAMA_URL = "http://studio.shearer.live:11434";

interface TestResult {
  testName: string;
  model: string;
  policyStatus: string;
  latencyMs: number;
  outputLength: number;
  formatCompliant: boolean;
  hallucination: boolean;
  output: string;
  score: number; // 0-10 manual review score
}

const results: TestResult[] = [];

async function chat(model: string, prompt: string, system?: string, timeoutMs = 120000): Promise<{ content: string; latencyMs: number }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const messages: any[] = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages, options: { num_ctx: 4096 } }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const data = await resp.json() as any;
    const content = data.message?.content || "";
    // Strip think tags
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return { content: cleaned, latencyMs: Date.now() - start };
  } catch (err: any) {
    clearTimeout(timer);
    return { content: `ERROR: ${err.message}`, latencyMs: Date.now() - start };
  }
}

function checkJsonFormat(output: string): boolean {
  try {
    // Try to find JSON in the output
    const jsonMatch = output.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) JSON.parse(jsonMatch[0]);
    return !!jsonMatch;
  } catch { return false; }
}

function checkHallucination(output: string, context: string): boolean {
  // Simple check: does the output reference entities not in the context?
  const outputNames = output.match(/[A-Z][a-z]+ [A-Z][a-z]+/g) || [];
  const contextLower = context.toLowerCase();
  let hallucinated = 0;
  for (const name of outputNames) {
    if (!contextLower.includes(name.toLowerCase().split(" ")[0])) hallucinated++;
  }
  return hallucinated > 2;
}

// ══════════════════════════════════════════════════════════
// Test 1: Webex Message Analysis (replaces DeepSeek R1:70b)
// ══════════════════════════════════════════════════════════
async function testWebexMessageAnalysis(model: string, policyStatus: string) {
  const system = `You analyze Webex messages to identify follow-up actions for Jason Shearer (jasheare@cisco.com).
For each conversation that needs action, output a JSON object on its own line:
{"task": "Reply to [Name] about [topic]", "priority": "P1", "context": "Quick Win", "person": "Name", "reason": "brief explanation"}

Rules:
- Base your analysis ONLY on the messages provided
- Only flag messages that need Jason's ACTION
- DO NOT flag: FYI messages, automated notifications, messages Jason already replied to
- Output ONLY JSON lines, no other text`;

  const prompt = `Room: Scott Jackson DM

Messages:
[Mar 27, 2:00 PM] Scott Jackson: Hey Jason. How are you? Quick update on Kite:
- The Kite leadership team can meet at their Indianapolis office on April 9th (after 1:00). What time would you want to meet with them?
- The OneLoudon issue: Basically, they have tenants that provide their own ISP and WIFI services. Kite does not know anything about which vendors that they are using in the buildings.

[Mar 27, 2:05 PM] Scott Jackson: They are looking at DAS solutions though an ATT partner but want to talk about other options that may provide the same or better experience. They are available next week (Tuesday late afternoon or Wed Morning) to deep dive with one of your engineers.`;

  const { content, latencyMs } = await chat(model, prompt, system);
  const hasJson = checkJsonFormat(content);
  const hallucinated = checkHallucination(content, prompt);

  results.push({
    testName: "Webex Message Analysis",
    model, policyStatus, latencyMs,
    outputLength: content.length,
    formatCompliant: hasJson,
    hallucination: hallucinated,
    output: content.slice(0, 500),
    score: 0,
  });
}

// ══════════════════════════════════════════════════════════
// Test 2: Transcript Action Item Extraction (replaces DeepSeek)
// ══════════════════════════════════════════════════════════
async function testTranscriptExtraction(model: string, policyStatus: string) {
  const system = `Extract action items from this meeting transcript. For each action item, output a JSON line:
{"task": "action item title", "priority": "P1", "assignee": "Person Name", "context": "Quick Win or Deep Work"}

Rules:
- Only extract ACTIONABLE items (not discussion points or FYI)
- Base analysis ONLY on the transcript
- Output ONLY JSON lines`;

  const prompt = `Meeting: Real Estate Accelerator Weekly Office Hours
Date: 2026-03-25

Bob Coyle: I think there are about 8 major metro properties heavily invested in IBEW. We should target these cities directly with leadership-level engagement, using membership growth as the primary hook.

Michael Parker (Atlanta, DBS): confirmed this approach works — conversations with large electrical contractors are productive when framed around opportunity, not displacement. Jason noted success with Local 3 in NYC.

Action: Identify the 8 target IBEW metro cities, map out Local contacts, and create an engagement playbook replicating what worked with Local 3.`;

  const { content, latencyMs } = await chat(model, prompt, system);

  results.push({
    testName: "Transcript Extraction",
    model, policyStatus, latencyMs,
    outputLength: content.length,
    formatCompliant: checkJsonFormat(content),
    hallucination: checkHallucination(content, prompt),
    output: content.slice(0, 500),
    score: 0,
  });
}

// ══════════════════════════════════════════════════════════
// Test 3: Task Merge Synthesis (replaces Qwen3-coder:30b)
// ══════════════════════════════════════════════════════════
async function testMergeSynthesis(model: string, policyStatus: string) {
  const prompt = `/no_think
Synthesize these 3 duplicate/related tasks into ONE clear action item.

Title: "Send Zach a link to past panel discussion featuring Bob Voss and Ronna Davis"
Notes: From recording: 02-24 Weekly Meeting on Feb 24, 2026.
---
Title: "Send Zach a link to engineering alliances webpage detailing FMP partnership"
Notes: From recording: 02-24 Weekly Meeting on Feb 24, 2026.
---
Title: "Send Zach the presentation deck from joint workshop with Mahmoud Ibrahim"
Notes: From recording: 02-24 Weekly Meeting on Feb 24, 2026.

Return ONLY two lines, no other text:
TITLE: <synthesized task title — concise, actionable, captures the full scope>
NOTES: <one paragraph combining all context, sources, and details from the individual tasks>`;

  const { content, latencyMs } = await chat(model, prompt);
  const hasTitle = /TITLE:/i.test(content);
  const hasNotes = /NOTES:/i.test(content);

  results.push({
    testName: "Merge Synthesis",
    model, policyStatus, latencyMs,
    outputLength: content.length,
    formatCompliant: hasTitle && hasNotes,
    hallucination: false,
    output: content.slice(0, 500),
    score: 0,
  });
}

// ══════════════════════════════════════════════════════════
// Test 4: Calendar Conflict Detection (replaces Qwen3:8b)
// ══════════════════════════════════════════════════════════
async function testCalendarAnalysis(model: string, policyStatus: string) {
  const prompt = `Analyze these calendar events for conflicts and prep needs:

1. 8:00 AM - 9:00 AM: FPW4RE EMEA - FY26 weekly cadence (Host: Odd Erik)
2. 8:30 AM - 9:00 AM: Tim & Jason 1:1
3. 9:00 AM - 10:00 AM: Global Networking Sales Engineering - Direct Team Call (Host: Alfredo Bouchot)
4. 9:30 AM - 10:00 AM: Monthly Sync (Host: Ken Daniels)

Output JSON:
{"conflicts": [{"events": [1,2], "reason": "..."}], "prep_needed": [{"event": 2, "reason": "..."}]}

Output ONLY the JSON, no other text.`;

  const { content, latencyMs } = await chat(model, prompt);

  results.push({
    testName: "Calendar Analysis",
    model, policyStatus, latencyMs,
    outputLength: content.length,
    formatCompliant: checkJsonFormat(content),
    hallucination: false,
    output: content.slice(0, 500),
    score: 0,
  });
}

// ══════════════════════════════════════════════════════════
// Test 5: Meeting Brief Generation (replaces Qwen3-coder)
// ══════════════════════════════════════════════════════════
async function testMeetingBrief(model: string, policyStatus: string) {
  const prompt = `/no_think
You are preparing a quick meeting brief for Jason Shearer.

Meeting: "Sri & Jason Sync"
Host: Jason Shearer
Time: Monday, March 30

Attendees:
Srilatha Vemula (Solutions Engineer) — 0 meetings, 8 messages

Based on the meeting title and attendee list, provide a concise brief (150 words max):
1. What is this meeting likely about?
2. Who are the key people Jason should pay attention to?
3. One sentence on what Jason should be ready to contribute.

Be direct and specific. No filler. No markdown bold — plain text only.`;

  const { content, latencyMs } = await chat(model, prompt);

  results.push({
    testName: "Meeting Brief",
    model, policyStatus, latencyMs,
    outputLength: content.length,
    formatCompliant: content.length > 50 && content.length < 1000,
    hallucination: checkHallucination(content, prompt),
    output: content.slice(0, 500),
    score: 0,
  });
}

// ══════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════
async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     Model A/B Testing — Cisco Policy Compliance         ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Check which models are available
  const tagsResp = await fetch(`${OLLAMA_URL}/api/tags`);
  const tags = await tagsResp.json() as any;
  const available = new Set((tags.models || []).map((m: any) => m.name));
  console.log("Available models:", [...available].join(", "));
  console.log();

  // Define model lineup
  const models: { name: string; policy: string; ollamaName: string }[] = [
    // Current (non-compliant)
    { name: "DeepSeek R1:70b", policy: "NOT LISTED", ollamaName: "deepseek-r1:70b" },
    { name: "Qwen3-coder:30b", policy: "NOT LISTED", ollamaName: "qwen3-coder:30b" },
    // GREEN replacements
    { name: "Gemma 3:27b", policy: "GREEN", ollamaName: "gemma3:27b" },
  ];

  // Add newly pulled models if available
  for (const m of [
    { name: "Mistral Small 3.1:24b", policy: "GREEN", ollamaName: "mistral-small3.1:24b-instruct-2503-q4_K_M" },
    { name: "Phi 4 Reasoning:14b", policy: "GREEN", ollamaName: "phi4-reasoning:14b" },
    { name: "Granite 3.3:8b", policy: "GREEN", ollamaName: "granite3.3:8b" },
  ]) {
    if (available.has(m.ollamaName)) models.push(m);
    else console.log(`  ⚠ ${m.name} not yet available (still pulling?)`);
  }
  console.log();

  // Run tests
  const tests = [
    { name: "Webex Message Analysis", fn: testWebexMessageAnalysis },
    { name: "Transcript Extraction", fn: testTranscriptExtraction },
    { name: "Merge Synthesis", fn: testMergeSynthesis },
    { name: "Calendar Analysis", fn: testCalendarAnalysis },
    { name: "Meeting Brief", fn: testMeetingBrief },
  ];

  for (const test of tests) {
    console.log(`\x1b[1m━━━ ${test.name} ━━━\x1b[0m`);
    for (const model of models) {
      process.stdout.write(`  Testing ${model.name}...`);
      await test.fn(model.ollamaName, model.policy);
      const r = results[results.length - 1];
      const icon = r.formatCompliant && !r.hallucination ? "✓" : "✗";
      const color = r.formatCompliant && !r.hallucination ? "\x1b[32m" : "\x1b[31m";
      console.log(` ${color}${icon}\x1b[0m ${r.latencyMs}ms | ${r.outputLength} chars | format:${r.formatCompliant} | halluc:${r.hallucination}`);
    }
    console.log();
  }

  // Summary table
  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                              RESULTS SUMMARY                                ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣");
  console.log("║ Test                    │ Model              │ Policy │ Time   │ Fmt │ Hall ║");
  console.log("╠═════════════════════════╪════════════════════╪════════╪════════╪═════╪══════╣");

  for (const r of results) {
    const test = r.testName.padEnd(23);
    const model = r.model.split(":")[0].slice(0, 18).padEnd(18);
    const policy = r.policyStatus.padEnd(6);
    const time = `${Math.round(r.latencyMs / 1000)}s`.padStart(5);
    const fmt = r.formatCompliant ? " ✓  " : " ✗  ";
    const hall = r.hallucination ? "  ✗  " : "  ✓  ";
    console.log(`║ ${test} │ ${model} │ ${policy} │ ${time}  │${fmt}│${hall}║`);
  }
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝");

  // Output details for manual review
  console.log("\n\n═══ DETAILED OUTPUTS FOR MANUAL REVIEW ═══\n");
  for (const r of results) {
    console.log(`\x1b[1m[${r.testName}] ${r.model} (${r.policyStatus})\x1b[0m`);
    console.log(`Latency: ${r.latencyMs}ms | Format: ${r.formatCompliant} | Hallucination: ${r.hallucination}`);
    console.log("Output:");
    console.log(r.output);
    console.log("---\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
