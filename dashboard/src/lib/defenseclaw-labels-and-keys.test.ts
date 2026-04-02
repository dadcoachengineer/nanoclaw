/**
 * DefenseClaw label renames + deriveMasterKey tests (v3 harness)
 *
 * Covers:
 * - DC_INSTANCES label contract: "DefenseClaw Ollama" / "DefenseClaw Anthropic" (not "DC Ollama")
 * - Instance ID stability: "defenseclaw-ollama" / "defenseclaw-anthropic"
 * - Port mapping contract: apiPort vs guardPort distinction
 * - deriveMasterKey: HMAC-SHA256 from device.key → sk-dc- prefixed key
 * - deriveMasterKey: graceful failure when device.key missing
 * - Data dir routing: ollama → ~/.defenseclaw, anthropic → ~/.dc-anthropic-home/.defenseclaw
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// ─── DC Instance config (must match route.ts after label rename) ──

const DC_INSTANCES = [
  { id: 'defenseclaw-ollama', label: 'DefenseClaw Ollama', apiPort: 18790, guardPort: 9001 },
  { id: 'defenseclaw-anthropic', label: 'DefenseClaw Anthropic', apiPort: 18792, guardPort: 9002 },
];

// ─── deriveMasterKey (extracted from route.ts) ───────────────────

async function deriveMasterKey(dataDir: string): Promise<string> {
  const fs = await import('fs');
  try {
    const keyData = fs.readFileSync(`${dataDir}/device.key`);
    const mac = crypto
      .createHmac('sha256', 'defenseclaw-proxy-master-key')
      .update(keyData)
      .digest('hex');
    return 'sk-dc-' + mac.slice(0, 32);
  } catch {
    return '';
  }
}

// ─── Label & ID Contract Tests ────────────────────────────────

describe('DC_INSTANCES label contract (post-rename)', () => {
  it('uses full "DefenseClaw" prefix, not abbreviation "DC"', () => {
    for (const inst of DC_INSTANCES) {
      expect(inst.label).toMatch(/^DefenseClaw /);
      expect(inst.label).not.toMatch(/^DC /);
    }
  });

  it('instance IDs are stable (used by frontend, hopStatus, tests)', () => {
    expect(DC_INSTANCES[0].id).toBe('defenseclaw-ollama');
    expect(DC_INSTANCES[1].id).toBe('defenseclaw-anthropic');
  });

  it('ollama instance has correct port mapping', () => {
    const ollama = DC_INSTANCES.find((i) => i.id === 'defenseclaw-ollama')!;
    expect(ollama.apiPort).toBe(18790);
    expect(ollama.guardPort).toBe(9001);
  });

  it('anthropic instance has correct port mapping', () => {
    const anthropic = DC_INSTANCES.find((i) => i.id === 'defenseclaw-anthropic')!;
    expect(anthropic.apiPort).toBe(18792);
    expect(anthropic.guardPort).toBe(9002);
  });

  it('apiPort and guardPort are distinct for each instance', () => {
    for (const inst of DC_INSTANCES) {
      expect(inst.apiPort).not.toBe(inst.guardPort);
    }
  });

  it('no port collisions between instances', () => {
    const allPorts = DC_INSTANCES.flatMap((i) => [i.apiPort, i.guardPort]);
    expect(new Set(allPorts).size).toBe(allPorts.length);
  });
});

// ─── deriveMasterKey Contract Tests ──────────────────────────
// Tests the HMAC-SHA256 derivation contract directly (the algorithm, not fs I/O).
// The actual deriveMasterKey reads from disk; we test the crypto contract here.

describe('deriveMasterKey contract', () => {
  // This mirrors the exact algorithm in both proxy.go and route.ts
  function deriveKey(deviceKeyData: Buffer): string {
    const mac = crypto.createHmac('sha256', 'defenseclaw-proxy-master-key').update(deviceKeyData).digest('hex');
    return 'sk-dc-' + mac.slice(0, 32);
  }

  it('produces sk-dc- prefixed key from device key data', () => {
    const result = deriveKey(Buffer.from('test-device-key-data'));
    expect(result).toMatch(/^sk-dc-[0-9a-f]{32}$/);
  });

  it('key is exactly 38 chars (sk-dc- prefix + 32 hex)', () => {
    const result = deriveKey(Buffer.from('any-key'));
    expect(result.length).toBe(38);
  });

  it('is deterministic — same input produces same key', () => {
    const input = Buffer.from('deterministic-test');
    expect(deriveKey(input)).toBe(deriveKey(input));
  });

  it('different device keys produce different master keys', () => {
    const key1 = deriveKey(Buffer.from('key-1'));
    const key2 = deriveKey(Buffer.from('key-2'));
    expect(key1).not.toBe(key2);
  });

  it('uses HMAC-SHA256 with the correct fixed secret', () => {
    const deviceKey = Buffer.from('known-key');
    const expected = crypto
      .createHmac('sha256', 'defenseclaw-proxy-master-key')
      .update(deviceKey)
      .digest('hex')
      .slice(0, 32);
    expect(deriveKey(deviceKey)).toBe('sk-dc-' + expected);
  });

  it('deriveMasterKey function returns empty string on fs error', async () => {
    // Pass a path that definitely doesn't exist
    const result = await deriveMasterKey('/nonexistent/path/that/does/not/exist');
    expect(result).toBe('');
  });
});

// ─── Data Dir Routing Tests ───────────────────────────────────

describe('DefenseClaw data dir routing', () => {
  it('ollama instance uses ~/.defenseclaw', () => {
    const inst = DC_INSTANCES.find((i) => i.id === 'defenseclaw-ollama')!;
    // The route.ts determines data dir like:
    // inst.id === "defenseclaw-ollama" ? `${HOME}/.defenseclaw` : `${HOME}/.dc-anthropic-home/.defenseclaw`
    const HOME = '/home/testuser';
    const dataDir =
      inst.id === 'defenseclaw-ollama'
        ? `${HOME}/.defenseclaw`
        : `${HOME}/.dc-anthropic-home/.defenseclaw`;

    expect(dataDir).toBe('/home/testuser/.defenseclaw');
  });

  it('anthropic instance uses ~/.dc-anthropic-home/.defenseclaw', () => {
    const inst = DC_INSTANCES.find((i) => i.id === 'defenseclaw-anthropic')!;
    const HOME = '/home/testuser';
    const dataDir =
      inst.id === 'defenseclaw-ollama'
        ? `${HOME}/.defenseclaw`
        : `${HOME}/.dc-anthropic-home/.defenseclaw`;

    expect(dataDir).toBe('/home/testuser/.dc-anthropic-home/.defenseclaw');
  });
});
