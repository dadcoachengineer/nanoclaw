/**
 * Simple in-memory IP-based rate limiter.
 * Tracks failed attempts per IP in a sliding window.
 */

interface AttemptRecord {
  timestamps: number[];
}

const store = new Map<string, AttemptRecord>();

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now();
  for (const [ip, record] of store) {
    record.timestamps = record.timestamps.filter((t) => t > cutoff - WINDOW_MS);
    if (record.timestamps.length === 0) store.delete(ip);
  }
}, 10 * 60 * 1000);

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function isRateLimited(ip: string): { limited: boolean; retryAfterSec: number } {
  const record = store.get(ip);
  if (!record) return { limited: false, retryAfterSec: 0 };

  const now = Date.now();
  // Remove expired timestamps
  record.timestamps = record.timestamps.filter((t) => t > now - WINDOW_MS);

  if (record.timestamps.length >= MAX_ATTEMPTS) {
    const oldest = record.timestamps[0];
    const retryAfterSec = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    return { limited: true, retryAfterSec };
  }

  return { limited: false, retryAfterSec: 0 };
}

export function recordFailedAttempt(ip: string): void {
  const record = store.get(ip) || { timestamps: [] };
  record.timestamps.push(Date.now());
  store.set(ip, record);
}

export function clearAttempts(ip: string): void {
  store.delete(ip);
}
