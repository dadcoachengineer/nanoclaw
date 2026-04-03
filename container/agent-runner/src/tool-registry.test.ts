/**
 * Tool Registry tests
 *
 * Verifies:
 * - loadRegistry returns defaults when no env var is set
 * - loadRegistry parses NANOCLAW_TOOL_REGISTRY env var correctly
 * - computeAllowedTools returns exact current defaults with no config
 * - computeAllowedTools filters by mainOnly
 * - computeAllowedTools filters by groups array
 * - computeAllowedTools respects enabled: false
 * - isToolAllowed returns correct results
 * - Extra tools from config are added to defaults
 * - MCP server prefixes are included
 * - Invalid/malformed env var falls back to defaults
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadRegistry,
  computeAllowedTools,
  isToolAllowed,
  type ToolRegistryConfig,
} from './tool-registry.js';

/**
 * The exact allowedTools array from the original hardcoded index.ts.
 * loadRegistry() with no config must produce this exact list.
 */
const ORIGINAL_ALLOWED_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];

describe('loadRegistry', () => {
  afterEach(() => {
    delete process.env.NANOCLAW_TOOL_REGISTRY;
  });

  it('returns defaults when no env var is set', () => {
    delete process.env.NANOCLAW_TOOL_REGISTRY;
    const registry = loadRegistry(false, 'test-group');

    expect(registry.version).toBe(1);
    expect(registry.defaults.builtins).toEqual([
      'Bash',
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill',
      'NotebookEdit',
    ]);
    expect(registry.defaults.mcpServers).toEqual([
      'mcp__nanoclaw__*',
    ]);
    expect(registry.tools).toEqual([]);
  });

  it('parses env var JSON correctly', () => {
    const config: ToolRegistryConfig = {
      version: 1,
      defaults: {
        builtins: ['Bash', 'Read'],
        mcpServers: ['mcp__nanoclaw__*'],
      },
      tools: [
        { type: 'builtin', name: 'Write', enabled: true },
        { type: 'mcp', name: 'mcp__custom__*', enabled: true, mainOnly: true },
      ],
    };
    process.env.NANOCLAW_TOOL_REGISTRY = JSON.stringify(config);

    const registry = loadRegistry(false, 'test-group');

    expect(registry.version).toBe(1);
    expect(registry.defaults.builtins).toEqual(['Bash', 'Read']);
    expect(registry.defaults.mcpServers).toEqual(['mcp__nanoclaw__*']);
    expect(registry.tools).toHaveLength(2);
    expect(registry.tools[0].name).toBe('Write');
    expect(registry.tools[1].mainOnly).toBe(true);
  });

  it('falls back to defaults on invalid JSON', () => {
    process.env.NANOCLAW_TOOL_REGISTRY = '{not valid json';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const registry = loadRegistry(false, 'test-group');

    expect(registry.version).toBe(1);
    expect(registry.defaults.builtins).toContain('Bash');
    expect(registry.tools).toEqual([]);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('falls back to defaults on unsupported version', () => {
    const config = {
      version: 99,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [],
    };
    process.env.NANOCLAW_TOOL_REGISTRY = JSON.stringify(config);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const registry = loadRegistry(false, 'test-group');

    expect(registry.version).toBe(1);
    expect(registry.defaults.builtins).toContain('Bash');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('falls back to defaults when defaults structure is invalid', () => {
    const config = {
      version: 1,
      defaults: { builtins: 'not-an-array', mcpServers: [] },
      tools: [],
    };
    process.env.NANOCLAW_TOOL_REGISTRY = JSON.stringify(config);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const registry = loadRegistry(false, 'test-group');

    expect(registry.defaults.builtins).toContain('Bash');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('falls back to defaults when tools is not an array', () => {
    const config = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: 'not-an-array',
    };
    process.env.NANOCLAW_TOOL_REGISTRY = JSON.stringify(config);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const registry = loadRegistry(false, 'test-group');

    expect(registry.defaults.builtins).toContain('Bash');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns fresh copies on each call (no shared mutation)', () => {
    delete process.env.NANOCLAW_TOOL_REGISTRY;

    const a = loadRegistry(false, 'group-a');
    const b = loadRegistry(false, 'group-b');

    a.defaults.builtins.push('ExtraTool');
    expect(b.defaults.builtins).not.toContain('ExtraTool');
  });
});

describe('computeAllowedTools', () => {
  it('returns exact current defaults with no config (backwards compatibility)', () => {
    delete process.env.NANOCLAW_TOOL_REGISTRY;
    const registry = loadRegistry(false, 'test-group');
    const tools = computeAllowedTools(registry, false, 'test-group');

    expect(tools.sort()).toEqual([...ORIGINAL_ALLOWED_TOOLS].sort());
  });

  it('includes MCP server prefixes in output', () => {
    const registry = loadRegistry(false, 'test-group');
    const tools = computeAllowedTools(registry, false, 'test-group');

    expect(tools).toContain('mcp__nanoclaw__*');
  });

  it('adds extra enabled tools to defaults', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: {
        builtins: ['Bash', 'Read'],
        mcpServers: ['mcp__nanoclaw__*'],
      },
      tools: [
        { type: 'custom', name: 'MyCustomTool', enabled: true },
        { type: 'mcp', name: 'mcp__extra__*', enabled: true },
      ],
    };

    const tools = computeAllowedTools(registry, false, 'test-group');

    expect(tools).toContain('Bash');
    expect(tools).toContain('Read');
    expect(tools).toContain('mcp__nanoclaw__*');
    expect(tools).toContain('MyCustomTool');
    expect(tools).toContain('mcp__extra__*');
  });

  it('does not add disabled tools', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: {
        builtins: ['Bash'],
        mcpServers: [],
      },
      tools: [
        { type: 'builtin', name: 'Write', enabled: false },
        { type: 'custom', name: 'Allowed', enabled: true },
      ],
    };

    const tools = computeAllowedTools(registry, false, 'test-group');

    expect(tools).toContain('Bash');
    expect(tools).toContain('Allowed');
    expect(tools).not.toContain('Write');
  });

  it('filters by mainOnly: main=true gets the tool', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [
        { type: 'builtin', name: 'MainOnlyTool', enabled: true, mainOnly: true },
      ],
    };

    const tools = computeAllowedTools(registry, true, 'main');

    expect(tools).toContain('MainOnlyTool');
  });

  it('filters by mainOnly: main=false does NOT get the tool', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [
        { type: 'builtin', name: 'MainOnlyTool', enabled: true, mainOnly: true },
      ],
    };

    const tools = computeAllowedTools(registry, false, 'other-group');

    expect(tools).not.toContain('MainOnlyTool');
  });

  it('filters by groups array: included group gets the tool', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [
        { type: 'skill', name: 'GroupSpecificTool', enabled: true, groups: ['alpha', 'beta'] },
      ],
    };

    const toolsAlpha = computeAllowedTools(registry, false, 'alpha');
    const toolsBeta = computeAllowedTools(registry, false, 'beta');

    expect(toolsAlpha).toContain('GroupSpecificTool');
    expect(toolsBeta).toContain('GroupSpecificTool');
  });

  it('filters by groups array: excluded group does NOT get the tool', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [
        { type: 'skill', name: 'GroupSpecificTool', enabled: true, groups: ['alpha', 'beta'] },
      ],
    };

    const tools = computeAllowedTools(registry, false, 'gamma');

    expect(tools).not.toContain('GroupSpecificTool');
  });

  it('null/empty groups array means all groups get the tool', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [
        { type: 'custom', name: 'EveryoneTool', enabled: true, groups: [] },
        { type: 'custom', name: 'NoGroupsField', enabled: true },
      ],
    };

    const tools = computeAllowedTools(registry, false, 'any-group');

    expect(tools).toContain('EveryoneTool');
    expect(tools).toContain('NoGroupsField');
  });

  it('mainOnly + groups: both filters must pass', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [
        { type: 'custom', name: 'RestrictedTool', enabled: true, mainOnly: true, groups: ['main'] },
      ],
    };

    // isMain=true AND groupFolder='main' -> passes
    expect(computeAllowedTools(registry, true, 'main')).toContain('RestrictedTool');

    // isMain=true BUT groupFolder='other' -> fails groups check
    expect(computeAllowedTools(registry, true, 'other')).not.toContain('RestrictedTool');

    // isMain=false AND groupFolder='main' -> fails mainOnly check
    expect(computeAllowedTools(registry, false, 'main')).not.toContain('RestrictedTool');
  });

  it('deduplicates tools that appear in both defaults and tools array', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash', 'Read'], mcpServers: ['mcp__nanoclaw__*'] },
      tools: [
        { type: 'builtin', name: 'Bash', enabled: true },
        { type: 'mcp', name: 'mcp__nanoclaw__*', enabled: true },
      ],
    };

    const tools = computeAllowedTools(registry, false, 'test-group');
    const bashCount = tools.filter(t => t === 'Bash').length;
    const mcpCount = tools.filter(t => t === 'mcp__nanoclaw__*').length;

    expect(bashCount).toBe(1);
    expect(mcpCount).toBe(1);
  });
});

