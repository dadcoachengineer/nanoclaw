import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { needsSetup, validateSessionCookie } from "@/lib/auth";

export async function GET() {
  const setup = needsSetup();

  if (setup) {
    return NextResponse.json({ needsSetup: true, authenticated: false });
  }

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("mc-session");
  const session = validateSessionCookie(sessionCookie?.value);

  return NextResponse.json({
    needsSetup: false,
    authenticated: !!session,
  });
}
