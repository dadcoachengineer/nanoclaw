import crypto from "crypto";
import fs from "fs";
import path from "path";

const AUTH_PATH = path.join(process.cwd(), "..", "store", "auth.json");
let _sessionSecret: string | null = null;
function getSessionSecret(): string {
  if (_sessionSecret) return _sessionSecret;
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET environment variable is required");
  }
  _sessionSecret = secret;
  return secret;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthConfig {
  username: string;
  passwordHash: string;
  salt: string;
  totpSecret: string; // base32 encoded
  setupComplete: boolean;
}

interface SessionPayload {
  username: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no external deps)
// ---------------------------------------------------------------------------

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): boolean {
  return crypto.timingSafeEqual(
    Buffer.from(hashPassword(password, salt)),
    Buffer.from(hash),
  );
}

// ---------------------------------------------------------------------------
// Base32 encode / decode (RFC 4648, no padding, uppercase A-Z2-7)
// ---------------------------------------------------------------------------

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_CHARS[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/[=\s]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — HMAC-SHA1, 30-second windows, 6 digits
// ---------------------------------------------------------------------------

function generateHOTP(secret: string, counter: number): string {
  const key = base32Decode(secret);

  // Counter as 8-byte big-endian buffer.
  // TOTP counters fit comfortably in a JS number (53-bit safe integer),
  // so we split into high 32 bits and low 32 bits without BigInt.
  const counterBuf = Buffer.alloc(8);
  const lo = counter & 0xffffffff;
  const hi = Math.floor(counter / 0x100000000) & 0xffffffff;
  counterBuf.writeUInt32BE(hi, 0);
  counterBuf.writeUInt32BE(lo >>> 0, 4);

  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();

  // Dynamic truncation (RFC 4226 section 5.4)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, "0");
}

export function generateTOTP(secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / 30);
  return generateHOTP(secret, counter);
}

export function verifyTOTP(secret: string, code: string): boolean {
  const now = Math.floor(Date.now() / 1000 / 30);
  // Check current window and +/- 1 for clock skew
  for (let offset = -1; offset <= 1; offset++) {
    if (generateHOTP(secret, now + offset) === code) {
      return true;
    }
  }
  return false;
}

export function generateTOTPSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function getTOTPAuthURL(secret: string, username: string): string {
  const issuer = "NanoClaw";
  const label = `${issuer}:${username}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------------------
// Session encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

function deriveKey(): Buffer {
  return crypto.createHash("sha256").update(getSessionSecret()).digest();
}

export function encryptSession(data: SessionPayload): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // iv (12) + encrypted + authTag (16)
  return Buffer.concat([iv, encrypted, authTag]).toString("base64url");
}

export function decryptSession(token: string): SessionPayload | null {
  try {
    const key = deriveKey();
    const raw = Buffer.from(token, "base64url");

    if (raw.length < 12 + 16) return null;

    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(raw.length - 16);
    const encrypted = raw.subarray(12, raw.length - 16);

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    const payload = JSON.parse(decrypted.toString("utf8")) as SessionPayload;

    if (!payload.username || !payload.expiresAt) return null;
    if (Date.now() > payload.expiresAt) return null;

    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth config persistence (store/auth.json)
// ---------------------------------------------------------------------------

export function loadAuthConfig(): AuthConfig | null {
  try {
    if (!fs.existsSync(AUTH_PATH)) return null;
    const raw = fs.readFileSync(AUTH_PATH, "utf-8");
    return JSON.parse(raw) as AuthConfig;
  } catch {
    return null;
  }
}

export function saveAuthConfig(config: AuthConfig): void {
  const dir = path.dirname(AUTH_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUTH_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function needsSetup(): boolean {
  const config = loadAuthConfig();
  return !config || !config.setupComplete;
}

// ---------------------------------------------------------------------------
// Cookie helpers (for API route handlers)
// ---------------------------------------------------------------------------

const COOKIE_NAME = "mc-session";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function createSessionCookie(): {
  name: string;
  value: string;
  options: Record<string, unknown>;
} {
  const config = loadAuthConfig();
  if (!config) throw new Error("Auth not configured");

  const token = encryptSession({
    username: config.username,
    expiresAt: Date.now() + SEVEN_DAYS_MS,
  });

  return {
    name: COOKIE_NAME,
    value: token,
    options: {
      httpOnly: true,
      secure: true,
      sameSite: "strict" as const,
      path: "/",
      maxAge: 7 * 24 * 60 * 60, // seconds
    },
  };
}

export function validateSessionCookie(
  cookieValue: string | undefined,
): SessionPayload | null {
  if (!cookieValue) return null;
  return decryptSession(cookieValue);
}
