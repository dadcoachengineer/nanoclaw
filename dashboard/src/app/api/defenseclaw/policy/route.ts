import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── DC instance definitions ──────────────────────

const DC_INSTANCES = [
  {
    id: "defenseclaw-ollama",
    label: "DefenseClaw Ollama",
    apiPort: 18790,
    dataDir: `${process.env.HOME}/.defenseclaw`,
  },
  {
    id: "defenseclaw-anthropic",
    label: "DefenseClaw Anthropic",
    apiPort: 18792,
    dataDir: `${process.env.HOME}/.dc-anthropic-home/.defenseclaw`,
  },
];

// Path to the DefenseClaw repo preset YAMLs
const DC_REPO_POLICIES = `${process.env.HOME}/defenseclaw/policies`;

// ── Types ──────────────────────

interface PresetSummary {
  name: string;
  description: string;
  blocks: string;       // human-readable: which severities get blocked
  warns: string;        // human-readable: which severities get warned
  firewallDefault: string;
  guardrailBlockThreshold: string;
  auditRetentionDays: number;
}

interface PolicyStatus {
  active: string;
  presets: PresetSummary[];
}

// ── YAML parsing (minimal, no dependency) ──────────────────────

/** Extract a scalar value from a YAML string by key (top-level only). */
function yamlScalar(yaml: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = re.exec(yaml);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

/** Extract numeric value from a YAML string by key (top-level only). */
function yamlNumber(yaml: string, key: string): number {
  const v = yamlScalar(yaml, key);
  return v ? parseInt(v, 10) : 0;
}

// ── Master key derivation ──────────────────────

function deriveMasterKey(dataDir: string): string {
  try {
    const keyData = fs.readFileSync(`${dataDir}/device.key`);
    const mac = crypto
      .createHmac("sha256", "defenseclaw-proxy-master-key")
      .update(keyData)
      .digest("hex");
    return "sk-dc-" + mac.slice(0, 32);
  } catch {
    return "";
  }
}

// ── Preset analysis ──────────────────────

function describePreset(yaml: string): PresetSummary {
  const name = yamlScalar(yaml, "name") || "unknown";
  const description = yamlScalar(yaml, "description") || "";

  // Parse skill_actions to determine block/warn thresholds
  const blocks: string[] = [];
  const warns: string[] = [];

  for (const sev of ["critical", "high", "medium", "low", "info"]) {
    // Look for runtime: disable or runtime: enable under each severity
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

  // Firewall default action
  const firewallDefault = yamlScalar(yaml, "  default_action") || "deny";

  // Guardrail block threshold
  const blockThreshold = yamlNumber(yaml, "  block_threshold");
  const thresholdLabels: Record<number, string> = {
    1: "LOW+",
    2: "MEDIUM+",
    3: "HIGH+",
    4: "CRITICAL only",
  };
  const guardrailBlockThreshold = thresholdLabels[blockThreshold] || `level ${blockThreshold}`;

  // Audit retention
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

// ── Read active policy name from data.json ──────────────────────

function readActivePolicyName(): string {
  // Check both instances; they should be the same
  for (const inst of DC_INSTANCES) {
    const dataJsonPath = path.join(inst.dataDir, "policies", "rego", "data.json");
    try {
      const raw = fs.readFileSync(dataJsonPath, "utf-8");
      const data = JSON.parse(raw);
      if (data.config?.policy_name) return data.config.policy_name;
    } catch {
      continue;
    }
  }
  // Fallback: check repo copy
  try {
    const raw = fs.readFileSync(path.join(DC_REPO_POLICIES, "rego", "data.json"), "utf-8");
    const data = JSON.parse(raw);
    return data.config?.policy_name || "default";
  } catch {
    return "default";
  }
}

// ── Load all preset summaries ──────────────────────

function loadPresets(): PresetSummary[] {
  const presetNames = ["default", "strict", "permissive"];
  const presets: PresetSummary[] = [];

  for (const name of presetNames) {
    const yamlPath = path.join(DC_REPO_POLICIES, `${name}.yaml`);
    try {
      const yaml = fs.readFileSync(yamlPath, "utf-8");
      presets.push(describePreset(yaml));
    } catch {
      presets.push({
        name,
        description: `${name} policy (file not found)`,
        blocks: "unknown",
        warns: "unknown",
        firewallDefault: "unknown",
        guardrailBlockThreshold: "unknown",
        auditRetentionDays: 0,
      });
    }
  }

  return presets;
}

// ── Convert preset YAML to OPA data.json ──────────────────────

interface DataJson {
  config: {
    policy_name: string;
    allow_list_bypass_scan: boolean;
    scan_on_install: boolean;
    max_enforcement_delay_seconds: number;
  };
  actions: Record<string, { runtime: string; file: string; install: string }>;
  scanner_overrides: Record<string, Record<string, { runtime: string; file: string; install: string }>>;
  severity_ranking: Record<string, number>;
  audit: { retention_days: number; log_all_actions: boolean; log_scan_results: boolean };
  guardrail: {
    severity_rank: Record<string, number>;
    block_threshold: number;
    alert_threshold: number;
    cisco_trust_level: string;
    patterns: Record<string, string[]>;
    severity_mappings: Record<string, string>;
  };
}

function presetYamlToDataJson(yaml: string): DataJson {
  const name = yamlScalar(yaml, "name") || "default";

  // Parse admission
  const scanOnInstall = yamlScalar(yaml, "  scan_on_install") === "true";
  const allowListBypassScan = yamlScalar(yaml, "  allow_list_bypass_scan") === "true";

  // Parse enforcement delay
  const maxDelay = yamlNumber(yaml, "  max_enforcement_delay_seconds") || 2;

  // Parse skill_actions
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

  // Parse scanner_overrides (nested YAML)
  const scannerOverrides: Record<string, Record<string, { runtime: string; file: string; install: string }>> = {};
  const overridesMatch = /scanner_overrides:\s*\n((?:\s{2,}\S.*\n(?:\s{4,}.*\n)*)*)/m.exec(yaml);
  if (overridesMatch && overridesMatch[1].trim() !== "{}") {
    const block = overridesMatch[1];
    // Parse each target_type block
    const typeRe = /^\s{2}(\w+):\s*\n((?:\s{4,}.*\n)*)/gm;
    let tm;
    while ((tm = typeRe.exec(block)) !== null) {
      const targetType = tm[1];
      const typeBlock = tm[2];
      scannerOverrides[targetType] = {};
      // Parse each severity within the type
      const sevRe = /^\s{4}(\w+):\s*\n((?:\s{6,}.*\n)*)/gm;
      let sm;
      while ((sm = sevRe.exec(typeBlock)) !== null) {
        const severity = sm[1];
        const sevBlock = sm[2];
        const file = (/file:\s*(\S+)/.exec(sevBlock))?.[1] || "none";
        const runtime = (/runtime:\s*(\S+)/.exec(sevBlock))?.[1] || "enable";
        const install = (/install:\s*(\S+)/.exec(sevBlock))?.[1] || "none";
        scannerOverrides[targetType][severity] = {
          runtime: runtime === "disable" ? "block" : "allow",
          file,
          install,
        };
      }
    }
  }

  // Parse guardrail
  const blockThreshold = yamlNumber(yaml, "  block_threshold") || 3;
  const alertThreshold = yamlNumber(yaml, "  alert_threshold") || 2;
  const ciscoTrustLevel = yamlScalar(yaml, "  cisco_trust_level") || "full";

  // Parse guardrail patterns
  const patterns: Record<string, string[]> = {};
  const patternCategories = ["injection", "secrets", "exfiltration"];
  for (const cat of patternCategories) {
    const catRe = new RegExp(`^\\s{4}${cat}:\\s*\\n((?:\\s{6}-\\s.*\\n)*)`, "m");
    const cm = catRe.exec(yaml);
    if (cm) {
      const items: string[] = [];
      const itemRe = /^\s{6}-\s+"?([^"\n]+)"?\s*$/gm;
      let im;
      while ((im = itemRe.exec(cm[1])) !== null) {
        items.push(im[1].replace(/^["']|["']$/g, ""));
      }
      patterns[cat] = items;
    }
  }

  // Parse severity mappings
  const severityMappings: Record<string, string> = {};
  const mappingsRe = /severity_mappings:\s*\n((?:\s{4,}\w+:.*\n)*)/m;
  const mm = mappingsRe.exec(yaml);
  if (mm) {
    const lines = mm[1].trim().split("\n");
    for (const line of lines) {
      const [k, v] = line.trim().split(/:\s*/);
      if (k && v) severityMappings[k] = v;
    }
  }

  // Parse audit
  const retentionDays = yamlNumber(yaml, "  retention_days") || 90;
  const logAllActions = yamlScalar(yaml, "  log_all_actions") !== "false";
  const logScanResults = yamlScalar(yaml, "  log_scan_results") !== "false";

  return {
    config: {
      policy_name: name,
      allow_list_bypass_scan: allowListBypassScan,
      scan_on_install: scanOnInstall,
      max_enforcement_delay_seconds: maxDelay,
    },
    actions,
    scanner_overrides: scannerOverrides,
    severity_ranking: {
      CRITICAL: 5,
      HIGH: 4,
      MEDIUM: 3,
      LOW: 2,
      INFO: 1,
    },
    audit: {
      retention_days: retentionDays,
      log_all_actions: logAllActions,
      log_scan_results: logScanResults,
    },
    guardrail: {
      severity_rank: { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 },
      block_threshold: blockThreshold,
      alert_threshold: alertThreshold,
      cisco_trust_level: ciscoTrustLevel,
      patterns,
      severity_mappings: severityMappings,
    },
  };
}

// ── Apply preset to both instances ──────────────────────

async function applyPreset(presetName: string): Promise<{ ok: boolean; errors: string[] }> {
  const yamlPath = path.join(DC_REPO_POLICIES, `${presetName}.yaml`);
  let yaml: string;
  try {
    yaml = fs.readFileSync(yamlPath, "utf-8");
  } catch {
    return { ok: false, errors: [`Preset file not found: ${presetName}.yaml`] };
  }

  const dataJson = presetYamlToDataJson(yaml);
  const dataJsonStr = JSON.stringify(dataJson, null, 2) + "\n";

  const errors: string[] = [];

  // Write data.json to each instance's rego dir and call /policy/reload
  for (const inst of DC_INSTANCES) {
    const regoDir = path.join(inst.dataDir, "policies", "rego");
    const dataJsonPath = path.join(regoDir, "data.json");

    // Check rego dir exists
    if (!fs.existsSync(regoDir)) {
      errors.push(`${inst.label}: policies/rego/ directory not found at ${regoDir}`);
      continue;
    }

    // Write data.json
    try {
      fs.writeFileSync(dataJsonPath, dataJsonStr, "utf-8");
    } catch (err) {
      errors.push(`${inst.label}: failed to write data.json: ${err}`);
      continue;
    }

    // Call /policy/reload
    const clientKey = deriveMasterKey(inst.dataDir);
    try {
      const resp = await fetch(`http://127.0.0.1:${inst.apiPort}/policy/reload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DefenseClaw-Client": clientKey,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        errors.push(`${inst.label}: reload returned ${resp.status}: ${body}`);
      }
    } catch (err) {
      errors.push(`${inst.label}: reload failed: ${err}`);
    }
  }

  // Also update the repo copy so it stays in sync
  try {
    const repoRegoDir = path.join(DC_REPO_POLICIES, "rego");
    if (fs.existsSync(repoRegoDir)) {
      fs.writeFileSync(path.join(repoRegoDir, "data.json"), dataJsonStr, "utf-8");
    }
  } catch {
    // non-critical
  }

  return { ok: errors.length === 0, errors };
}

// ── GET: current policy status + presets ──────────────────────

/**
 * GET /api/defenseclaw/policy
 * Returns: { active: string, presets: PresetSummary[] }
 */
export async function GET() {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const active = readActivePolicyName();
  const presets = loadPresets();

  return NextResponse.json({ active, presets } satisfies PolicyStatus);
}

// ── PATCH: switch to a preset ──────────────────────

/**
 * PATCH /api/defenseclaw/policy
 * Body: { preset: "default" | "strict" | "permissive" }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { preset } = await req.json();
  if (!preset || !["default", "strict", "permissive"].includes(preset)) {
    return NextResponse.json(
      { error: "preset must be one of: default, strict, permissive" },
      { status: 400 },
    );
  }

  const result = await applyPreset(preset);

  if (!result.ok) {
    return NextResponse.json(
      { error: "partial failure", errors: result.errors, applied: preset },
      { status: 207 },
    );
  }

  return NextResponse.json({ ok: true, active: preset });
}
