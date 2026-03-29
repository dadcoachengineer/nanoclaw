import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  loadAuthConfig,
  verifyPassword,
  verifyTOTP,
  createSessionCookie,
} from "@/lib/auth";

export async function POST(request: Request) {
  try {
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
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    // Verify password
    if (!verifyPassword(password, config.passwordHash, config.salt)) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    // Verify TOTP
    if (!verifyTOTP(config.totpSecret, totpCode)) {
      return NextResponse.json(
        { error: "Invalid authenticator code" },
        { status: 401 },
      );
    }

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
