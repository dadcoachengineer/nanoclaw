import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Middleware that validates session tokens using HMAC-SHA256 via Web Crypto API.
 * This runs in Edge runtime — no Node.js crypto needed.
 * Invalid or expired sessions are rejected at the door.
 */

interface SessionPayload {
  username: string;
  expiresAt: number;
}

async function verifySession(
  token: string,
  secret: string
): Promise<SessionPayload | null> {
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // Decode base64url signature
    const sigB64 = sig.replace(/-/g, "+").replace(/_/g, "/");
    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      encoder.encode(payload)
    );

    if (!valid) return null;

    const payloadB64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const data = JSON.parse(atob(payloadB64)) as SessionPayload;

    if (!data.username || !data.expiresAt) return null;
    if (Date.now() > data.expiresAt) return null;

    return data;
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public routes — no auth required
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname === "/api/health" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // Get session cookie
  const sessionCookie = request.cookies.get("mc-session");
  if (!sessionCookie?.value) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Validate the session — HMAC signature + expiry check
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // No secret configured — reject everything
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const session = await verifySession(sessionCookie.value, secret);
  if (!session) {
    // Invalid or expired session — clear the bad cookie and redirect
    const response = pathname.startsWith("/api/")
      ? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      : NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("mc-session");
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
