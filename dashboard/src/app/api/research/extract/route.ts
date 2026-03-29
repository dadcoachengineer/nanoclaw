import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import os from "os";

const SUPPORTED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/msword", // doc
  "application/vnd.ms-excel", // xls
  "application/vnd.ms-powerpoint", // ppt
  "text/plain",
  "text/markdown",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
]);

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]);

const EXT_MAP: Record<string, boolean> = {
  ".pdf": true, ".docx": true, ".doc": true,
  ".pptx": true, ".ppt": true,
  ".xlsx": true, ".xls": true, ".csv": true,
  ".txt": true, ".md": true,
  ".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".heic": true,
};

/**
 * POST /api/research/extract
 * Accepts multipart form data with file uploads.
 * Returns extracted text for each file.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const formData = await req.formData();
    const results: { name: string; text: string; error?: string }[] = [];

    for (const [, value] of formData.entries()) {
      if (!(value instanceof File)) continue;
      const file = value as File;
      const ext = path.extname(file.name).toLowerCase();

      if (!EXT_MAP[ext] && !SUPPORTED_TYPES.has(file.type)) {
        results.push({ name: file.name, text: "", error: `Unsupported file type: ${ext}` });
        continue;
      }

      // Plain text files — read directly
      if (ext === ".txt" || ext === ".md" || ext === ".csv") {
        const text = await file.text();
        results.push({ name: file.name, text });
        continue;
      }

      // Images — OCR via Claude Haiku vision
      if (IMAGE_EXTS.has(ext) || file.type.startsWith("image/")) {
        try {
          const buffer = Buffer.from(await file.arrayBuffer());
          const base64 = buffer.toString("base64");
          const mediaType = file.type.startsWith("image/") ? file.type
            : ext === ".png" ? "image/png"
            : ext === ".gif" ? "image/gif"
            : ext === ".webp" ? "image/webp"
            : "image/jpeg";

          const resp = await proxiedFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 4000,
              messages: [{
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: mediaType, data: base64 },
                  },
                  {
                    type: "text",
                    text: "Extract ALL text content from this image. Include every word, number, heading, label, bullet point, and caption visible. Preserve the structure (headings, lists, paragraphs) as much as possible. If this is a handwritten document, transcribe it faithfully. If it contains a chart or diagram, describe the data. Output ONLY the extracted text, no commentary.",
                  },
                ],
              }],
            }),
          });

          const respText = await resp.text();
          let data: any;
          try {
            data = JSON.parse(respText);
          } catch {
            results.push({ name: file.name, text: "", error: `API returned non-JSON (status ${resp.status}): ${respText.slice(0, 200)}` });
            continue;
          }
          if (data.error) {
            results.push({ name: file.name, text: "", error: data.error.message || JSON.stringify(data.error) });
          } else {
            const text = data.content?.find((c: any) => c.type === "text")?.text || "";
            results.push({ name: file.name, text });
          }
          // Brief pause between image OCR calls to avoid rate limiting
          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          results.push({ name: file.name, text: "", error: `OCR failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        continue;
      }

      // Binary files — write to temp dir, extract text
      const tmpDir = path.join(os.tmpdir(), "nanoclaw-extract");
      mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(tmpDir, `${Date.now()}-${file.name}`);
      const buffer = Buffer.from(await file.arrayBuffer());
      writeFileSync(tmpPath, buffer);

      try {
        let text: string;

        if (ext === ".pdf") {
          // Use pdftotext CLI (poppler) — reliable, already installed
          const outPath = tmpPath + ".txt";
          execFileSync("/opt/homebrew/bin/pdftotext", ["-layout", tmpPath, outPath], { timeout: 30000 });
          text = readFileSync(outPath, "utf-8");
          try { unlinkSync(outPath); } catch { /* cleanup */ }
        } else {
          // Use officeparser for Office formats (docx, pptx, xlsx)
          const officeparser = await import("officeparser");
          const result = await officeparser.parseOffice(tmpPath);
          text = typeof result === "string" ? result : String(result);
        }

        results.push({ name: file.name, text });
      } catch (err) {
        results.push({ name: file.name, text: "", error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        try { unlinkSync(tmpPath); } catch { /* cleanup */ }
      }
    }

    return NextResponse.json({ files: results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
