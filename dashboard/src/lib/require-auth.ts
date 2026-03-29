import { cookies } from "next/headers";
import { decryptSession } from "./auth";

/**
 * Validate the session cookie in API route handlers (Node.js runtime).
 * Returns the authenticated user or null if the session is invalid/expired.
 */
export async function requireAuth(): Promise<{ username: string } | null> {
  const cookieStore = await cookies();
  const session = cookieStore.get("mc-session");
  if (!session?.value) return null;
  const data = decryptSession(session.value);
  if (!data) return null;
  if (data.expiresAt < Date.now()) return null;
  return { username: data.username };
}
