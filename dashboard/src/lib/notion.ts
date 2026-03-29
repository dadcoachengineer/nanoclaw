/**
 * Notion API helpers and type definitions for Mission Control.
 */

export const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

export interface NotionPage {
  id: string;
  properties: Record<string, NotionProperty>;
  last_edited_time: string;
  url: string;
}

interface NotionProperty {
  type: string;
  title?: { plain_text: string }[];
  select?: { name: string } | null;
  rich_text?: { plain_text: string }[];
  date?: { start: string } | null;
  multi_select?: { name: string }[];
}

export function prop(page: NotionPage, name: string): string {
  const p = page.properties?.[name];
  if (!p) return "";
  if (p.type === "title")
    return p.title?.map((t) => t.plain_text).join("") || "";
  if (p.type === "select") return p.select?.name || "";
  if (p.type === "status") return (p as { status?: { name: string } }).status?.name || "";
  if (p.type === "rich_text")
    return p.rich_text?.map((t) => t.plain_text).join("") || "";
  if (p.type === "date") return p.date?.start || "";
  return "";
}

export function priorityRank(p: string): number {
  if (p.includes("P0")) return 0;
  if (p.includes("P1")) return 1;
  if (p.includes("P2")) return 2;
  return 3;
}

export async function queryNotion(
  filter: Record<string, unknown>,
  sorts?: Record<string, unknown>[]
): Promise<NotionPage[]> {
  const resp = await fetch("/api/notion/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      database_id: NOTION_DB,
      filter,
      sorts: sorts || [{ property: "Priority", direction: "ascending" }],
    }),
  });
  if (resp.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/login";
    return [];
  }
  const data = await resp.json();
  return data.results || [];
}
