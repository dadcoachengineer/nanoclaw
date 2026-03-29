import crypto from "crypto";
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import {
  loadAuthConfig,
  saveAuthConfig,
  hashPassword,
  generateTOTPSecret,
  getTOTPAuthURL,
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
        { error: `Too many attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.` },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    const body = await request.json();

    // ----- Step 2: verify TOTP code to finalize setup -----
    if (body.action === "verify") {
      const config = loadAuthConfig();
      if (!config) {
        return NextResponse.json(
          { error: "Setup not started. Create credentials first." },
          { status: 400 },
        );
      }
      if (config.setupComplete) {
        return NextResponse.json(
          { error: "Setup already complete" },
          { status: 400 },
        );
      }

      const { code } = body;
      if (!code || typeof code !== "string" || code.length !== 6) {
        return NextResponse.json(
          { error: "A 6-digit code is required" },
          { status: 400 },
        );
      }

      if (!verifyTOTP(config.totpSecret, code)) {
        recordFailedAttempt(ip);
        return NextResponse.json(
          { error: "Invalid code. Make sure the time on your device is correct and try again." },
          { status: 400 },
        );
      }

      clearAttempts(ip);

      // Mark setup as complete
      config.setupComplete = true;
      saveAuthConfig(config);

      // Create session cookie
      const session = createSessionCookie();
      const cookieStore = await cookies();
      cookieStore.set(session.name, session.value, session.options);

      return NextResponse.json({ ok: true });
    }

    // ----- Step 1: create credentials + generate TOTP secret -----
    const { username, password } = body;

    if (!username || typeof username !== "string" || !username.trim()) {
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 },
      );
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 },
      );
    }

    // Don't allow re-setup if already complete
    const existing = loadAuthConfig();
    if (existing?.setupComplete) {
      return NextResponse.json(
        { error: "Setup already complete. Use login instead." },
        { status: 400 },
      );
    }

    const salt = crypto.randomBytes(32).toString("hex");
    const passwordHash = hashPassword(password, salt);
    const totpSecret = generateTOTPSecret();
    const totpAuthURL = getTOTPAuthURL(totpSecret, username.trim());

    saveAuthConfig({
      username: username.trim(),
      passwordHash,
      salt,
      totpSecret,
      setupComplete: false,
    });

    return NextResponse.json({ totpSecret, totpAuthURL });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
