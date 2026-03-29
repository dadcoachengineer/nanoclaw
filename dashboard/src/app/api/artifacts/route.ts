import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const ARTIFACTS_DIR = path.join(STORE_DIR, "artifacts");

interface ArtifactMeta {
  id: string;
  title: string;
  intent: string;
  taskId?: string;
  taskTitle?: string;
  project?: string;
  sources: string[];
  mentionedPeople: string[];
  createdAt: string;
  filename: string;
  charCount: number;
}

function ensureDir() {
  if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function loadIndex(): ArtifactMeta[] {
  const indexPath = path.join(ARTIFACTS_DIR, "index.json");
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  } catch {
    return [];
  }
}

function saveIndex(index: ArtifactMeta[]) {
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "index.json"), JSON.stringify(index, null, 2));
}

/**
 * GET /api/artifacts?taskId=xxx  — list artifacts, optionally filtered by task
 * GET /api/artifacts?id=xxx      — get a single artifact's content
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  const taskId = searchParams.get("taskId");
  const person = searchParams.get("person");
  const project = searchParams.get("project");

  const index = loadIndex();

  // Single artifact by ID
  if (id) {
    const meta = index.find((a) => a.id === id);
    if (!meta) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      const content = fs.readFileSync(path.join(ARTIFACTS_DIR, meta.filename), "utf-8");
      return NextResponse.json({ ...meta, content });
    } catch {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  }

  // List with filters
  let filtered = index;
  if (taskId) filtered = filtered.filter((a) => a.taskId === taskId);
  if (person) {
    const pLower = person.toLowerCase();
    filtered = filtered.filter((a) =>
      (a.mentionedPeople || []).some((p) => p.toLowerCase().includes(pLower))
    );
  }
  if (project) {
    const projLower = project.toLowerCase();
    filtered = filtered.filter((a) => a.project?.toLowerCase().includes(projLower));
  }
  return NextResponse.json(filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

/**
 * POST /api/artifacts
 * Body: { title, content, intent, taskId?, taskTitle?, project?, sources? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { title, content, intent, taskId, taskTitle, project, sources } = body;

    if (!title || !content) {
      return NextResponse.json({ error: "title and content required" }, { status: 400 });
    }

    ensureDir();

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const id = `${dateStr}-${slugify(title)}-${Date.now().toString(36)}`;
    const filename = `${id}.md`;

    // Write the markdown file with frontmatter
    const frontmatter = [
      "---",
      `title: "${title.replace(/"/g, '\\"')}"`,
      `intent: "${(intent || "research").replace(/"/g, '\\"')}"`,
      `created: "${now.toISOString()}"`,
      taskId ? `taskId: "${taskId}"` : null,
      taskTitle ? `taskTitle: "${taskTitle.replace(/"/g, '\\"')}"` : null,
      project ? `project: "${project.replace(/"/g, '\\"')}"` : null,
      sources?.length ? `sources: ${JSON.stringify(sources)}` : null,
      "---",
      "",
    ].filter(Boolean).join("\n");

    // Extract mentioned people from the content using the person index
    let mentionedPeople: string[] = [];
    try {
      const personIndex = JSON.parse(fs.readFileSync(path.join(STORE_DIR, "person-index.json"), "utf-8"));
      const contentLower = content.toLowerCase();
      for (const [, person] of Object.entries(personIndex)) {
        const name = (person as any).name as string;
        if (!name || name.length < 4) continue;
        // Word-boundary match on full name
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`, "i").test(content)) {
          mentionedPeople.push(name);
        }
      }
    } catch { /* continue without */ }

    fs.writeFileSync(path.join(ARTIFACTS_DIR, filename), frontmatter + content);

    // Update index
    const index = loadIndex();
    const meta: ArtifactMeta = {
      id, title, intent: intent || "research", taskId, taskTitle, project,
      sources: sources || [], mentionedPeople, createdAt: now.toISOString(), filename,
      charCount: content.length,
    };
    index.unshift(meta);
    saveIndex(index);

    // Index in vector DB for future search
    try {
      const projectRoot = process.env.NANOCLAW_ROOT || path.join(process.cwd(), "..");
      // Chunk the content and insert into vectors.db
      const chunks = content.match(/.{1,500}/gs) || [content];
      const insertScript = `
        const D=require("better-sqlite3");
        const db=new D(process.argv[1]);
        const src="artifact";
        const chunks=JSON.parse(process.argv[2]);
        const ins=db.prepare("INSERT INTO chunks (source, text) VALUES (?, ?)");
        for(const c of chunks) ins.run(src, c);
        db.close();
        console.log(JSON.stringify({indexed:chunks.length}));
      `;
      execFileSync("node", [
        "-e", insertScript,
        path.join(STORE_DIR, "vectors.db"),
        JSON.stringify(chunks.slice(0, 20).map((c: string) => `Artifact "${title}": ${c}`)),
      ], { cwd: projectRoot, timeout: 10000, encoding: "utf-8" });
    } catch {
      // Indexing is best-effort
    }

    // Add reference to Notion task notes if taskId provided
    if (taskId) {
      try {
        const { proxiedFetch } = await import("@/lib/onecli");
        await proxiedFetch(`https://api.notion.com/v1/pages/${taskId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
          },
          body: JSON.stringify({
            properties: {
              Notes: {
                rich_text: [{
                  text: { content: `\n[Artifact: ${title}] (${dateStr})` },
                }],
              },
            },
          }),
        });
      } catch {
        // Notion link is best-effort
      }
    }

    return NextResponse.json(meta);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
