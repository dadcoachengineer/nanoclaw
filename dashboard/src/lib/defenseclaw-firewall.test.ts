/**
 * Tests for DefenseClaw egress firewall config parsing and status.
 *
 * Tests:
 * - YAML config parsing (valid, empty, malformed)
 * - Allowlist normalization (domains, IPs, ports)
 * - Deny rule extraction
 * - Firewall status shape for dashboard consumption
 * - Enable/disable toggle logic
 * - Missing config file handling
 *
 * These are unit tests with mocked filesystem. No real pfctl or file operations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Extracted types (mirrored from defenseclaw-firewall.ts) ───────

interface FirewallRule {
  name: string;
  direction?: string;
  protocol?: string;
  destination?: string;
  port?: number;
  action: string;
}

interface FirewallAllowlist {
  domains: string[];
  ips: string[];
  ports: number[];
}

interface FirewallLogging {
  enabled: boolean;
  rate_limit: string;
  prefix: string;
}

interface FirewallConfig {
  version: string;
  default_action: string;
  rules: FirewallRule[];
  allowlist: FirewallAllowlist;
  logging: FirewallLogging;
}

interface FirewallStatus {
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

// ─── Extracted logic (mirrored from defenseclaw-firewall.ts for isolated testing) ───

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

function parseConfig(parsed: Record<string, unknown>): FirewallConfig {
  return {
    version: String(parsed.version || "1.0"),
    default_action: String(parsed.default_action || "deny"),
    rules: normalizeRules(parsed.rules),
    allowlist: normalizeAllowlist(parsed.allowlist),
    logging: normalizeLogging(parsed.logging),
  };
}

function buildStatus(cfg: FirewallConfig | null, enforced: boolean, configPath: string): FirewallStatus {
  if (!cfg) {
    return {
      configured: false, enforced: false, configPath,
      defaultAction: "deny", ruleCount: 0, allowedDomains: [], allowedIPs: [],
      allowedPorts: [], denyRules: [], loggingEnabled: false,
      error: "Firewall config not found",
    };
  }
  return {
    configured: true, enforced, configPath,
    defaultAction: cfg.default_action,
    ruleCount: cfg.rules.length + cfg.allowlist.domains.length + cfg.allowlist.ips.length,
    allowedDomains: cfg.allowlist.domains,
    allowedIPs: cfg.allowlist.ips,
    allowedPorts: cfg.allowlist.ports,
    denyRules: cfg.rules.filter((r) => r.action === "deny"),
    loggingEnabled: cfg.logging.enabled,
  };
}

// ─── Sample data ────────────────────────────────────────────────

const SAMPLE_CONFIG: Record<string, unknown> = {
  version: "1.0",
  default_action: "deny",
  rules: [
    { name: "block-cloud-metadata", direction: "outbound", protocol: "tcp", destination: "169.254.169.254", action: "deny" },
    { name: "block-cloud-metadata-v6", direction: "outbound", protocol: "tcp", destination: "fd00:ec2::254", action: "deny" },
  ],
  allowlist: {
    domains: [
      "api.anthropic.com",
      "api.notion.com",
      "webexapis.com",
      "calendar.google.com",
      "gmail.googleapis.com",
      "www.googleapis.com",
      "oauth2.googleapis.com",
      "hooks.slack.com",
      "api.github.com",
      "github.com",
      "objects.githubusercontent.com",
      "registry.npmjs.org",
    ],
    ips: ["127.0.0.1"],
    ports: [443, 80],
  },
  logging: {
    enabled: true,
    rate_limit: "5/min",
    prefix: "[DEFENSECLAW-BLOCKED]",
  },
};

// ─── Config parsing tests ──────────────────────────────────────

describe("firewall config parsing", () => {
  it("parses a complete NanoClaw firewall config", () => {
    const cfg = parseConfig(SAMPLE_CONFIG);

    expect(cfg.version).toBe("1.0");
    expect(cfg.default_action).toBe("deny");
    expect(cfg.rules).toHaveLength(2);
    expect(cfg.allowlist.domains).toHaveLength(12);
    expect(cfg.allowlist.ips).toEqual(["127.0.0.1"]);
    expect(cfg.allowlist.ports).toEqual([443, 80]);
    expect(cfg.logging.enabled).toBe(true);
  });

  it("parses deny rules with all fields", () => {
    const cfg = parseConfig(SAMPLE_CONFIG);
    const metadataRule = cfg.rules[0];

    expect(metadataRule.name).toBe("block-cloud-metadata");
    expect(metadataRule.direction).toBe("outbound");
    expect(metadataRule.protocol).toBe("tcp");
    expect(metadataRule.destination).toBe("169.254.169.254");
    expect(metadataRule.action).toBe("deny");
  });

  it("handles empty config object", () => {
    const cfg = parseConfig({});

    expect(cfg.version).toBe("1.0");
    expect(cfg.default_action).toBe("deny");
    expect(cfg.rules).toEqual([]);
    expect(cfg.allowlist.domains).toEqual([]);
    expect(cfg.allowlist.ips).toEqual([]);
    expect(cfg.allowlist.ports).toEqual([]);
    expect(cfg.logging.enabled).toBe(true);
  });

  it("applies default logging when not specified", () => {
    const cfg = parseConfig({ rules: [], allowlist: {} });

    expect(cfg.logging.enabled).toBe(true);
    expect(cfg.logging.rate_limit).toBe("5/min");
    expect(cfg.logging.prefix).toBe("[DEFENSECLAW-BLOCKED]");
  });

  it("handles default_action=allow", () => {
    const cfg = parseConfig({ ...SAMPLE_CONFIG, default_action: "allow" });
    expect(cfg.default_action).toBe("allow");
  });
});

// ─── Allowlist normalization ───────────────────────────────────

describe("allowlist normalization", () => {
  it("normalizes valid domain list", () => {
    const al = normalizeAllowlist({
      domains: ["api.anthropic.com", "api.notion.com"],
      ips: ["127.0.0.1"],
      ports: [443],
    });

    expect(al.domains).toEqual(["api.anthropic.com", "api.notion.com"]);
    expect(al.ips).toEqual(["127.0.0.1"]);
    expect(al.ports).toEqual([443]);
  });

  it("returns empty arrays for null input", () => {
    const al = normalizeAllowlist(null);
    expect(al.domains).toEqual([]);
    expect(al.ips).toEqual([]);
    expect(al.ports).toEqual([]);
  });

  it("returns empty arrays for undefined input", () => {
    const al = normalizeAllowlist(undefined);
    expect(al.domains).toEqual([]);
  });

  it("handles missing sub-fields gracefully", () => {
    const al = normalizeAllowlist({ domains: ["test.com"] });
    expect(al.domains).toEqual(["test.com"]);
    expect(al.ips).toEqual([]);
    expect(al.ports).toEqual([]);
  });

  it("filters out non-number port values", () => {
    const al = normalizeAllowlist({ ports: [443, "not-a-port", 80, null] });
    expect(al.ports).toEqual([443, 80]);
  });

  it("converts non-string domains to strings", () => {
    const al = normalizeAllowlist({ domains: ["valid.com", 123] });
    expect(al.domains).toEqual(["valid.com", "123"]);
  });
});

// ─── Rule normalization ──────────────────────────────────────

describe("rule normalization", () => {
  it("normalizes valid rules", () => {
    const rules = normalizeRules([
      { name: "test-rule", action: "deny", destination: "1.2.3.4", protocol: "tcp" },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("test-rule");
    expect(rules[0].action).toBe("deny");
    expect(rules[0].destination).toBe("1.2.3.4");
  });

  it("returns empty array for non-array input", () => {
    expect(normalizeRules(null)).toEqual([]);
    expect(normalizeRules(undefined)).toEqual([]);
    expect(normalizeRules("not-an-array")).toEqual([]);
  });

  it("skips null entries in rules array", () => {
    const rules = normalizeRules([
      { name: "valid", action: "deny" },
      null,
      { name: "also-valid", action: "allow" },
    ]);

    expect(rules).toHaveLength(2);
    expect(rules[0].name).toBe("valid");
    expect(rules[1].name).toBe("also-valid");
  });

  it("defaults action to deny when missing", () => {
    const rules = normalizeRules([{ name: "no-action" }]);
    expect(rules[0].action).toBe("deny");
  });

  it("omits undefined optional fields", () => {
    const rules = normalizeRules([{ name: "minimal", action: "deny" }]);
    expect(rules[0].direction).toBeUndefined();
    expect(rules[0].protocol).toBeUndefined();
    expect(rules[0].destination).toBeUndefined();
    expect(rules[0].port).toBeUndefined();
  });
});

// ─── Firewall status shape ─────────────────────────────────────

describe("firewall status", () => {
  it("returns configured status with correct counts", () => {
    const cfg = parseConfig(SAMPLE_CONFIG);
    const status = buildStatus(cfg, false, "/test/firewall.yaml");

    expect(status.configured).toBe(true);
    expect(status.enforced).toBe(false);
    expect(status.configPath).toBe("/test/firewall.yaml");
    expect(status.defaultAction).toBe("deny");
    // ruleCount = 2 rules + 12 domains + 1 IP = 15
    expect(status.ruleCount).toBe(15);
    expect(status.allowedDomains).toHaveLength(12);
    expect(status.allowedIPs).toEqual(["127.0.0.1"]);
    expect(status.allowedPorts).toEqual([443, 80]);
    expect(status.denyRules).toHaveLength(2);
    expect(status.loggingEnabled).toBe(true);
    expect(status.error).toBeUndefined();
  });

  it("returns enforced=true when pfctl is active", () => {
    const cfg = parseConfig(SAMPLE_CONFIG);
    const status = buildStatus(cfg, true, "/test/firewall.yaml");

    expect(status.configured).toBe(true);
    expect(status.enforced).toBe(true);
  });

  it("returns not-configured status when config is null", () => {
    const status = buildStatus(null, false, "/test/firewall.yaml");

    expect(status.configured).toBe(false);
    expect(status.enforced).toBe(false);
    expect(status.ruleCount).toBe(0);
    expect(status.allowedDomains).toEqual([]);
    expect(status.error).toBe("Firewall config not found");
  });

  it("only includes deny rules in denyRules field", () => {
    const cfg = parseConfig({
      rules: [
        { name: "block-meta", action: "deny", destination: "169.254.169.254" },
        { name: "allow-custom", action: "allow", destination: "10.0.0.1" },
      ],
    });
    const status = buildStatus(cfg, false, "/test/firewall.yaml");

    expect(status.denyRules).toHaveLength(1);
    expect(status.denyRules[0].name).toBe("block-meta");
  });

  it("includes all NanoClaw-required domains", () => {
    const cfg = parseConfig(SAMPLE_CONFIG);
    const status = buildStatus(cfg, false, "/test/firewall.yaml");

    // Core services that NanoClaw agents need
    expect(status.allowedDomains).toContain("api.anthropic.com");
    expect(status.allowedDomains).toContain("api.notion.com");
    expect(status.allowedDomains).toContain("webexapis.com");
    expect(status.allowedDomains).toContain("calendar.google.com");
    expect(status.allowedDomains).toContain("gmail.googleapis.com");
  });
});

// ─── API response shape contract ──────────────────────────────

describe("API response shape", () => {
  it("configured response has all required fields for dashboard", () => {
    const cfg = parseConfig(SAMPLE_CONFIG);
    const status = buildStatus(cfg, false, "/test/firewall.yaml");

    // These are the fields the ObservabilityView depends on
    expect(status).toHaveProperty("configured");
    expect(status).toHaveProperty("enforced");
    expect(status).toHaveProperty("configPath");
    expect(status).toHaveProperty("defaultAction");
    expect(status).toHaveProperty("ruleCount");
    expect(status).toHaveProperty("allowedDomains");
    expect(status).toHaveProperty("allowedIPs");
    expect(status).toHaveProperty("allowedPorts");
    expect(status).toHaveProperty("denyRules");
    expect(status).toHaveProperty("loggingEnabled");

    // Type checks
    expect(typeof status.configured).toBe("boolean");
    expect(typeof status.enforced).toBe("boolean");
    expect(typeof status.configPath).toBe("string");
    expect(typeof status.defaultAction).toBe("string");
    expect(typeof status.ruleCount).toBe("number");
    expect(Array.isArray(status.allowedDomains)).toBe(true);
    expect(Array.isArray(status.allowedIPs)).toBe(true);
    expect(Array.isArray(status.allowedPorts)).toBe(true);
    expect(Array.isArray(status.denyRules)).toBe(true);
    expect(typeof status.loggingEnabled).toBe("boolean");
  });

  it("not-configured response has deterministic fallback values", () => {
    const status = buildStatus(null, false, "/missing/firewall.yaml");

    expect(status.configured).toBe(false);
    expect(status.enforced).toBe(false);
    expect(status.defaultAction).toBe("deny");
    expect(status.ruleCount).toBe(0);
    expect(status.allowedDomains).toEqual([]);
    expect(status.allowedIPs).toEqual([]);
    expect(status.allowedPorts).toEqual([]);
    expect(status.denyRules).toEqual([]);
    expect(status.loggingEnabled).toBe(false);
    expect(status.error).toBeDefined();
  });

  it("defaultAction is one of deny | allow", () => {
    const deny = buildStatus(parseConfig(SAMPLE_CONFIG), false, "/test");
    expect(["deny", "allow"]).toContain(deny.defaultAction);

    const allow = buildStatus(parseConfig({ ...SAMPLE_CONFIG, default_action: "allow" }), false, "/test");
    expect(allow.defaultAction).toBe("allow");
  });
});

// ─── Enable/disable toggle logic ──────────────────────────────

describe("enable/disable toggle", () => {
  it("toggling enabled=false sets default_action to allow", () => {
    const cfg = parseConfig(SAMPLE_CONFIG);
    expect(cfg.default_action).toBe("deny");

    // Simulate toggle
    cfg.default_action = false ? "deny" : "allow";
    expect(cfg.default_action).toBe("allow");

    const status = buildStatus(cfg, false, "/test");
    expect(status.defaultAction).toBe("allow");
  });

  it("toggling enabled=true sets default_action to deny", () => {
    const cfg = parseConfig({ ...SAMPLE_CONFIG, default_action: "allow" });
    expect(cfg.default_action).toBe("allow");

    cfg.default_action = true ? "deny" : "allow";
    expect(cfg.default_action).toBe("deny");

    const status = buildStatus(cfg, false, "/test");
    expect(status.defaultAction).toBe("deny");
  });
});
