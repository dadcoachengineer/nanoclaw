/**
 * Tool Registry for NanoClaw Agent Runner
 *
 * Config-driven tool allowlist that replaces the hardcoded allowedTools array.
 * Reads configuration from NANOCLAW_TOOL_REGISTRY env var (JSON string injected
 * by container-runner). Falls back to hardcoded defaults when no config is present,
 * preserving exact backwards compatibility.
 *
 * Part A: Local-only registry. No network calls, no DefenseClaw integration.
 */

export interface ToolRegistryConfig {
  version: 1;
  defaults: {
    builtins: string[];      // default built-in tools for all groups
    mcpServers: string[];    // MCP tool prefixes (e.g., "mcp__nanoclaw__*")
  };
  tools: Array<{
    type: 'builtin' | 'mcp' | 'skill' | 'custom';
    name: string;
    enabled: boolean;
    mainOnly?: boolean;      // only available to main group
    groups?: string[];       // restrict to specific group folders (null = all)
  }>;
}

/**
 * Hardcoded defaults that exactly match the current allowedTools array
 * in container/agent-runner/src/index.ts (lines 409-418).
 *
 * When no config file exists and no env var is set, loadRegistry() returns
 * these defaults so behavior is identical to the pre-registry codebase.
 */
const DEFAULT_BUILTINS: string[] = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
];

const DEFAULT_MCP_SERVERS: string[] = [
  'mcp__nanoclaw__*',
  'mcp__ollama__*',
];

function getDefaultConfig(): ToolRegistryConfig {
  return {
    version: 1,
    defaults: {
      builtins: [...DEFAULT_BUILTINS],
      mcpServers: [...DEFAULT_MCP_SERVERS],
    },
    tools: [],
  };
}

/**
 * Load the tool registry configuration.
 *
 * Resolution order:
 * 1. NANOCLAW_TOOL_REGISTRY env var (JSON string, injected by container-runner)
 * 2. Hardcoded defaults (backwards compatible — exact same allowedTools as before)
 *
 * @param _isMain - whether this is the main group (unused in loading, used in compute)
 * @param _groupFolder - the group folder name (unused in loading, used in compute)
 */
export function loadRegistry(_isMain: boolean, _groupFolder: string): ToolRegistryConfig {
  const envJson = process.env.NANOCLAW_TOOL_REGISTRY;

  if (envJson) {
    try {
      const parsed = JSON.parse(envJson) as ToolRegistryConfig;

      // Basic validation
      if (parsed.version !== 1) {
        console.error(`[tool-registry] Unsupported config version: ${parsed.version}, using defaults`);
        return getDefaultConfig();
      }
      if (!parsed.defaults || !Array.isArray(parsed.defaults.builtins) || !Array.isArray(parsed.defaults.mcpServers)) {
        console.error('[tool-registry] Invalid config structure, using defaults');
        return getDefaultConfig();
      }
      if (!Array.isArray(parsed.tools)) {
        console.error('[tool-registry] Invalid tools array, using defaults');
        return getDefaultConfig();
      }

      return parsed;
    } catch (err) {
      console.error(`[tool-registry] Failed to parse NANOCLAW_TOOL_REGISTRY: ${err instanceof Error ? err.message : String(err)}, using defaults`);
      return getDefaultConfig();
    }
  }

  return getDefaultConfig();
}

/**
 * Compute the final allowedTools array from a registry configuration.
 *
 * Algorithm:
 * 1. Start with defaults.builtins + defaults.mcpServers
 * 2. For each tool in tools[], if enabled AND group eligibility passes, add it
 * 3. Return the final deduplicated array
 *
 * Group eligibility:
 * - mainOnly=true: only included when isMain=true
 * - groups=[...]: only included when groupFolder is in the array
 * - Neither set: included for all groups
 */
export function computeAllowedTools(
  registry: ToolRegistryConfig,
  isMain: boolean,
  groupFolder: string,
): string[] {
  // Start with defaults
  const tools = new Set<string>([
    ...registry.defaults.builtins,
    ...registry.defaults.mcpServers,
  ]);

  // Add eligible tools from the tools array
  for (const tool of registry.tools) {
    if (!tool.enabled) continue;

    // Check mainOnly filter
    if (tool.mainOnly && !isMain) continue;

    // Check groups filter (null/undefined/empty = all groups)
    if (tool.groups && tool.groups.length > 0 && !tool.groups.includes(groupFolder)) continue;

    tools.add(tool.name);
  }

  return [...tools];
}

/**
 * Quick check if a specific tool is allowed for the given context.
 *
 * @param registry - the loaded registry config
 * @param toolName - the tool name to check
 * @param isMain - whether this is the main group
 * @param groupFolder - the group folder name
 * @returns true if the tool is in the computed allowed list
 */
export function isToolAllowed(
  registry: ToolRegistryConfig,
  toolName: string,
  isMain: boolean,
  groupFolder: string,
): boolean {
  const allowed = computeAllowedTools(registry, isMain, groupFolder);
  return allowed.includes(toolName);
}
