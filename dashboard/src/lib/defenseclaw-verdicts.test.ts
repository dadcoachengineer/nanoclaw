/**
 * DefenseClaw recent verdicts log parsing tests (v3 harness)
 *
 * Tests the gateway log parsing added to /api/defenseclaw GET handler:
 * - ANSI strip from raw gateway log lines
 * - Field extraction: time, direction, model, severity, tokens
 * - Color-coded severity mapping
 * - Log line format variations (different DefenseClaw versions)
 * - Graceful handling of malformed/empty logs
 * - Limit to last 15 entries
 */
import { describe, it, expect } from 'vitest';

// ─── Log parser (extracted from defenseclaw route.ts) ─────────

interface VerdictEntry {
  time: string;
  direction: 'inbound' | 'outbound';
  model: string;
  severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  tokens: number;
}

/**
 * Strip ANSI escape codes from a string.
 * DefenseClaw gateway logs are colorized by default.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Parse a single DefenseClaw gateway log line into a VerdictEntry.
 * Expected format (after ANSI strip):
 *   2026-04-02T16:30:45Z | inbound | claude-sonnet-4-20250514 | NONE | 1234 tokens
 *   2026-04-02T16:30:46Z | outbound | claude-sonnet-4-20250514 | MEDIUM | 5678 tokens
 *
 * Returns null if the line doesn't match the verdict format.
 */
function parseVerdictLine(line: string): VerdictEntry | null {
  const clean = stripAnsi(line).trim();
  if (!clean) return null;

  // Split on pipe delimiter
  const parts = clean.split('|').map((p) => p.trim());
  if (parts.length < 5) return null;

  const [time, direction, model, severity, tokenStr] = parts;

  // Validate direction
  if (direction !== 'inbound' && direction !== 'outbound') return null;

  // Validate severity
  const validSeverities = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  if (!validSeverities.includes(severity)) return null;

  // Extract token count
  const tokenMatch = tokenStr.match(/(\d+)/);
  const tokens = tokenMatch ? parseInt(tokenMatch[1], 10) : 0;

  return {
    time,
    direction: direction as 'inbound' | 'outbound',
    model,
    severity: severity as VerdictEntry['severity'],
    tokens,
  };
}

/**
 * Parse multiple log lines and return the last N verdict entries.
 */
function parseVerdictLog(logText: string, limit = 15): VerdictEntry[] {
  const lines = logText.split('\n');
  const entries: VerdictEntry[] = [];
  for (const line of lines) {
    const entry = parseVerdictLine(line);
    if (entry) entries.push(entry);
  }
  return entries.slice(-limit);
}

// ─── ANSI Stripping Tests ─────────────────────────────────────

