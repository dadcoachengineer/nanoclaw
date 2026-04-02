/**
 * DefenseClaw integration tests for container-runner.ts
 *
 * Tests the Phase 3 changes:
 * - DEFENSECLAW_ANTHROPIC_URL env injection into spawned containers
 * - ANTHROPIC_BASE_URL propagation chain (host env → container -e flag)
 * - modelOverride → CLAUDE_MODEL env injection
 * - Interaction between DefenseClaw injection and OneCLI gateway
 *
 * These are unit tests with mocked child_process, fs, and OneCLI SDK.
 * They verify the buildContainerArgs() output without spawning real containers.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Track OneCLI applyContainerConfig calls to inspect args mutation
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = onecliApplyMock;
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => ['--add-host', 'host.docker.internal:host-gateway'],
  readonlyMountArgs: (src: string, dst: string) => [
    '-v',
    `${src}:${dst}:ro`,
  ],
  stopContainer: (name: string) => `docker stop ${name}`,
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/nanoclaw-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

const { spawnMock, onecliApplyMock } = vi.hoisted(() => {
  const spawnMock = vi.fn();
  const onecliApplyMock = vi.fn().mockResolvedValue(true);
  return { spawnMock, onecliApplyMock };
});

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process — capture spawn args
vi.mock('child_process', () => ({
  spawn: spawnMock,
  exec: vi.fn(
    (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    },
  ),
}));

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

// ─── Helper: extract -e flags from container args ─────────────
function extractEnvFlags(containerArgs: string[]): Record<string, string> {
  const envs: Record<string, string> = {};
  for (let i = 0; i < containerArgs.length; i++) {
    if (containerArgs[i] === '-e' && i + 1 < containerArgs.length) {
      const [key, ...rest] = containerArgs[i + 1].split('=');
      envs[key] = rest.join('=');
    }
  }
  return envs;
}

// ─── DefenseClaw Env Injection Tests ──────────────────────────

describe('container-runner DefenseClaw env injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockReturnValue(fakeProc);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    spawnMock.mockReset();
  });

  it('injects ANTHROPIC_BASE_URL when DEFENSECLAW_ANTHROPIC_URL is set', async () => {
    vi.stubEnv('DEFENSECLAW_ANTHROPIC_URL', 'http://127.0.0.1:9002/v1/messages');

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
      onOutput,
    );

    // Emit output and close
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // Verify spawn was called and extract env flags
    expect(spawnMock).toHaveBeenCalled();
    const containerArgs: string[] = spawnMock.mock.calls[0][1];
    const envs = extractEnvFlags(containerArgs);

    expect(envs['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:9002/v1/messages');
  });

  it('does NOT inject ANTHROPIC_BASE_URL when DEFENSECLAW_ANTHROPIC_URL is unset', async () => {
    // Ensure env var is not set
    delete process.env.DEFENSECLAW_ANTHROPIC_URL;

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const containerArgs: string[] = spawnMock.mock.calls[0][1];
    const envs = extractEnvFlags(containerArgs);

    expect(envs['ANTHROPIC_BASE_URL']).toBeUndefined();
  });

  it('DefenseClaw injection is ordered before OneCLI gateway config', async () => {
    vi.stubEnv('DEFENSECLAW_ANTHROPIC_URL', 'http://127.0.0.1:9002/v1/messages');

    // Track the args array state when OneCLI.applyContainerConfig is called
    let argsAtOnecliCall: string[] = [];
    onecliApplyMock.mockImplementation(async (args: string[]) => {
      argsAtOnecliCall = [...args]; // snapshot
      return true;
    });

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // At the time OneCLI was called, ANTHROPIC_BASE_URL should already be in args
    const hasBaseUrl = argsAtOnecliCall.some(
      (a) => typeof a === 'string' && a.startsWith('ANTHROPIC_BASE_URL='),
    );
    expect(hasBaseUrl).toBe(true);
  });
});

// ─── modelOverride Tests ──────────────────────────────────────

describe('container-runner modelOverride', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockReturnValue(fakeProc);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    spawnMock.mockReset();
  });

  it('injects CLAUDE_MODEL when modelOverride is provided', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        modelOverride: 'claude-haiku-4-5-20251001',
      },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const containerArgs: string[] = spawnMock.mock.calls[0][1];
    const envs = extractEnvFlags(containerArgs);

    expect(envs['CLAUDE_MODEL']).toBe('claude-haiku-4-5-20251001');
  });

  it('does NOT inject CLAUDE_MODEL when modelOverride is absent', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        // no modelOverride
      },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const containerArgs: string[] = spawnMock.mock.calls[0][1];
    const envs = extractEnvFlags(containerArgs);

    expect(envs['CLAUDE_MODEL']).toBeUndefined();
  });

  it('both DefenseClaw and modelOverride can be set simultaneously', async () => {
    vi.stubEnv('DEFENSECLAW_ANTHROPIC_URL', 'http://127.0.0.1:9002/v1/messages');

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        modelOverride: 'claude-sonnet-4-20250514',
      },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const containerArgs: string[] = spawnMock.mock.calls[0][1];
    const envs = extractEnvFlags(containerArgs);

    expect(envs['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:9002/v1/messages');
    expect(envs['CLAUDE_MODEL']).toBe('claude-sonnet-4-20250514');
  });
});

// ─── TZ injection (baseline sanity) ──────────────────────────

describe('container-runner TZ injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockReturnValue(fakeProc);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    spawnMock.mockReset();
  });

  it('always injects TZ env var from config', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const containerArgs: string[] = spawnMock.mock.calls[0][1];
    const envs = extractEnvFlags(containerArgs);

    expect(envs['TZ']).toBe('America/Los_Angeles');
  });
});
