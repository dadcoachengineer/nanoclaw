import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");

/**
 * GET /api/people/lookup?name=Michael+Parker
 * GET /api/people/lookup?email=mparker@dbs-poe.com
 *
 * Tries multiple strategies to find profile data:
 * 1. Webex People API (by email or displayName)
 * 2. Webex room membership scan (if person has a known room ID)
 * 3. Person index enrichment (existing messages/meetings context)
 *
 * Returns: { results: [{ displayName, email, title, company, avatar, source }] }
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const name = searchParams.get("name");
  const email = searchParams.get("email");

  if (!name && !email) {
    return NextResponse.json({ error: "name or email required" }, { status: 400 });
  }

  const results: {
    displayName: string;
    email?: string;
    title?: string;
    company?: string;
    avatar?: string;
    source: string;
  }[] = [];

  // Strategy 1: Webex People API
  try {
    const query = email
      ? `email=${encodeURIComponent(email)}`
      : `displayName=${encodeURIComponent(name!)}&max=5`;

    const resp = await proxiedFetch(
      `https://webexapis.com/v1/people?${query}`,
      { headers: { "Content-Type": "application/json" } }
    );
    const data = (await resp.json()) as { items?: any[] };

    for (const p of data.items || []) {
      results.push({
        displayName: p.displayName || "",
        email: p.emails?.[0] || "",
        title: p.title || "",
        company: p.orgId ? "Cisco" : "",
        avatar: p.avatar || "",
        source: "webex",
      });
    }
  } catch { /* continue */ }

  // Strategy 2: Check person index for room IDs, then look up room membership
  if (results.length === 0 && name) {
    try {
      const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
      const key = name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
      const person = index[key];

      if (person?.webexRoomIds?.length) {
        // Get room membership to find the person's Webex profile
        const roomId = person.webexRoomIds[0];
        const resp = await proxiedFetch(
          `https://webexapis.com/v1/memberships?roomId=${encodeURIComponent(roomId)}&max=10`,
          { headers: { "Content-Type": "application/json" } }
        );
        const data = (await resp.json()) as { items?: any[] };

        for (const m of data.items || []) {
          // Match by name (the person's display name in the room)
          if (m.personDisplayName?.toLowerCase().includes(name.toLowerCase().split(" ")[0])) {
            // Now get their full profile
            try {
              const profileResp = await proxiedFetch(
                `https://webexapis.com/v1/people/${m.personId}`,
                { headers: { "Content-Type": "application/json" } }
              );
              const profile = await profileResp.json() as any;
              if (profile.displayName) {
                results.push({
                  displayName: profile.displayName,
                  email: profile.emails?.[0] || m.personEmail || "",
                  title: profile.title || "",
                  company: profile.orgId ? "Cisco" : "",
                  avatar: profile.avatar || "",
                  source: "webex-room",
                });
              }
            } catch { /* continue */ }
          }
        }
      }
    } catch { /* continue */ }
  }

  // Strategy 3: Enrich from person index context (extract company/role from messages)
  if (name) {
    try {
      const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
      const key = name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
      const person = index[key];
      if (person && (person.emails?.length || person.company)) {
        results.push({
          displayName: person.name,
          email: person.emails?.[0] || "",
          title: person.jobTitle || "",
          company: person.company || "",
          avatar: "",
          source: "index",
        });
      }
    } catch { /* continue */ }
  }

  return NextResponse.json({ results });
}
