/**
 * Tool Registry injection tests for container-runner.ts
 *
 * Verifies that NANOCLAW_TOOL_REGISTRY env var is injected into container
 * args when the config file exists on the host, and skipped when it doesn't.
 *
 * These are unit tests with mocked child_process, fs, and OneCLI SDK.
 * They verify buildContainerArgs() output without spawning real containers.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Hoisted mocks — must be declared with vi.hoisted() so they're available
// inside vi.mock() factories (which are hoisted to the top of the file)
const { spawnMock, existsSyncMock, readFileSyncMock, TOOL_REGISTRY_PATH } = vi.hoisted(() => {
  const spawnMock = vi.fn();
  const existsSyncMock = vi.fn((): boolean => false);
  const readFileSyncMock = vi.fn((): string => '');
  const TOOL_REGISTRY_PATH = '/mock-home/.config/nanoclaw/tool-registry.json';
  return { spawnMock, existsSyncMock, readFileSyncMock, TOOL_REGISTRY_PATH };
});

// Mock config — include TOOL_REGISTRY_PATH
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
  TOOL_REGISTRY_PATH,
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
      existsSync: existsSyncMock,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: readFileSyncMock,
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

// Track OneCLI applyContainerConfig calls
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
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
  readonlyMountArgs: (src: string, dst: string) => ['-v', `${src}:${dst}:ro`],
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

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process
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

// Helper: extract -e flags from container args
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

describe('container-runner tool registry injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockReturnValue(fakeProc);
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue('');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
  });

  it('injects NANOCLAW_TOOL_REGISTRY when config file exists', async () => {
    const registryConfig = {
      version: 1,
      defaults: { builtins: ['Bash', 'Read'], mcpServers: ['mcp__nanoclaw__*'] },
      tools: [{ type: 'custom', name: 'MyTool', enabled: true }],
    };
    const registryJson = JSON.stringify(registryConfig);

    existsSyncMock.mockImplementation((p: string) => {
      if (p === TOOL_REGISTRY_PATH) return true;
      return false;
    });
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === TOOL_REGISTRY_PATH) return registryJson;
      return '';
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

    expect(spawnMock).toHaveBeenCalled();
    const containerArgs: string[] = spawnMock.mock.calls[0][1];
    const envs = extractEnvFlags(containerArgs);

    expect(envs['NANOCLAW_TOOL_REGISTRY']).toBeDefined();
    const parsed = JSON.parse(envs['NANOCLAW_TOOL_REGISTRY']);
    expect(parsed.version).toBe(1);
    expect(parsed.tools[0].name).toBe('MyTool');
  });

  it('does NOT inject NANOCLAW_TOOL_REGISTRY when config file does not exist', async () => {
    existsSyncMock.mockReturnValue(false);

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

    expect(envs['NANOCLAW_TOOL_REGISTRY']).toBeUndefined();
  });

  it('skips injection when config file contains invalid JSON', async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (p === TOOL_REGISTRY_PATH) return true;
      return false;
    });
    readFileSyncMock.mockImplementation(((p: string) => {
      if (p === TOOL_REGISTRY_PATH) return '{invalid json!!!';
      return '';
    }) as any);

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

    // Invalid JSON should not be injected
    expect(envs['NANOCLAW_TOOL_REGISTRY']).toBeUndefined();
  });
});
