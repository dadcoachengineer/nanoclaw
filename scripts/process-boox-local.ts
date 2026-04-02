/**
 * Process Boox NoteAir2P handwritten notes locally using Ollama (gemma3:27b vision).
 *
 * Downloads PDF notebooks from Nextcloud WebDAV, converts pages to images with
 * pdftoppm, sends each page to Gemma 3 27B for OCR and action item extraction,
 * applies corrections, and creates Notion tasks.
 *
 * Replaces the mc-boox-processor scheduled agent for cost savings.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/process-boox-local.ts
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { HttpsProxyAgent } from "https-proxy-agent";
import { findOrCreateTask, clearTaskCache, logPipelineRun } from './lib/task-dedup.js';
import { ollamaChat } from './lib/ollama-client.js';

const STORE_DIR = path.join(process.cwd(), "store");
const STATE_PATH = path.join(STORE_DIR, "boox-local-state.json");
const CORRECTIONS_PATH = path.join(STORE_DIR, "corrections.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const MAX_PAGES_PER_PDF = 10;
const OLLAMA_MODEL = "gemma3:27b";
const OLLAMA_TIMEOUT_MS = 120_000;

// Nextcloud WebDAV settings
const NEXTCLOUD_BASE = "https://drive.shearer.live";
const NEXTCLOUD_DAV_PATH =
  "/remote.php/dav/files/jason/BooxSync/Notes/onyx/NoteAir2P/Notebooks/";

// OneCLI proxy — injects credentials based on host patterns
const AGENT_TOKEN = process.env.ONECLI_AGENT_TOKEN;
if (!AGENT_TOKEN) {
  throw new Error("ONECLI_AGENT_TOKEN environment variable is required");
}
const proxyAgent = new HttpsProxyAgent(
  `http://x:${AGENT_TOKEN}@localhost:10255`
);

// Temp directory for PDF and page images
const TMP_DIR = "/tmp/boox-processing";

// --- State types ---

interface BooxLocalState {
  lastCheck: string;
  etags: Record<string, string>; // filename -> etag
  processedPages: Record<string, boolean>; // "filename:page" -> true
  metrics: {
    totalRuns: number;
    totalPages: number;
    totalTasks: number;
    avgLatencyMs: number;
    errors: number;
  };
}

interface ActionItem {
  task: string;
  priority: string;
  context: string;
}

interface RunMetrics {
  pdfsChecked: number;
  pdfsChanged: number;
  pagesProcessed: number;
  pagesBlank: number;
  tasksExtracted: number;
  tasksCreated: number;
  tasksMerged: number;
  tasksSkipped: number;
  correctionsApplied: number;
  ollamaLatencies: number[];
  ollamaTokensIn: number;
  ollamaTokensOut: number;
  parseErrors: number;
  notionErrors: number;
}

// --- Fetch helpers ---

async function nextcloudRequest(
  urlPath: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const nodeFetch = (await import("node-fetch")).default;
  const resp = await nodeFetch(`${NEXTCLOUD_BASE}${urlPath}`, {
    method: options.method || "GET",
    agent: proxyAgent,
    headers: options.headers || {},
    body: options.body,
  });
  const text = await resp.text();
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    respHeaders[key] = value;
  });
  return { status: resp.status, text, headers: respHeaders };
}

async function notionPost(
  endpoint: string,
  body: unknown
): Promise<unknown> {
  const nodeFetch = (await import("node-fetch")).default;
  const resp = await nodeFetch(`https://api.notion.com/v1${endpoint}`, {
    method: "POST",
    agent: proxyAgent,
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function notionPatchPages(pageId: string, body: Record<string, unknown>): Promise<void> {
  const nodeFetch = (await import("node-fetch")).default;
  await nodeFetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    agent: proxyAgent,
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  } as any);
}

// --- WebDAV helpers ---

interface DavEntry {
  href: string;
  filename: string;
  etag: string;
  lastModified: string;
}

function parsePropfindResponse(xml: string): DavEntry[] {
  const entries: DavEntry[] = [];

  // Match each <d:response> block
  const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/gi;
  let match;

  while ((match = responseRegex.exec(xml)) !== null) {
    const block = match[1];

    // Extract href
    const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/);
    if (!hrefMatch) continue;
    const href = decodeURIComponent(hrefMatch[1]);

    // Skip the directory itself (no .pdf extension)
    if (!href.toLowerCase().endsWith(".pdf")) continue;

    // Extract etag
    const etagMatch = block.match(/<d:getetag>"?([^"<]+)"?<\/d:getetag>/);
    const etag = etagMatch ? etagMatch[1] : "";

    // Extract last modified
    const modMatch = block.match(
      /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/
    );
    const lastModified = modMatch ? modMatch[1] : "";

    // Extract filename from href
    const filename = href.split("/").filter(Boolean).pop() || "";

    entries.push({ href, filename, etag, lastModified });
  }

  return entries;
}

async function listNotebookPdfs(): Promise<DavEntry[]> {
  const resp = await nextcloudRequest(NEXTCLOUD_DAV_PATH, {
    method: "PROPFIND",
    headers: {
      Depth: "1",
      "Content-Type": "application/xml",
    },
    body: `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <d:getlastmodified/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>`,
  });

  if (resp.status !== 207) {
    throw new Error(
      `WebDAV PROPFIND failed with status ${resp.status}: ${resp.text.slice(0, 200)}`
    );
  }

  return parsePropfindResponse(resp.text);
}

async function downloadPdf(
  davPath: string,
  localPath: string
): Promise<void> {
  const nodeFetch = (await import("node-fetch")).default;
  const resp = await nodeFetch(`${NEXTCLOUD_BASE}${davPath}`, {
    agent: proxyAgent,
  });

  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }

  const buffer = await resp.buffer();
  fs.writeFileSync(localPath, buffer);
}

// --- PDF helpers ---

function getPdfPageCount(pdfPath: string): number {
  // Try pdfinfo first (from poppler)
  try {
    const output = execSync(`pdfinfo "${pdfPath}" 2>/dev/null`, {
      encoding: "utf-8",
    });
    const pagesMatch = output.match(/Pages:\s+(\d+)/);
    if (pagesMatch) return parseInt(pagesMatch[1], 10);
  } catch {
    // pdfinfo not available
  }

  // Fallback: try pdftoppm with just page 1 to verify it works, then
  // binary search for page count
  try {
    // Try a high page number; pdftoppm exits gracefully if page doesn't exist
    for (const testCount of [500, 200, 100, 50, 20, 10, 5]) {
      try {
        execSync(
          `pdftoppm -png -r 72 -f ${testCount} -l ${testCount} "${pdfPath}" /dev/null 2>/dev/null`,
          { encoding: "utf-8" }
        );
        return testCount; // at minimum this many pages
      } catch {
        continue;
      }
    }
  } catch {
    // pdftoppm not available either
  }

  // Last resort: assume 1 page
  return 1;
}

function hasPdftoppm(): boolean {
  try {
    execSync("which pdftoppm 2>/dev/null", { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function hasConvert(): boolean {
  try {
    execSync("which convert 2>/dev/null", { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function convertPdfPageToImage(
  pdfPath: string,
  page: number,
  outputPrefix: string
): string | null {
  const outputPath = `${outputPrefix}-${String(page).padStart(6, "0")}.png`;

  if (hasPdftoppm()) {
    try {
      execSync(
        `pdftoppm -png -r 150 -f ${page} -l ${page} "${pdfPath}" "${outputPrefix}"`,
        { encoding: "utf-8", timeout: 30_000 }
      );
      // pdftoppm names output as prefix-NNNNNN.png
      if (fs.existsSync(outputPath)) return outputPath;

      // Try alternate naming (some versions use different padding)
      const altPath = `${outputPrefix}-${page}.png`;
      if (fs.existsSync(altPath)) return altPath;

      // Check for single-page output (no page number suffix)
      const singlePath = `${outputPrefix}.png`;
      if (fs.existsSync(singlePath)) return singlePath;

      return null;
    } catch {
      return null;
    }
  }

  if (hasConvert()) {
    try {
      // ImageMagick: 0-indexed pages
      execSync(
        `convert -density 150 "${pdfPath}[${page - 1}]" "${outputPath}"`,
        { encoding: "utf-8", timeout: 30_000 }
      );
      if (fs.existsSync(outputPath)) return outputPath;
      return null;
    } catch {
      return null;
    }
  }

  throw new Error(
    "Neither pdftoppm nor ImageMagick convert found. Install poppler: brew install poppler"
  );
}

// --- Utility helpers ---

function loadCorrections(): Record<string, string> {
  if (fs.existsSync(CORRECTIONS_PATH)) {
    return JSON.parse(fs.readFileSync(CORRECTIONS_PATH, "utf-8"));
  }
  return {};
}

function applyCorrections(
  text: string,
  corrections: Record<string, string>
): { text: string; applied: number } {
  let result = text;
  let applied = 0;
  for (const [wrong, right] of Object.entries(corrections)) {
    const pattern = new RegExp(
      `\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi"
    );
    const before = result;
    result = result.replace(pattern, right);
    if (result !== before) applied++;
  }
  return { text: result, applied };
}

function inferProject(content: string): string {
  const lower = content.toLowerCase();
  if (
    lower.includes("cisco") ||
    lower.includes("spaces") ||
    lower.includes("fpw") ||
    lower.includes("webex") ||
    lower.includes("splunk") ||
    lower.includes("cadenas") ||
    lower.includes("cross arch")
  ) {
    return "Cisco";
  }
  if (lower.includes("momentumeq") || lower.includes("coaching")) {
    return "MomentumEQ";
  }
  if (lower.includes("ordinary epics") || lower.includes("adventure")) {
    return "Ordinary Epics";
  }
  if (lower.includes("real estate") || lower.includes("accelerator")) {
    return "Real Estate Accelerator";
  }
  return "Cisco";
}

function mapPriority(raw: string): string {
  const normalized = raw.toUpperCase().trim();
  if (normalized === "P0") return "P0 \u2014 Today";
  if (normalized === "P1") return "P1 \u2014 This Week";
  if (normalized === "P2") return "P2 \u2014 This Month";
  if (normalized === "P3") return "P3 \u2014 This Quarter";
  return "P2 \u2014 This Month";
}

function mapContext(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower === "quick win") return "Quick Win";
  if (lower === "deep work") return "Deep Work";
  if (lower === "research") return "Research";
  return "Quick Win";
}

// --- State management ---

function loadState(): BooxLocalState {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  }
  return {
    lastCheck: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    etags: {},
    processedPages: {},
    metrics: {
      totalRuns: 0,
      totalPages: 0,
      totalTasks: 0,
      avgLatencyMs: 0,
      errors: 0,
    },
  };
}

function saveState(state: BooxLocalState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Ollama vision interaction ---

async function ocrAndExtractPage(
  imageBase64: string
): Promise<{
  text: string;
  items: ActionItem[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  parseErrors: number;
  rawResponse?: string;
}> {
  const prompt = `Read this handwritten note carefully. Extract ALL text you can see, then identify action items.

CRITICAL RULES:
- Read ONLY what is visible in the image
- Do NOT add text that is not in the image
- If the page is blank or has no legible text, output ONLY: {"type": "blank"}
- If text is illegible, mark it as [illegible]

Jason's notation conventions:
- Boxed text (text inside a rectangle/box drawn around it) = action item
- Circled text = P1 (high priority) action item
- Regular unboxed text = notes/context (do NOT create tasks for these)

Output your findings as JSON lines (one JSON object per line). Use EXACTLY this format:
{"type": "text", "content": "<actual text you read from the image>"}
{"type": "action", "task": "<actual action item from the image>", "priority": "P1", "context": "Quick Win"}

Priority: Circled items = P1. Boxed but not circled = P2.
Context: Short/simple = "Quick Win". Complex/multi-step = "Deep Work".

CRITICAL: Do NOT echo these instructions or examples back. Do NOT output placeholder text like "the extracted text" or "the action item text" or "another action item". Every task must contain SPECIFIC content from the handwriting in the image. If you cannot read specific text, use {"type": "blank"}.

Output ONLY JSON lines. No explanatory text. No markdown. Start your response with {.`;

  try {
    const result = await ollamaChat({
      model: OLLAMA_MODEL,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      images: [imageBase64],
      options: { num_ctx: 8192 },
      timeoutMs: OLLAMA_TIMEOUT_MS,
    });

    const latencyMs = result.latencyMs;
    const tokensIn = result.promptTokens;
    const tokensOut = result.completionTokens;
    const cleaned = result.content; // think tags already stripped by ollamaChat

    // Parse JSON lines
    let fullText = "";
    const items: ActionItem[] = [];
    let parseErrors = 0;
    let isBlank = false;

    const jsonLines = cleaned.split("\n").filter((l) => l.trim());

    for (const line of jsonLines) {
      try {
        let jsonStr = line.trim();
        // Skip markdown code fence markers
        if (jsonStr.startsWith("```")) continue;
        // Strip leading list markers
        jsonStr = jsonStr.replace(/^[\d]+\.\s*/, "").replace(/^-\s*/, "");

        const parsed = JSON.parse(jsonStr);

        if (parsed.type === "blank") {
          isBlank = true;
          continue;
        }

        if (parsed.type === "text" && parsed.content) {
          fullText += (fullText ? "\n" : "") + parsed.content;
        }

        if (parsed.type === "action" && parsed.task && parsed.task.length >= 5) {
          // Quality gate: reject single words, ALL CAPS headings, and generic labels
          const task = parsed.task.trim();
          const wordCount = task.split(/\s+/).length;
          const isAllCaps = task === task.toUpperCase() && task.length < 20;
          const isGenericLabel = /^(network|vision|customers?|hazel|skyway|software|bills?|resolve|agenda|notes?|goals?|ideas?|misc|overview|summary|action items?|the action item text|another action item|schedule a follow-up meeting|notation conventions?)$/i.test(task);
          const isPromptLeak = /read only what|do not add text|if the page is blank|output only json|base analysis only|boxed text.*action|circled text.*p1|priority rules|context rules|critical rules|jason.*notation|the extracted text|mark it as \[illegible\]|if text is illegible|actual text you read|actual action item/i.test(task);
          const isJustAName = wordCount <= 3 && /^[A-Z][a-z]+ [A-Z][a-z]+( [A-Z][a-z]+)?$/.test(task);
          if (wordCount < 2 || isAllCaps || isGenericLabel || isPromptLeak || isJustAName) {
            // Treat as context text, not an action item
            fullText += (fullText ? "\n" : "") + `[heading] ${task}`;
          } else {
            items.push({
              task,
              priority: parsed.priority || "P2",
              context: parsed.context || "Quick Win",
            });
          }
        }
      } catch {
        parseErrors++;
      }
    }

    // If the model said blank, return empty
    if (isBlank && items.length === 0) {
      return {
        text: "",
        items: [],
        latencyMs,
        tokensIn,
        tokensOut,
        parseErrors: 0,
      };
    }

    return {
      text: fullText,
      items,
      latencyMs,
      tokensIn,
      tokensOut,
      parseErrors,
      rawResponse: cleaned,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("abort")) {
      throw new Error(`Ollama timeout after ${OLLAMA_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

// --- Notion task creation ---

async function createNotionTask(
  item: ActionItem,
  filename: string,
  page: number,
  ocrText: string
): Promise<string | null> {
  const project = inferProject(ocrText);
  const priority = mapPriority(item.priority);
  const context = mapContext(item.context);
  const notes =
    `From Boox notebook: ${filename} page ${page}. Processed locally via ${OLLAMA_MODEL}`;

  const body = {
    parent: { database_id: NOTION_DB },
    properties: {
      Task: {
        title: [{ text: { content: item.task } }],
      },
      Priority: {
        select: { name: priority },
      },
      Status: {
        status: { name: "Not started" },
      },
      Context: {
        select: { name: context },
      },
      Zone: {
        select: { name: "Open" },
      },
      Source: {
        select: { name: "Boox Note (Local)" },
      },
      Project: {
        select: { name: project },
      },
      Notes: {
        rich_text: [{ text: { content: notes } }],
      },
    },
  };

  const result = (await notionPost("/pages", body)) as {
    id?: string;
    object?: string;
    status?: number;
    message?: string;
  };

  if (result.id) {
    return result.id;
  }
  console.error(
    `  Failed to create Notion task: ${result.message || JSON.stringify(result)}`
  );
  return null;
}

// --- Cost estimation ---

function estimateCost(
  tokensIn: number,
  tokensOut: number
): {
  haiku: string;
  sonnet: string;
} {
  // Haiku: $0.25/1M input, $1.25/1M output
  const haikuCost =
    (tokensIn / 1_000_000) * 0.25 + (tokensOut / 1_000_000) * 1.25;
  // Sonnet: $3/1M input, $15/1M output
  const sonnetCost =
    (tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15;
  return {
    haiku: `~$${haikuCost.toFixed(2)}`,
    sonnet: `~$${sonnetCost.toFixed(2)}`,
  };
}

// --- Cleanup ---

function cleanupTmpDir(): void {
  if (fs.existsSync(TMP_DIR)) {
    const files = fs.readdirSync(TMP_DIR);
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(TMP_DIR, f));
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

// --- Main ---

async function main() {
  console.log("Processing Boox handwritten notes locally...\n");

  // Check Ollama connectivity first
  const ollamaHealthUrl = process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || "http://studio.shearer.live:11434";
  try {
    const healthResp = await fetch(`${ollamaHealthUrl}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!healthResp.ok) {
      console.warn(
        `WARNING: Ollama returned ${healthResp.status}. Exiting gracefully.`
      );
      return;
    }
    // Verify the model is available
    const tags = (await healthResp.json()) as {
      models?: { name: string }[];
    };
    const modelNames = (tags.models || []).map((m) => m.name);
    const hasModel = modelNames.some(
      (n) => n.startsWith("gemma3:27b") || n === "gemma3:27b"
    );
    if (!hasModel) {
      console.warn(
        `WARNING: Model ${OLLAMA_MODEL} not found on Ollama. Available: ${modelNames.join(", ")}`
      );
      console.warn("Pull it with: ollama pull gemma3:27b");
      return;
    }
  } catch (err) {
    console.warn(
      `WARNING: Ollama unreachable at ${ollamaHealthUrl}. Exiting gracefully.`
    );
    console.warn(`  ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Check PDF conversion tools
  if (!hasPdftoppm() && !hasConvert()) {
    console.error(
      "ERROR: Neither pdftoppm nor ImageMagick convert found."
    );
    console.error("Install poppler: brew install poppler");
    return;
  }
  console.log(
    `PDF converter: ${hasPdftoppm() ? "pdftoppm (poppler)" : "convert (ImageMagick)"}`
  );

  clearTaskCache();

  const state = loadState();
  const corrections = loadCorrections();

  const metrics: RunMetrics = {
    pdfsChecked: 0,
    pdfsChanged: 0,
    pagesProcessed: 0,
    pagesBlank: 0,
    tasksExtracted: 0,
    tasksCreated: 0,
    tasksMerged: 0,
    tasksSkipped: 0,
    correctionsApplied: 0,
    ollamaLatencies: [],
    ollamaTokensIn: 0,
    ollamaTokensOut: 0,
    parseErrors: 0,
    notionErrors: 0,
  };

  // Ensure temp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  // 1. Fetch PDF list from Nextcloud WebDAV
  let davEntries: DavEntry[];
  try {
    davEntries = await listNotebookPdfs();
  } catch (err) {
    console.error(`WebDAV error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Exiting gracefully.");
    return;
  }

  console.log(`Found ${davEntries.length} PDFs in Nextcloud\n`);
  metrics.pdfsChecked = davEntries.length;

  // 2. Process each PDF with changed etag
  for (const entry of davEntries) {
    const prevEtag = state.etags[entry.filename];
    const isChanged = !prevEtag || prevEtag !== entry.etag;

    if (!isChanged) {
      console.log(`Skipping ${entry.filename} (unchanged)`);
      continue;
    }

    console.log(
      `Processing: ${entry.filename} (${prevEtag ? "changed" : "new"}, modified: ${entry.lastModified})`
    );
    metrics.pdfsChanged++;

    // 3. Download PDF
    const localPdfPath = path.join(TMP_DIR, `boox-${entry.filename}`);
    try {
      await downloadPdf(entry.href, localPdfPath);
      console.log(`  Downloaded to ${localPdfPath}`);
    } catch (err) {
      console.error(
        `  Download error: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    // 4. Get page count
    const totalPages = getPdfPageCount(localPdfPath);
    console.log(`  Total pages: ${totalPages}`);

    // Find NEW pages (not in processedPages state)
    const pagesToProcess: number[] = [];
    for (let p = 1; p <= totalPages; p++) {
      const pageKey = `${entry.filename}:${p}`;
      if (!state.processedPages[pageKey]) {
        pagesToProcess.push(p);
      }
    }

    // Safety limit: only process up to MAX_PAGES_PER_PDF new pages per run
    const pageBatch = pagesToProcess.slice(0, MAX_PAGES_PER_PDF);
    const skipped = pagesToProcess.length - pageBatch.length;

    console.log(
      `  New pages: ${pagesToProcess.length}, processing: ${pageBatch.length}${skipped > 0 ? ` (${skipped} deferred to next run)` : ""}`
    );

    if (pageBatch.length === 0) {
      // All pages processed, just update etag
      state.etags[entry.filename] = entry.etag;
      console.log("  All pages already processed, updating etag");
      continue;
    }

    // 5. Process each new page
    for (const page of pageBatch) {
      const pageKey = `${entry.filename}:${page}`;
      console.log(`  Page ${page}:`);

      // Convert PDF page to PNG
      const outputPrefix = path.join(
        TMP_DIR,
        `boox-page-${entry.filename.replace(/\.pdf$/i, "")}`
      );
      const imagePath = convertPdfPageToImage(localPdfPath, page, outputPrefix);

      if (!imagePath) {
        console.log("    Could not convert page to image, skipping");
        state.processedPages[pageKey] = true;
        continue;
      }

      // Read and base64 encode the image
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString("base64");

      // Clean up image file immediately
      try {
        fs.unlinkSync(imagePath);
      } catch {
        // ignore
      }

      // 6. Send to Gemma 3 27B vision for OCR + action extraction
      let ocrResult: Awaited<ReturnType<typeof ocrAndExtractPage>>;
      try {
        ocrResult = await ocrAndExtractPage(base64Image);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    Ollama error: ${msg}`);
        metrics.parseErrors++;
        // Don't mark as processed so we can retry
        continue;
      }

      metrics.ollamaLatencies.push(ocrResult.latencyMs);
      metrics.ollamaTokensIn += ocrResult.tokensIn;
      metrics.ollamaTokensOut += ocrResult.tokensOut;
      metrics.parseErrors += ocrResult.parseErrors;

      // Handle blank pages
      if (!ocrResult.text && ocrResult.items.length === 0) {
        console.log(
          `    Blank page (${(ocrResult.latencyMs / 1000).toFixed(1)}s)`
        );
        metrics.pagesBlank++;
        state.processedPages[pageKey] = true;
        metrics.pagesProcessed++;
        continue;
      }

      console.log(
        `    OCR: ${ocrResult.text.length} chars, ${ocrResult.items.length} action items in ${(ocrResult.latencyMs / 1000).toFixed(1)}s`
      );

      // Archive the OCR text
      if (ocrResult.text.length > 20) {
        try {
          const archiveDir = path.join(STORE_DIR, "archive", "boox");
          if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
          const archiveId = pageKey.replace(/[^a-z0-9]/gi, "-");
          fs.writeFileSync(path.join(archiveDir, `${archiveId}.json`), JSON.stringify({
            id: archiveId,
            title: `${pdfFile} page ${pageNum}`,
            source: pdfFile,
            page: pageNum,
            date: new Date().toISOString(),
            content: ocrResult.text,
            items: ocrResult.items,
            charCount: ocrResult.text.length,
            archivedAt: new Date().toISOString(),
          }, null, 2));
        } catch { /* archive is best-effort */ }
      }

      if (ocrResult.items.length === 0 && ocrResult.parseErrors > 0) {
        console.warn("    WARNING: No action items parsed. Raw response:");
        console.warn(
          `    ${(ocrResult.rawResponse || "").slice(0, 300)}`
        );
      }

      metrics.tasksExtracted += ocrResult.items.length;

      // 7. Apply corrections and create Notion tasks
      for (const item of ocrResult.items) {
        // Apply corrections glossary
        const { text: correctedTask, applied } = applyCorrections(
          item.task,
          corrections
        );
        if (applied > 0) {
          console.log(
            `    Corrected: "${item.task}" -> "${correctedTask}"`
          );
          metrics.correctionsApplied += applied;
        }
        item.task = correctedTask;

        // Create or deduplicate Notion task
        try {
          const project = inferProject(ocrResult.text);
          const priority = mapPriority(item.priority);
          const context = mapContext(item.context);
          const notes =
            `From Boox notebook: ${entry.filename} page ${page}. Processed locally via ${OLLAMA_MODEL}`;

          const dedupResult = await findOrCreateTask(
            {
              title: item.task,
              priority,
              context,
              source: "Boox Note (Local)",
              project,
              notes,
            },
            {
              notionDbId: NOTION_DB,
              notionPost,
              notionPatch: async (pageId, properties, appendNote) => {
                const body: Record<string, unknown> = {};
                if (Object.keys(properties).length > 0) body.properties = properties;
                if (appendNote) {
                  try {
                    const nodeFetch = (await import("node-fetch")).default;
                    const resp = await nodeFetch(`https://api.notion.com/v1/pages/${pageId}`, {
                      agent: proxyAgent,
                      headers: { "Notion-Version": "2022-06-28" },
                    } as any);
                    const pageData = (await resp.json()) as any;
                    const currentNotes = pageData.properties?.Notes?.rich_text?.map((t: any) => t.plain_text).join("") || "";
                    body.properties = {
                      ...(body.properties as Record<string, unknown> || {}),
                      Notes: { rich_text: [{ type: "text", text: { content: (currentNotes + "\n\n" + appendNote).slice(0, 2000) } }] },
                    };
                  } catch (err) {
                    console.error(`    Note append error: ${err}`);
                  }
                }
                await notionPatchPages(pageId, body);
              },
            }
          );

          if (dedupResult.action === 'created') {
            metrics.tasksCreated++;
            console.log(
              `    Created task: ${item.task.slice(0, 80)}${item.task.length > 80 ? "..." : ""}`
            );
          } else if (dedupResult.action === 'merged') {
            metrics.tasksMerged++;
            console.log(`    Merged with: ${dedupResult.mergedWith?.slice(0, 60)}`);
          } else {
            metrics.tasksSkipped++;
            console.log(`    Skipped (duplicate)`);
          }
        } catch (err) {
          console.error(
            `    Notion error: ${err instanceof Error ? err.message : String(err)}`
          );
          metrics.notionErrors++;
        }

        // Rate limit protection
        await new Promise((r) => setTimeout(r, 300));
      }

      // Mark page as processed
      state.processedPages[pageKey] = true;
      metrics.pagesProcessed++;
    }

    // Update etag only if all new pages were processed (no deferred)
    if (skipped === 0) {
      state.etags[entry.filename] = entry.etag;
    }

    // Clean up the downloaded PDF
    try {
      fs.unlinkSync(localPdfPath);
    } catch {
      // ignore
    }
  }

  // 8. Update cumulative metrics
  state.metrics.totalRuns++;
  state.metrics.totalPages += metrics.pagesProcessed;
  state.metrics.totalTasks += metrics.tasksCreated;
  state.metrics.errors += metrics.parseErrors + metrics.notionErrors;

  // Rolling average latency
  if (metrics.ollamaLatencies.length > 0) {
    const runAvg =
      metrics.ollamaLatencies.reduce((a, b) => a + b, 0) /
      metrics.ollamaLatencies.length;
    if (state.metrics.avgLatencyMs === 0) {
      state.metrics.avgLatencyMs = Math.round(runAvg);
    } else {
      // Weighted average: 70% historical, 30% current run
      state.metrics.avgLatencyMs = Math.round(
        state.metrics.avgLatencyMs * 0.7 + runAvg * 0.3
      );
    }
  }

  // 9. Save state
  state.lastCheck = new Date().toISOString();
  saveState(state);

  // 10. Cleanup temp files
  cleanupTmpDir();

  // 11. Print instrumentation report
  const avgLatency =
    metrics.ollamaLatencies.length > 0
      ? metrics.ollamaLatencies.reduce((a, b) => a + b, 0) /
        metrics.ollamaLatencies.length
      : 0;
  const totalLatency = metrics.ollamaLatencies.reduce((a, b) => a + b, 0);
  const costs = estimateCost(metrics.ollamaTokensIn, metrics.ollamaTokensOut);
  const processedPageCount = Object.keys(state.processedPages).length;

  console.log("\n=== Boox Handwriting Processing (Local) ===");
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log(`PDFs checked: ${metrics.pdfsChecked}`);
  console.log(`PDFs changed: ${metrics.pdfsChanged}`);
  console.log(`Pages processed: ${metrics.pagesProcessed}`);
  console.log(`Pages blank: ${metrics.pagesBlank}`);
  console.log(`Action items extracted: ${metrics.tasksExtracted}`);
  console.log(`Notion tasks created: ${metrics.tasksCreated}`);
  console.log(`Tasks merged (dedup): ${metrics.tasksMerged}`);
  console.log(`Tasks skipped (dedup): ${metrics.tasksSkipped}`);
  if (metrics.ollamaLatencies.length > 0) {
    console.log(
      `Ollama latency: avg ${(avgLatency / 1000).toFixed(0)}s, total ${(totalLatency / 1000).toFixed(0)}s`
    );
  }
  console.log(`API cost: $0.00 (local inference)`);
  console.log(`Equivalent Haiku cost: ${costs.haiku}`);
  console.log(`Equivalent Sonnet cost: ${costs.sonnet}`);
  console.log(`Corrections applied: ${metrics.correctionsApplied}`);
  console.log(`Parse errors: ${metrics.parseErrors}`);
  console.log(`Notion errors: ${metrics.notionErrors}`);
  console.log(`State: ${processedPageCount} pages tracked across ${Object.keys(state.etags).length} PDFs`);
  console.log(
    `Cumulative: ${state.metrics.totalRuns} runs, ${state.metrics.totalPages} pages, ${state.metrics.totalTasks} tasks, avg latency ${(state.metrics.avgLatencyMs / 1000).toFixed(0)}s`
  );

  // Log to PG so dashboard shows current status
  await logPipelineRun({
    taskId: "mc-boox-processor",
    durationMs: Math.round(totalLatency),
    status: "success",
    result: `${metrics.pagesProcessed} pages, ${metrics.tasksCreated} tasks`,
  });
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await logPipelineRun({ taskId: "mc-boox-processor", durationMs: 0, status: "error", error: String(err) }).catch(() => {});
  process.exit(1);
});
