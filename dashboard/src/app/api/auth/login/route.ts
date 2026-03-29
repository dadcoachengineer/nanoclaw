import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import {
  loadAuthConfig,
  verifyPassword,
  verifyTOTP,
  createSessionCookie,
} from "@/lib/auth";
import { isRateLimited, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const hdrs = await headers();
    const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim()
      || hdrs.get("x-real-ip")
      || "unknown";

    // Rate limit check
    const { limited, retryAfterSec } = isRateLimited(ip);
    if (limited) {
      return NextResponse.json(
        { error: `Too many login attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.` },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    const body = await request.json();
    const { username, password, totpCode } = body;

    if (!username || !password || !totpCode) {
      return NextResponse.json(
        { error: "All fields are required" },
        { status: 400 },
      );
    }

    const config = loadAuthConfig();
    if (!config || !config.setupComplete) {
      return NextResponse.json(
        { error: "Setup not complete" },
        { status: 400 },
      );
    }

    // Verify username
    if (username !== config.username) {
      recordFailedAttempt(ip);
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    // Verify password
    if (!verifyPassword(password, config.passwordHash, config.salt)) {
      recordFailedAttempt(ip);
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    // Verify TOTP
    if (!verifyTOTP(config.totpSecret, totpCode)) {
      recordFailedAttempt(ip);
      return NextResponse.json(
        { error: "Invalid authenticator code" },
        { status: 401 },
      );
    }

    // Successful login — clear rate limit history
    clearAttempts(ip);

    // Create session
    const session = createSessionCookie();
    const cookieStore = await cookies();
    cookieStore.set(session.name, session.value, session.options);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
