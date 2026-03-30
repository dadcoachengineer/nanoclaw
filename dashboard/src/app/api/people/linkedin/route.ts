import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * POST /api/people/linkedin
 * Body: { key: string, linkedinUrl: string }
 *
 * Fetches the LinkedIn public profile page and extracts available data.
 * LinkedIn blocks unauthenticated scraping, so we extract what we can from
 * the page metadata and Open Graph tags.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { key, linkedinUrl } = await req.json();
    if (!key || !linkedinUrl) {
      return NextResponse.json({ error: "key and linkedinUrl required" }, { status: 400 });
    }

    // Validate it's a LinkedIn URL
    if (!linkedinUrl.includes("linkedin.com/in/")) {
      return NextResponse.json({ error: "Not a valid LinkedIn profile URL" }, { status: 400 });
    }

    const extracted: { title?: string; company?: string; headline?: string; image?: string; location?: string } = {};

    // Try fetching — LinkedIn returns limited data but OG tags and meta are often available
    try {
      const resp = await fetch(linkedinUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          "Accept": "text/html",
        },
        redirect: "follow",
      });
      const html = await resp.text();

      // Extract Open Graph tags (LinkedIn serves these even on auth walls)
      const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/)?.[1];
      const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/)?.[1];
      const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/)?.[1];

      if (ogTitle) {
        // OG title format: "Name - Title - Company | LinkedIn"
        const parts = ogTitle.split(" - ");
        if (parts.length >= 3) {
          extracted.title = parts[1]?.trim();
          extracted.company = parts[2]?.replace(/\s*\|.*/, "").trim();
        } else if (parts.length === 2) {
          extracted.headline = parts[1]?.replace(/\s*\|.*/, "").trim();
        }
      }
      if (ogDesc) extracted.headline = ogDesc.replace(/\s*·.*/, "").trim();
      if (ogImage && !ogImage.includes("ghost")) extracted.image = ogImage;
    } catch {
      // Fetch failed — continue with just saving the URL
    }

    // Save to PG
    const normalizedKey = key.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    const person = await sqlOne<{ id: string; job_title: string | null; company: string | null; avatar: string | null }>(
      "SELECT id, job_title, company, avatar FROM people WHERE key = $1",
      [normalizedKey]
    );

    let saved = false;
    if (person) {
      const sets: string[] = ["linkedin_url = $1", "updated_at = now()"];
      const vals: any[] = [linkedinUrl];
      let idx = 2;

      if (extracted.title && !person.job_title) { sets.push(`job_title = $${idx}`); vals.push(extracted.title); idx++; }
      if (extracted.company && !person.company) { sets.push(`company = $${idx}`); vals.push(extracted.company); idx++; }
      if (extracted.headline) { sets.push(`linkedin_headline = $${idx}`); vals.push(extracted.headline); idx++; }
      if (extracted.image && !person.avatar) { sets.push(`avatar = $${idx}`); vals.push(extracted.image); idx++; }

      vals.push(person.id);
      await sql(`UPDATE people SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
      saved = true;
    }

    return NextResponse.json({ extracted, saved });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
