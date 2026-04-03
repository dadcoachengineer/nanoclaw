/**
 * Tool Inspection for NanoClaw Agent Runner
 *
 * Two-phase pre-execution hook using the Claude Agent SDK's canUseTool callback:
 *   Phase 1 (local, sync): Check isToolAllowed() from tool-registry.ts — instant, no network
 *   Phase 2 (DC inspection, ~1ms): Call DefenseClaw's /api/v1/inspect/tool to scan
 *     tool arguments for dangerous patterns (shell injection, path traversal, data exfil)
 *
 * Integrates with DefenseClaw security gateway when configured.
 *
 * Design decisions:
 * - 50ms timeout: protects against DC being unreachable (TCP connect timeout, container restart),
 *   NOT against slow inspection (it's sub-millisecond regex matching).
 * - No cache: inspection is ~100us. Caching adds complexity for zero latency benefit.
 * - No read-only exclusion by default: the excludeTools list is empty. Operators CAN exclude
 *   read-only tools (Grep, Read, Glob) to reduce audit noise, but the threat model
 *   (data exfil via Grep->Bash pipeline) means excluding reads is a conscious tradeoff.
 * - Fail-open default: the guardrail proxy already inspects all prompts/completions.
 *   Tool inspection is defense-in-depth, not the primary gate.
 */

import { isToolAllowed, ToolRegistryConfig } from './tool-registry.js';

// ─── Types ────────────────────────────────────────────────────

export interface InspectionConfig {
  enabled: boolean;
  endpoint: string; // e.g., "http://host.docker.internal:18790/api/v1/inspect/tool"
  apiKey: string; // DC master key
  failOpen: boolean; // if DC unreachable, allow tool execution (default: true)
  timeoutMs: number; // 50ms — protecting against unreachable DC, not slow inspection
  excludeTools: string[]; // tools to skip inspection for
}

export interface InspectionResult {
  allowed: boolean;
  action: 'allow' | 'alert' | 'block';
  severity: string;
  reason?: string;
  findings?: string[];
  elapsedMs: number;
}

/** The canUseTool callback signature from the Claude Agent SDK */
type CanUseToolCallback = (
  toolName: string,
  input: unknown,
) => Promise<boolean | { allowed: boolean; reason?: string }>;

// ─── Configuration ────────────────────────────────────────────

/**
 * Load inspection configuration from the NANOCLAW_TOOL_INSPECTION env var.
 *
 * Returns null if not configured (inspection disabled). The env var is
 * injected by container-runner.ts when DefenseClaw is configured on the host.
 */
export function loadInspectionConfig(): InspectionConfig | null {
  const envJson = process.env.NANOCLAW_TOOL_INSPECTION;
  if (!envJson) return null;

  try {
    const parsed = JSON.parse(envJson) as InspectionConfig;

    // Basic validation
    if (!parsed.enabled) return null;
    if (!parsed.endpoint || typeof parsed.endpoint !== 'string') {
      console.error(
        '[tool-inspection] Invalid endpoint in config, disabling inspection',
      );
      return null;
    }
    if (!parsed.apiKey || typeof parsed.apiKey !== 'string') {
      console.error(
        '[tool-inspection] Invalid apiKey in config, disabling inspection',
      );
      return null;
    }

    // Apply defaults for optional fields
    return {
      enabled: true,
      endpoint: parsed.endpoint,
      apiKey: parsed.apiKey,
      failOpen: parsed.failOpen ?? true,
      timeoutMs: parsed.timeoutMs ?? 50,
      excludeTools: Array.isArray(parsed.excludeTools)
        ? parsed.excludeTools
        : [],
    };
  } catch (err) {
    console.error(
      `[tool-inspection] Failed to parse NANOCLAW_TOOL_INSPECTION: ${err instanceof Error ? err.message : String(err)}, disabling inspection`,
    );
    return null;
  }
}

// ─── Inspection ───────────────────────────────────────────────

/**
 * Call DefenseClaw's tool inspection endpoint.
 *
 * POST /api/v1/inspect/tool with {tool, args} body.
 * On timeout (50ms) or network error: return allowed if failOpen, blocked otherwise.
 * NO CACHE — inspection is sub-millisecond, caching adds complexity for no gain.
 */
