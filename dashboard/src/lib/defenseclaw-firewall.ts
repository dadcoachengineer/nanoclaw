/**
 * DefenseClaw egress firewall — config parsing and status.
 *
 * Reads ~/.defenseclaw/firewall.yaml to report the INTENDED firewall policy.
 * Does NOT enforce rules — enforcement is a manual `sudo pfctl` step.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { parse, stringify } from "yaml";

const FIREWALL_CONFIG_PATH = `${process.env.HOME}/.defenseclaw/firewall.yaml`;

// ── Types ──────────────────────

export interface FirewallRule {
  name: string;
  direction?: string;
  protocol?: string;
  destination?: string;
  port?: number;
  action: string;
}

export interface FirewallAllowlist {
  domains: string[];
  ips: string[];
  ports: number[];
}

export interface FirewallLogging {
  enabled: boolean;
  rate_limit: string;
  prefix: string;
}

export interface FirewallConfig {
  version: string;
  default_action: string;
  rules: FirewallRule[];
  allowlist: FirewallAllowlist;
  logging: FirewallLogging;
}

export interface FirewallStatus {
  configured: boolean;
  enforced: boolean;
  configPath: string;
  defaultAction: string;
  ruleCount: number;
  allowedDomains: string[];
  allowedIPs: string[];
  allowedPorts: number[];
  denyRules: FirewallRule[];
  loggingEnabled: boolean;
  error?: string;
}

// ── Config loading ──────────────────────

export function loadFirewallConfig(path?: string): FirewallConfig | null {
  const configPath = path || FIREWALL_CONFIG_PATH;
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    return {
      version: String(parsed.version || "1.0"),
      default_action: String(parsed.default_action || "deny"),
      rules: normalizeRules(parsed.rules),
      allowlist: normalizeAllowlist(parsed.allowlist),
      logging: normalizeLogging(parsed.logging),
    };
  } catch {
    return null;
  }
}

function normalizeRules(raw: unknown): FirewallRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => r != null && typeof r === "object")
    .map((r) => ({
      name: String(r.name || ""),
      direction: r.direction ? String(r.direction) : undefined,
      protocol: r.protocol ? String(r.protocol) : undefined,
      destination: r.destination ? String(r.destination) : undefined,
      port: typeof r.port === "number" ? r.port : undefined,
      action: String(r.action || "deny"),
    }));
}

function normalizeAllowlist(raw: unknown): FirewallAllowlist {
  const defaults: FirewallAllowlist = { domains: [], ips: [], ports: [] };
  if (raw == null || typeof raw !== "object") return defaults;
  const a = raw as Record<string, unknown>;
  return {
    domains: Array.isArray(a.domains) ? a.domains.map(String) : [],
    ips: Array.isArray(a.ips) ? a.ips.map(String) : [],
    ports: Array.isArray(a.ports) ? a.ports.filter((p): p is number => typeof p === "number") : [],
  };
}

function normalizeLogging(raw: unknown): FirewallLogging {
  const defaults: FirewallLogging = { enabled: true, rate_limit: "5/min", prefix: "[DEFENSECLAW-BLOCKED]" };
  if (raw == null || typeof raw !== "object") return defaults;
  const l = raw as Record<string, unknown>;
  return {
    enabled: l.enabled !== false,
    rate_limit: String(l.rate_limit || defaults.rate_limit),
    prefix: String(l.prefix || defaults.prefix),
  };
}

// ── Status ──────────────────────

/**
 * Build a complete firewall status object from config + pfctl probe.
 * The pfctl probe is read-only and degrades gracefully (no sudo required).
 */
export async function getFirewallStatus(configPath?: string): Promise<FirewallStatus> {
  const cfg = loadFirewallConfig(configPath);

  if (!cfg) {
    return {
      configured: false,
      enforced: false,
      configPath: configPath || FIREWALL_CONFIG_PATH,
      defaultAction: "deny",
      ruleCount: 0,
      allowedDomains: [],
      allowedIPs: [],
      allowedPorts: [],
      denyRules: [],
      loggingEnabled: false,
      error: "Firewall config not found",
    };
  }

  const enforced = await checkPfctlActive();

  return {
    configured: true,
    enforced,
    configPath: configPath || FIREWALL_CONFIG_PATH,
    defaultAction: cfg.default_action,
    ruleCount: cfg.rules.length + cfg.allowlist.domains.length + cfg.allowlist.ips.length,
    allowedDomains: cfg.allowlist.domains,
    allowedIPs: cfg.allowlist.ips,
    allowedPorts: cfg.allowlist.ports,
    denyRules: cfg.rules.filter((r) => r.action === "deny"),
    loggingEnabled: cfg.logging.enabled,
  };
}

/**
 * Check if the DefenseClaw pfctl anchor has active rules.
 * Read-only: runs `pfctl -a com.defenseclaw -sr`.
 * Returns false on any error (no sudo, pfctl not found, empty anchor).
 */
async function checkPfctlActive(): Promise<boolean> {
  try {
    const { execSync } = await import("child_process");
    const out = execSync("pfctl -a com.defenseclaw -sr 2>/dev/null", {
      timeout: 3000,
      encoding: "utf-8",
    });
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    return lines.length > 0;
  } catch {
    return false;
  }
}

/**
 * Update the enabled/disabled state in the firewall config.
 * This toggles the default_action between "deny" (enabled) and "allow" (disabled).
 * Does NOT activate pfctl — that is a manual admin step.
 */
export function updateFirewallEnabled(enabled: boolean, configPath?: string): FirewallConfig | null {
  const cfg = loadFirewallConfig(configPath);
  if (!cfg) return null;

  cfg.default_action = enabled ? "deny" : "allow";

  // Write back
  try {
    const out = stringify(cfg, { lineWidth: 120 });
    writeFileSync(configPath || FIREWALL_CONFIG_PATH, out, { mode: 0o600 });
    return cfg;
  } catch {
    return null;
  }
}
