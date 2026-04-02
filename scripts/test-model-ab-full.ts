/**
 * Full A/B testing — all GREEN models vs current non-compliant models.
 * Includes prompt tuning for Gemma's JSON output issues.
 */

const OLLAMA_URL = "http://studio.shearer.live:11434";

interface Result {
  test: string;
  model: string;
  policy: string;
  latencyMs: number;
  chars: number;
  formatOk: boolean;
  halluc: boolean;
  output: string;
}

const results: Result[] = [];

async function chat(model: string, prompt: string, system?: string): Promise<{ content: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const messages: any[] = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages, options: { num_ctx: 4096 } }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await resp.json() as any;
    const content = (data.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return { content, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { content: `ERROR: ${err.message}`, latencyMs: Date.now() - start };
  }
}

function hasJson(s: string): boolean {
  try { const m = s.match(/[\[{][\s\S]*?[\]}]/); if (m) JSON.parse(m[0]); return !!m; } catch { return false; }
}

// Prompt-tuned system prompts for Gemma (adds explicit JSON enforcement)
const TUNED_JSON_SUFFIX = `\n\nCRITICAL: You MUST respond with ONLY valid JSON. No explanatory text before or after. No markdown code fences. Start your response with { or [.`;

// ═══════════════════════════════════════════════════
// Test cases
// ═══════════════════════════════════════════════════

const TESTS: { name: string; system: string; prompt: string; checkFormat: (s: string) => boolean }[] = [
  {
    name: "Webex Message Analysis",
    system: `You analyze Webex messages for follow-up actions. For each actionable message output ONE JSON line:
{"task":"Reply to [Name] about [topic]","priority":"P1","context":"Quick Win","person":"Name","reason":"why"}
Output ONLY JSON lines. No other text.` + TUNED_JSON_SUFFIX,
    prompt: `Room: Scott Jackson DM\n\n[Mar 27] Scott Jackson: Hey Jason. Quick update on Kite:\n- The Kite leadership team can meet at their Indianapolis office on April 9th (after 1:00).\n- The OneLoudon issue: tenants provide their own ISP/WIFI. Kite wants to talk about DAS alternatives.\nThey are available next week (Tue afternoon or Wed morning) to deep dive with one of your engineers.`,
    checkFormat: hasJson,
  },
  {
    name: "Transcript Extraction",
    system: `Extract action items from this meeting transcript. Output ONE JSON line per action item:
{"task":"action item","priority":"P1 or P2","assignee":"Person","context":"Quick Win or Deep Work"}
ONLY output JSON lines based on what is explicitly stated. Do NOT invent information.` + TUNED_JSON_SUFFIX,
    prompt: `Meeting: RE Accelerator Weekly — 2026-03-25\n\nBob Coyle: there are about 8 major metro properties heavily invested in IBEW. Target these cities directly with leadership-level engagement.\nMichael Parker (DBS): confirmed this approach works with large electrical contractors when framed around opportunity.\nJason: noted success with Local 3 in NYC.\n\nAction item: Identify 8 target IBEW metro cities, map Local contacts, create engagement playbook.`,
    checkFormat: hasJson,
  },
  {
    name: "Merge Synthesis",
    system: "",
    prompt: `Synthesize these 3 tasks into ONE. Return ONLY two lines:\nTITLE: <merged title>\nNOTES: <combined context>\n\n1. "Send Zach a link to past panel discussion featuring Bob Voss"\n2. "Send Zach engineering alliances webpage for FMP partnership"\n3. "Send Zach presentation deck from joint workshop with Mahmoud Ibrahim"`,
    checkFormat: (s) => /TITLE:/i.test(s) && /NOTES:/i.test(s),
  },
  {
    name: "Calendar Conflicts",
    system: `Analyze calendar events for conflicts. Output ONLY valid JSON:
{"conflicts":[{"events":[1,2],"reason":"..."}],"prep_needed":[{"event":2,"reason":"..."}]}` + TUNED_JSON_SUFFIX,
    prompt: `1. 8:00-9:00 AM: FPW4RE EMEA weekly (Odd Erik)\n2. 8:30-9:00 AM: Tim & Jason 1:1\n3. 9:00-10:00 AM: Global Networking SE Team Call (Alfredo)\n4. 9:30-10:00 AM: Monthly Sync (Ken Daniels)`,
    checkFormat: hasJson,
  },
  {
    name: "Meeting Brief",
    system: "",
    prompt: `Write a 100-word meeting brief for Jason Shearer:\nMeeting: "Sri & Jason Sync" Monday 1:00 PM\nAttendee: Srilatha Vemula (Solutions Engineer, 8 messages, 0 meetings)\n\n1) What is this meeting about?\n2) Key person to focus on?\n3) What should Jason be ready to discuss?\n\nPlain text only, no markdown. Be direct.`,
    checkFormat: (s) => s.length > 50 && s.length < 800 && !s.startsWith("ERROR"),
  },
];