export async function inspectToolCall(
  config: InspectionConfig,
  tool: string,
  args: Record<string, unknown>,
): Promise<InspectionResult> {
  const start = performance.now();

  // Skip inspection for excluded tools
  if (config.excludeTools.includes(tool)) {
    return {
      allowed: true,
      action: 'allow',
      severity: 'none',
      reason: 'excluded from inspection',
      elapsedMs: performance.now() - start,
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DefenseClaw-Client': config.apiKey,
      },
      body: JSON.stringify({ tool, args }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const elapsed = performance.now() - start;
      console.error(
        `[tool-inspection] DC returned HTTP ${response.status} for tool=${tool}, ${config.failOpen ? 'allowing' : 'blocking'} (failOpen=${config.failOpen})`,
      );
      return {
        allowed: config.failOpen,
        action: config.failOpen ? 'allow' : 'block',
        severity: 'error',
        reason: `DefenseClaw returned HTTP ${response.status}`,
        elapsedMs: elapsed,
      };
    }

    const verdict = (await response.json()) as {
      action?: string;
      severity?: string;
      reason?: string;
      findings?: string[];
    };

    const elapsed = performance.now() - start;
    const action = (verdict.action as InspectionResult['action']) || 'allow';

    return {
      allowed: action !== 'block',
      action,
      severity: verdict.severity || 'none',
      reason: verdict.reason,
      findings: verdict.findings,
      elapsedMs: elapsed,
    };
  } catch (err) {
    const elapsed = performance.now() - start;
    const isTimeout =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError');
    const errorType = isTimeout ? 'timeout' : 'network error';

    console.error(
      `[tool-inspection] ${errorType} inspecting tool=${tool}: ${err instanceof Error ? err.message : String(err)}, ${config.failOpen ? 'allowing' : 'blocking'} (failOpen=${config.failOpen})`,
    );

    return {
      allowed: config.failOpen,
      action: config.failOpen ? 'allow' : 'block',
      severity: 'error',
      reason: `DefenseClaw ${errorType}`,
      elapsedMs: elapsed,
    };
  }
}

// ─── SDK Integration ──────────────────────────────────────────

/**
 * Create a canUseTool callback for the Claude Agent SDK.
 *
 * Two-phase inspection:
 *   Phase 1: Local registry check via isToolAllowed() (if registry provided)
 *   Phase 2: DefenseClaw network inspection via inspectToolCall() (if config provided)
 *
 * Returns undefined when neither phase is configured (SDK default behavior).
 *
 * The callback signature matches the SDK's canUseTool parameter:
 *   (toolName: string, input: unknown) => Promise<boolean | { allowed: boolean; reason?: string }>
 */
export function createCanUseTool(
  inspectionConfig: InspectionConfig | null,
  registry?: ToolRegistryConfig | null,
  isMain?: boolean,
  groupFolder?: string,
): CanUseToolCallback | undefined {
  // No inspection configured — return undefined so SDK uses default behavior
  if (!inspectionConfig) return undefined;

  return async (
    toolName: string,
    input: unknown,
  ): Promise<{ allowed: boolean; reason?: string }> => {
    // Phase 1: Local registry check (instant, no network)
    if (registry && isMain !== undefined && groupFolder !== undefined) {
      if (!isToolAllowed(registry, toolName, isMain, groupFolder)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not in the allowed tool registry`,
        };
      }
    }

    // Phase 2: DefenseClaw inspection (~1ms, network call)
    const args =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)
        : {};

    const result = await inspectToolCall(inspectionConfig, toolName, args);

    if (!result.allowed) {
      const reason =
        result.reason ||
        `DefenseClaw blocked tool "${toolName}": ${result.action} (severity: ${result.severity})`;
      console.error(
        `[tool-inspection] BLOCKED: tool=${toolName} action=${result.action} severity=${result.severity} reason=${reason} elapsed=${result.elapsedMs.toFixed(1)}ms`,
      );
      return { allowed: false, reason };
    }

    // Log alerts (allowed but suspicious) for observability
    if (result.action === 'alert') {
      console.error(
        `[tool-inspection] ALERT: tool=${toolName} severity=${result.severity} reason=${result.reason || 'n/a'} elapsed=${result.elapsedMs.toFixed(1)}ms`,
      );
    }

    return { allowed: true };
  };
}
