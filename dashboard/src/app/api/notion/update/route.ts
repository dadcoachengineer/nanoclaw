import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { page_id, properties, comment } = body;

    // Update the page properties (e.g. Status → Done)
    const resp = await proxiedFetch(
      `https://api.notion.com/v1/pages/${page_id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify({ properties }),
      }
    );

    const data = await resp.json();

    // If there's a note to append, update the Notes rich_text property
    const appendNote = body.appendNote as string | undefined;
    if (appendNote) {
      // Fetch current page to get existing notes
      const pageResp = await proxiedFetch(
        `https://api.notion.com/v1/pages/${page_id}`,
        { headers: { "Notion-Version": "2022-06-28" } }
      );
      const pageData = await pageResp.json() as { properties?: { Notes?: { rich_text?: { plain_text: string }[] } } };
      const existingNotes = pageData.properties?.Notes?.rich_text?.map((t: { plain_text: string }) => t.plain_text).join("") || "";
      const timestamp = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const newNotes = existingNotes
        ? `${existingNotes}\n\n[${timestamp}] ${appendNote}`
        : `[${timestamp}] ${appendNote}`;

      await proxiedFetch(
        `https://api.notion.com/v1/pages/${page_id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
          },
          body: JSON.stringify({
            properties: {
              Notes: { rich_text: [{ type: "text", text: { content: newNotes } }] },
            },
          }),
        }
      );
    }

    // If there's a comment, append it to the page as a comment
    if (comment) {
      await proxiedFetch("https://api.notion.com/v1/comments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify({
          parent: { page_id },
          rich_text: [
            {
              type: "text",
              text: { content: comment },
            },
          ],
        }),
      });
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