describe('stripAnsi', () => {
  it('removes color codes from log lines', () => {
    const colored = '\x1B[32m2026-04-02T16:30:45Z\x1B[0m | \x1B[36minbound\x1B[0m | model | \x1B[33mMEDIUM\x1B[0m | 100 tokens';
    const clean = stripAnsi(colored);
    expect(clean).toBe('2026-04-02T16:30:45Z | inbound | model | MEDIUM | 100 tokens');
    expect(clean).not.toContain('\x1B');
  });

  it('handles bold + color combinations', () => {
    const bold = '\x1B[1;31mCRITICAL\x1B[0m';
    expect(stripAnsi(bold)).toBe('CRITICAL');
  });

  it('passes through clean strings unchanged', () => {
    const clean = '2026-04-02T16:30:45Z | inbound | model | NONE | 50 tokens';
    expect(stripAnsi(clean)).toBe(clean);
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

// ─── Single Line Parsing Tests ────────────────────────────────

describe('parseVerdictLine', () => {
  it('parses a standard inbound verdict line', () => {
    const line = '2026-04-02T16:30:45Z | inbound | claude-sonnet-4-20250514 | NONE | 1234 tokens';
    const entry = parseVerdictLine(line);
    expect(entry).toEqual({
      time: '2026-04-02T16:30:45Z',
      direction: 'inbound',
      model: 'claude-sonnet-4-20250514',
      severity: 'NONE',
      tokens: 1234,
    });
  });

  it('parses an outbound verdict with MEDIUM severity', () => {
    const line = '2026-04-02T16:30:46Z | outbound | claude-sonnet-4-20250514 | MEDIUM | 5678 tokens';
    const entry = parseVerdictLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('outbound');
    expect(entry!.severity).toBe('MEDIUM');
    expect(entry!.tokens).toBe(5678);
  });

  it('parses CRITICAL severity', () => {
    const line = '2026-04-02T16:31:00Z | inbound | gemma3:27b | CRITICAL | 99 tokens';
    const entry = parseVerdictLine(line);
    expect(entry!.severity).toBe('CRITICAL');
  });

  it('parses HIGH severity', () => {
    const line = '2026-04-02T16:31:01Z | outbound | qwen2.5:14b | HIGH | 200 tokens';
    const entry = parseVerdictLine(line);
    expect(entry!.severity).toBe('HIGH');
  });

  it('parses LOW severity', () => {
    const line = '2026-04-02T16:31:02Z | inbound | gemma3:27b | LOW | 50 tokens';
    const entry = parseVerdictLine(line);
    expect(entry!.severity).toBe('LOW');
  });

  it('handles ANSI-colored input', () => {
    const line = '\x1B[32m2026-04-02T16:30:45Z\x1B[0m | \x1B[36minbound\x1B[0m | \x1B[34mclaude-sonnet-4-20250514\x1B[0m | \x1B[32mNONE\x1B[0m | \x1B[37m1234 tokens\x1B[0m';
    const entry = parseVerdictLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.model).toBe('claude-sonnet-4-20250514');
    expect(entry!.tokens).toBe(1234);
  });

  it('returns null for empty line', () => {
    expect(parseVerdictLine('')).toBeNull();
    expect(parseVerdictLine('   ')).toBeNull();
  });

  it('returns null for non-verdict log lines', () => {
    // Info log, not a verdict
    expect(parseVerdictLine('INFO: DefenseClaw started on port 9001')).toBeNull();
    // Too few pipe-delimited fields
    expect(parseVerdictLine('2026-04-02 | partial')).toBeNull();
  });

  it('returns null for invalid direction', () => {
    const line = '2026-04-02T16:30:45Z | sideways | model | NONE | 100 tokens';
    expect(parseVerdictLine(line)).toBeNull();
  });

  it('returns null for invalid severity', () => {
    const line = '2026-04-02T16:30:45Z | inbound | model | BANANA | 100 tokens';
    expect(parseVerdictLine(line)).toBeNull();
  });

  it('handles token count without "tokens" suffix', () => {
    const line = '2026-04-02T16:30:45Z | inbound | model | NONE | 500';
    const entry = parseVerdictLine(line);
    expect(entry!.tokens).toBe(500);
  });

  it('handles zero tokens', () => {
    const line = '2026-04-02T16:30:45Z | inbound | model | NONE | 0 tokens';
    const entry = parseVerdictLine(line);
    expect(entry!.tokens).toBe(0);
  });
});

// ─── Multi-Line Log Parsing Tests ─────────────────────────────

describe('parseVerdictLog', () => {
  const sampleLog = [
    '2026-04-02T16:30:45Z | inbound | claude-sonnet-4-20250514 | NONE | 1234 tokens',
    'INFO: health check ok',
    '2026-04-02T16:30:46Z | outbound | claude-sonnet-4-20250514 | NONE | 5678 tokens',
    '2026-04-02T16:31:00Z | inbound | gemma3:27b | MEDIUM | 99 tokens',
    '',
    '2026-04-02T16:31:01Z | outbound | gemma3:27b | NONE | 200 tokens',
  ].join('\n');

  it('parses only verdict lines, skipping info/empty lines', () => {
    const entries = parseVerdictLog(sampleLog);
    expect(entries).toHaveLength(4);
    expect(entries[0].model).toBe('claude-sonnet-4-20250514');
    expect(entries[2].model).toBe('gemma3:27b');
  });

  it('limits to last N entries', () => {
    const entries = parseVerdictLog(sampleLog, 2);
    expect(entries).toHaveLength(2);
    // Should be the LAST 2 entries
    expect(entries[0].model).toBe('gemma3:27b');
    expect(entries[0].severity).toBe('MEDIUM');
    expect(entries[1].model).toBe('gemma3:27b');
    expect(entries[1].direction).toBe('outbound');
  });

  it('defaults to limit of 15', () => {
    // Generate 20 verdict lines
    const lines = Array.from({ length: 20 }, (_, i) =>
      `2026-04-02T16:${String(i).padStart(2, '0')}:00Z | inbound | model | NONE | ${i * 10} tokens`,
    ).join('\n');

    const entries = parseVerdictLog(lines);
    expect(entries).toHaveLength(15);
    // Should be entries 5-19 (last 15)
    expect(entries[0].tokens).toBe(50);
    expect(entries[14].tokens).toBe(190);
  });

  it('handles empty log', () => {
    expect(parseVerdictLog('')).toHaveLength(0);
  });

  it('handles log with no verdict lines', () => {
    const log = 'INFO: started\nDEBUG: ready\nINFO: listening on :9001';
    expect(parseVerdictLog(log)).toHaveLength(0);
  });
});

// ─── Severity Color Mapping Contract ──────────────────────────

describe('severity color mapping contract', () => {
  // The frontend uses these severities for color-coding.
  // This test documents the expected mapping for the dashboard UI.
  const severityColors: Record<string, string> = {
    NONE: 'green',     // No findings
    LOW: 'yellow',     // Minor concern
    MEDIUM: 'orange',  // Moderate risk
    HIGH: 'red',       // High risk, likely blocked in action mode
    CRITICAL: 'red',   // Definite block in action mode
  };

  it('all valid severities have color assignments', () => {
    const validSeverities = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    for (const sev of validSeverities) {
      expect(severityColors[sev]).toBeDefined();
    }
  });

  it('NONE is green (safe)', () => {
    expect(severityColors.NONE).toBe('green');
  });

  it('CRITICAL is red (blocked)', () => {
    expect(severityColors.CRITICAL).toBe('red');
  });
});