// ═══════════════════════════════════════════════════
// Models to test
// ═══════════════════════════════════════════════════

const MODELS = [
  { name: "deepseek-r1:70b", label: "DeepSeek R1 70B", policy: "NOT LISTED" },
  { name: "qwen3-coder:30b", label: "Qwen3 Coder 30B", policy: "NOT LISTED" },
  { name: "gemma3:27b", label: "Gemma 3 27B", policy: "GREEN" },
  { name: "mistral-small:24b", label: "Mistral Small 24B", policy: "GREEN" },
  { name: "phi4:14b", label: "Phi 4 14B", policy: "GREEN" },
  { name: "granite3.3:8b", label: "Granite 3.3 8B", policy: "GREEN" },
];

async function main() {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  Full Model A/B Testing — Cisco GREEN Compliance              ║");
  console.log("║  6 models × 5 tests = 30 evaluations                         ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  for (const test of TESTS) {
    console.log(`\x1b[1m━━━ ${test.name} ━━━\x1b[0m`);
    for (const model of MODELS) {
      process.stdout.write(`  ${model.label.padEnd(22)}`);
      const { content, latencyMs } = await chat(model.name, test.prompt, test.system || undefined);
      const fmtOk = test.checkFormat(content);
      const halluc = content.includes("ERROR");
      const icon = fmtOk ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(`${icon} ${String(Math.round(latencyMs / 1000)).padStart(3)}s  ${String(content.length).padStart(4)} chars  fmt:${fmtOk ? "✓" : "✗"}`);
      results.push({ test: test.name, model: model.label, policy: model.policy, latencyMs, chars: content.length, formatOk: fmtOk, halluc, output: content.slice(0, 400) });
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════
  // Summary matrix
  // ═══════════════════════════════════════════════════
  console.log("\n\x1b[1m═══ SUMMARY MATRIX ═══\x1b[0m\n");
  const testNames = [...new Set(results.map((r) => r.test))];
  const modelNames = [...new Set(results.map((r) => r.model))];

  // Header
  process.stdout.write("".padEnd(24));
  for (const m of modelNames) process.stdout.write(m.slice(0, 14).padEnd(16));
  console.log();
  process.stdout.write("".padEnd(24));
  for (const m of modelNames) {
    const p = results.find((r) => r.model === m)?.policy || "";
    const color = p === "GREEN" ? "\x1b[32m" : "\x1b[31m";
    process.stdout.write(`${color}${p.padEnd(16)}\x1b[0m`);
  }
  console.log("\n" + "─".repeat(24 + modelNames.length * 16));

  for (const test of testNames) {
    process.stdout.write(test.padEnd(24));
    for (const model of modelNames) {
      const r = results.find((x) => x.test === test && x.model === model);
      if (r) {
        const icon = r.formatOk ? "✓" : "✗";
        const color = r.formatOk ? "\x1b[32m" : "\x1b[31m";
        process.stdout.write(`${color}${icon} ${Math.round(r.latencyMs / 1000)}s\x1b[0m`.padEnd(26));
      } else {
        process.stdout.write("—".padEnd(16));
      }
    }
    console.log();
  }

  // Score summary
  console.log("\n\x1b[1m═══ PASS RATES ═══\x1b[0m\n");
  for (const model of modelNames) {
    const modelResults = results.filter((r) => r.model === model);
    const passed = modelResults.filter((r) => r.formatOk).length;
    const total = modelResults.length;
    const avgLatency = Math.round(modelResults.reduce((s, r) => s + r.latencyMs, 0) / total / 1000);
    const policy = modelResults[0]?.policy || "";
    const color = policy === "GREEN" ? "\x1b[32m" : "\x1b[31m";
    console.log(`  ${color}${policy.padEnd(12)}\x1b[0m ${model.padEnd(22)} ${passed}/${total} passed  avg ${avgLatency}s`);
  }

  // Detailed outputs
  console.log("\n\n\x1b[1m═══ DETAILED OUTPUTS ═══\x1b[0m\n");
  for (const r of results) {
    const color = r.policy === "GREEN" ? "\x1b[32m" : "\x1b[31m";
    console.log(`\x1b[1m[${r.test}] ${r.model} ${color}(${r.policy})\x1b[0m — ${Math.round(r.latencyMs / 1000)}s, fmt:${r.formatOk}`);
    console.log(r.output);
    console.log("---\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
