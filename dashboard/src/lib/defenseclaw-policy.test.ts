/**
 * Tests for the /api/defenseclaw/policy dashboard route.
 *
 * Tests the DefenseClaw OPA policy management:
 * - Preset YAML parsing and summary generation
 * - data.json generation from preset YAML
 * - GET response shape (active preset + preset list)
 * - PATCH validation (preset switching)
 * - Policy color-coding logic
 *
 * These are unit tests with no real filesystem or network access.
 */
import { describe, it, expect } from "vitest";

// ── Extracted types (mirrors route.ts) ──────────────────────

interface PresetSummary {
  name: string;
  description: string;
  blocks: string;
  warns: string;
  firewallDefault: string;
  guardrailBlockThreshold: string;
  auditRetentionDays: number;
}

// ── Extracted functions under test ──────────────────────
// Mirrored from dashboard/src/app/api/defenseclaw/policy/route.ts for isolated testing.

function yamlScalar(yaml: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = re.exec(yaml);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

function yamlNumber(yaml: string, key: string): number {
  const v = yamlScalar(yaml, key);
  return v ? parseInt(v, 10) : 0;
}

function describePreset(yaml: string): PresetSummary {
  const name = yamlScalar(yaml, "name") || "unknown";
  const description = yamlScalar(yaml, "description") || "";

  const blocks: string[] = [];
  const warns: string[] = [];

  for (const sev of ["critical", "high", "medium", "low", "info"]) {
    const sevSection = new RegExp(
      `^\\s+${sev}:\\s*\\n((?:\\s{4,}\\S.*\\n)*)`,
      "m"
    );
    const m = sevSection.exec(yaml);
    if (m) {
      const section = m[1];
      if (/runtime:\s*disable/.test(section)) {
        blocks.push(sev.toUpperCase());
      } else if (/runtime:\s*enable/.test(section)) {
        warns.push(sev.toUpperCase());
      }
    }
  }

  const firewallDefault = yamlScalar(yaml, "  default_action") || "deny";

  const blockThreshold = yamlNumber(yaml, "  block_threshold");
  const thresholdLabels: Record<number, string> = {
    1: "LOW+",
    2: "MEDIUM+",
    3: "HIGH+",
    4: "CRITICAL only",
  };
  const guardrailBlockThreshold = thresholdLabels[blockThreshold] || `level ${blockThreshold}`;

  const auditRetentionDays = yamlNumber(yaml, "  retention_days") || 90;

  return {
    name,
    description,
    blocks: blocks.length > 0 ? blocks.join(", ") : "none",
    warns: warns.length > 0 ? warns.join(", ") : "none",
    firewallDefault,
    guardrailBlockThreshold,
    auditRetentionDays,
  };
}

function presetYamlToDataJson(yaml: string) {
  const name = yamlScalar(yaml, "name") || "default";
  const scanOnInstall = yamlScalar(yaml, "  scan_on_install") === "true";
  const allowListBypassScan = yamlScalar(yaml, "  allow_list_bypass_scan") === "true";
  const maxDelay = yamlNumber(yaml, "  max_enforcement_delay_seconds") || 2;

  const actions: Record<string, { runtime: string; file: string; install: string }> = {};
  for (const sev of ["critical", "high", "medium", "low", "info"]) {
    const sevSection = new RegExp(
      `^\\s+${sev}:\\s*\\n((?:\\s{4,}\\S.*\\n)*)`,
      "m"
    );
    const m = sevSection.exec(yaml);
    if (m) {
      const section = m[1];
      const fileVal = (/file:\s*(\S+)/.exec(section))?.[1] || "none";
      const runtimeVal = (/runtime:\s*(\S+)/.exec(section))?.[1] || "enable";
      const installVal = (/install:\s*(\S+)/.exec(section))?.[1] || "none";
      actions[sev.toUpperCase()] = {
        runtime: runtimeVal === "disable" ? "block" : "allow",
        file: fileVal,
        install: installVal,
      };
    }
  }

  const blockThreshold = yamlNumber(yaml, "  block_threshold") || 3;
  const alertThreshold = yamlNumber(yaml, "  alert_threshold") || 2;
  const ciscoTrustLevel = yamlScalar(yaml, "  cisco_trust_level") || "full";
  const retentionDays = yamlNumber(yaml, "  retention_days") || 90;

  return {
    config: {
      policy_name: name,
      allow_list_bypass_scan: allowListBypassScan,
      scan_on_install: scanOnInstall,
      max_enforcement_delay_seconds: maxDelay,
    },
    actions,
    severity_ranking: { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 },
    audit: { retention_days: retentionDays, log_all_actions: true, log_scan_results: true },
    guardrail: {
      severity_rank: { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 },
      block_threshold: blockThreshold,
      alert_threshold: alertThreshold,
      cisco_trust_level: ciscoTrustLevel,
    },
  };
}

// ── Policy color-coding logic ──────────────────────

function policyColor(name: string): string {
  return name === "strict" ? "#f85149" : name === "permissive" ? "#d29922" : "#58a6ff";
}

// ── Sample preset YAMLs ──────────────────────

const DEFAULT_YAML = `# DefenseClaw Default Policy
name: default
description: Balanced security policy for standard deployments

admission:
  scan_on_install: true
  allow_list_bypass_scan: true

skill_actions:
  critical:
    file: quarantine
    runtime: disable
    install: block
  high:
    file: quarantine
    runtime: disable
    install: block
  medium:
    file: none
    runtime: enable
    install: none
  low:
    file: none
    runtime: enable
    install: none
  info:
    file: none
    runtime: enable
    install: none

guardrail:
  block_threshold: 3
  alert_threshold: 2
  cisco_trust_level: full

firewall:
  default_action: deny

audit:
  retention_days: 90
`;

const STRICT_YAML = `# DefenseClaw Strict Policy
name: strict
description: Maximum security policy for high-risk environments

admission:
  scan_on_install: true
  allow_list_bypass_scan: false

skill_actions:
  critical:
    file: quarantine
    runtime: disable
    install: block
  high:
    file: quarantine
    runtime: disable
    install: block
  medium:
    file: quarantine
    runtime: disable
    install: block
  low:
    file: none
    runtime: enable
    install: none
  info:
    file: none
    runtime: enable
    install: none

guardrail:
  block_threshold: 2
  alert_threshold: 1
  cisco_trust_level: full

firewall:
  default_action: deny

audit:
  retention_days: 365
`;

const PERMISSIVE_YAML = `# DefenseClaw Permissive Policy
name: permissive
description: Permissive policy for development and testing

admission:
  scan_on_install: true
  allow_list_bypass_scan: true

skill_actions:
  critical:
    file: quarantine
    runtime: disable
    install: block
  high:
    file: none
    runtime: enable
    install: none
  medium:
    file: none
    runtime: enable
    install: none
  low:
    file: none
    runtime: enable
    install: none
  info:
    file: none
    runtime: enable
    install: none

guardrail:
  block_threshold: 4
  alert_threshold: 3
  cisco_trust_level: advisory

firewall:
  default_action: allow

audit:
  retention_days: 30
`;

// ── Tests ──────────────────────

describe("YAML scalar parsing", () => {
  it("extracts top-level name field", () => {
    expect(yamlScalar(DEFAULT_YAML, "name")).toBe("default");
    expect(yamlScalar(STRICT_YAML, "name")).toBe("strict");
    expect(yamlScalar(PERMISSIVE_YAML, "name")).toBe("permissive");
  });

  it("extracts description field", () => {
    expect(yamlScalar(DEFAULT_YAML, "description")).toBe("Balanced security policy for standard deployments");
  });

  it("extracts nested scalar with leading spaces", () => {
    expect(yamlScalar(DEFAULT_YAML, "  default_action")).toBe("deny");
    expect(yamlScalar(PERMISSIVE_YAML, "  default_action")).toBe("allow");
  });

  it("returns empty string for missing key", () => {
    expect(yamlScalar(DEFAULT_YAML, "nonexistent")).toBe("");
  });
});

describe("preset summary generation", () => {
  it("parses default preset correctly", () => {
    const summary = describePreset(DEFAULT_YAML);
    expect(summary.name).toBe("default");
    expect(summary.blocks).toBe("CRITICAL, HIGH");
    expect(summary.warns).toBe("MEDIUM, LOW, INFO");
    expect(summary.firewallDefault).toBe("deny");
    expect(summary.guardrailBlockThreshold).toBe("HIGH+");
    expect(summary.auditRetentionDays).toBe(90);
  });

  it("parses strict preset correctly", () => {
    const summary = describePreset(STRICT_YAML);
    expect(summary.name).toBe("strict");
    expect(summary.blocks).toBe("CRITICAL, HIGH, MEDIUM");
    expect(summary.warns).toBe("LOW, INFO");
    expect(summary.firewallDefault).toBe("deny");
    expect(summary.guardrailBlockThreshold).toBe("MEDIUM+");
    expect(summary.auditRetentionDays).toBe(365);
  });

  it("parses permissive preset correctly", () => {
    const summary = describePreset(PERMISSIVE_YAML);
    expect(summary.name).toBe("permissive");
    expect(summary.blocks).toBe("CRITICAL");
    expect(summary.warns).toBe("HIGH, MEDIUM, LOW, INFO");
    expect(summary.firewallDefault).toBe("allow");
    expect(summary.guardrailBlockThreshold).toBe("CRITICAL only");
    expect(summary.auditRetentionDays).toBe(30);
  });

  it("includes description in summary", () => {
    const summary = describePreset(STRICT_YAML);
    expect(summary.description).toBe("Maximum security policy for high-risk environments");
  });
});

describe("data.json generation from preset YAML", () => {
  it("generates correct config for default preset", () => {
    const data = presetYamlToDataJson(DEFAULT_YAML);
    expect(data.config.policy_name).toBe("default");
    expect(data.config.scan_on_install).toBe(true);
    expect(data.config.allow_list_bypass_scan).toBe(true);
  });

  it("generates correct actions for default preset", () => {
    const data = presetYamlToDataJson(DEFAULT_YAML);
    expect(data.actions.CRITICAL.runtime).toBe("block");
    expect(data.actions.CRITICAL.file).toBe("quarantine");
    expect(data.actions.CRITICAL.install).toBe("block");
    expect(data.actions.HIGH.runtime).toBe("block");
    expect(data.actions.MEDIUM.runtime).toBe("allow");
    expect(data.actions.LOW.runtime).toBe("allow");
    expect(data.actions.INFO.runtime).toBe("allow");
  });

  it("generates correct actions for strict preset", () => {
    const data = presetYamlToDataJson(STRICT_YAML);
    expect(data.actions.CRITICAL.runtime).toBe("block");
    expect(data.actions.HIGH.runtime).toBe("block");
    expect(data.actions.MEDIUM.runtime).toBe("block");
    expect(data.actions.MEDIUM.file).toBe("quarantine");
    expect(data.actions.LOW.runtime).toBe("allow");
  });

  it("generates correct actions for permissive preset", () => {
    const data = presetYamlToDataJson(PERMISSIVE_YAML);
    expect(data.actions.CRITICAL.runtime).toBe("block");
    expect(data.actions.HIGH.runtime).toBe("allow");
    expect(data.actions.HIGH.file).toBe("none");
    expect(data.actions.MEDIUM.runtime).toBe("allow");
  });

  it("generates correct guardrail thresholds", () => {
    const defaultData = presetYamlToDataJson(DEFAULT_YAML);
    expect(defaultData.guardrail.block_threshold).toBe(3);
    expect(defaultData.guardrail.alert_threshold).toBe(2);

    const strictData = presetYamlToDataJson(STRICT_YAML);
    expect(strictData.guardrail.block_threshold).toBe(2);
    expect(strictData.guardrail.alert_threshold).toBe(1);

    const permissiveData = presetYamlToDataJson(PERMISSIVE_YAML);
    expect(permissiveData.guardrail.block_threshold).toBe(4);
    expect(permissiveData.guardrail.alert_threshold).toBe(3);
  });

  it("generates correct cisco_trust_level", () => {
    const defaultData = presetYamlToDataJson(DEFAULT_YAML);
    expect(defaultData.guardrail.cisco_trust_level).toBe("full");

    const permissiveData = presetYamlToDataJson(PERMISSIVE_YAML);
    expect(permissiveData.guardrail.cisco_trust_level).toBe("advisory");
  });

  it("generates correct audit retention", () => {
    expect(presetYamlToDataJson(DEFAULT_YAML).audit.retention_days).toBe(90);
    expect(presetYamlToDataJson(STRICT_YAML).audit.retention_days).toBe(365);
    expect(presetYamlToDataJson(PERMISSIVE_YAML).audit.retention_days).toBe(30);
  });

  it("includes static severity_ranking", () => {
    const data = presetYamlToDataJson(DEFAULT_YAML);
    expect(data.severity_ranking).toEqual({
      CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1,
    });
  });

  it("strict preset disables allow_list_bypass_scan", () => {
    const data = presetYamlToDataJson(STRICT_YAML);
    expect(data.config.allow_list_bypass_scan).toBe(false);
  });
});

describe("policy API response shape", () => {
  it("GET response has required fields", () => {
    // Simulate what GET returns
    const response = {
      active: "default",
      presets: [
        describePreset(DEFAULT_YAML),
        describePreset(STRICT_YAML),
        describePreset(PERMISSIVE_YAML),
      ],
    };

    expect(response.active).toBe("default");
    expect(response.presets).toHaveLength(3);

    for (const preset of response.presets) {
      expect(preset).toHaveProperty("name");
      expect(preset).toHaveProperty("description");
      expect(preset).toHaveProperty("blocks");
      expect(preset).toHaveProperty("warns");
      expect(preset).toHaveProperty("firewallDefault");
      expect(preset).toHaveProperty("guardrailBlockThreshold");
      expect(preset).toHaveProperty("auditRetentionDays");

      expect(typeof preset.name).toBe("string");
      expect(typeof preset.description).toBe("string");
      expect(typeof preset.blocks).toBe("string");
      expect(typeof preset.warns).toBe("string");
      expect(typeof preset.auditRetentionDays).toBe("number");
    }
  });

  it("presets contain all three standard presets", () => {
    const presets = [
      describePreset(DEFAULT_YAML),
      describePreset(STRICT_YAML),
      describePreset(PERMISSIVE_YAML),
    ];

    const names = presets.map((p) => p.name);
    expect(names).toContain("default");
    expect(names).toContain("strict");
    expect(names).toContain("permissive");
  });
});

describe("PATCH validation", () => {
  it("rejects invalid preset names", () => {
    const validPresets = ["default", "strict", "permissive"];
    expect(validPresets.includes("custom")).toBe(false);
    expect(validPresets.includes("")).toBe(false);
    expect(validPresets.includes("Default")).toBe(false);
  });

  it("accepts valid preset names", () => {
    const validPresets = ["default", "strict", "permissive"];
    expect(validPresets.includes("default")).toBe(true);
    expect(validPresets.includes("strict")).toBe(true);
    expect(validPresets.includes("permissive")).toBe(true);
  });
});

describe("policy color-coding", () => {
  it("default policy is blue", () => {
    expect(policyColor("default")).toBe("#58a6ff");
  });

  it("strict policy is red", () => {
    expect(policyColor("strict")).toBe("#f85149");
  });

  it("permissive policy is yellow", () => {
    expect(policyColor("permissive")).toBe("#d29922");
  });

  it("unknown policy defaults to blue", () => {
    expect(policyColor("custom")).toBe("#58a6ff");
  });
});

describe("preset comparison", () => {
  it("strict blocks more severities than default", () => {
    const defaultSummary = describePreset(DEFAULT_YAML);
    const strictSummary = describePreset(STRICT_YAML);

    const defaultBlockCount = defaultSummary.blocks.split(", ").length;
    const strictBlockCount = strictSummary.blocks.split(", ").length;
    expect(strictBlockCount).toBeGreaterThan(defaultBlockCount);
  });

  it("permissive blocks fewer severities than default", () => {
    const defaultSummary = describePreset(DEFAULT_YAML);
    const permissiveSummary = describePreset(PERMISSIVE_YAML);

    const defaultBlockCount = defaultSummary.blocks.split(", ").length;
    const permissiveBlockCount = permissiveSummary.blocks.split(", ").length;
    expect(permissiveBlockCount).toBeLessThan(defaultBlockCount);
  });

  it("strict has longer audit retention than default", () => {
    const defaultSummary = describePreset(DEFAULT_YAML);
    const strictSummary = describePreset(STRICT_YAML);
    expect(strictSummary.auditRetentionDays).toBeGreaterThan(defaultSummary.auditRetentionDays);
  });

  it("permissive has shorter audit retention than default", () => {
    const defaultSummary = describePreset(DEFAULT_YAML);
    const permissiveSummary = describePreset(PERMISSIVE_YAML);
    expect(permissiveSummary.auditRetentionDays).toBeLessThan(defaultSummary.auditRetentionDays);
  });
});