describe('isToolAllowed', () => {
  it('returns true for tools in the computed allowed list', () => {
    const registry = loadRegistry(false, 'test-group');

    expect(isToolAllowed(registry, 'Bash', false, 'test-group')).toBe(true);
    expect(isToolAllowed(registry, 'Read', false, 'test-group')).toBe(true);
    expect(isToolAllowed(registry, 'mcp__nanoclaw__*', false, 'test-group')).toBe(true);
  });

  it('returns false for tools NOT in the computed allowed list', () => {
    const registry = loadRegistry(false, 'test-group');

    expect(isToolAllowed(registry, 'NonExistentTool', false, 'test-group')).toBe(false);
    expect(isToolAllowed(registry, 'mcp__unknown__*', false, 'test-group')).toBe(false);
  });

  it('respects mainOnly filtering', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [
        { type: 'builtin', name: 'AdminTool', enabled: true, mainOnly: true },
      ],
    };

    expect(isToolAllowed(registry, 'AdminTool', true, 'main')).toBe(true);
    expect(isToolAllowed(registry, 'AdminTool', false, 'other')).toBe(false);
  });

  it('respects groups filtering', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [
        { type: 'skill', name: 'SpecialTool', enabled: true, groups: ['group-a'] },
      ],
    };

    expect(isToolAllowed(registry, 'SpecialTool', false, 'group-a')).toBe(true);
    expect(isToolAllowed(registry, 'SpecialTool', false, 'group-b')).toBe(false);
  });

  it('respects enabled: false', () => {
    const registry: ToolRegistryConfig = {
      version: 1,
      defaults: { builtins: ['Bash'], mcpServers: [] },
      tools: [
        { type: 'builtin', name: 'DisabledTool', enabled: false },
      ],
    };

    expect(isToolAllowed(registry, 'DisabledTool', false, 'test-group')).toBe(false);
  });
});
