/**
 * Parity test: ensures scripts/lib/ollama-client.ts and
 * dashboard/src/lib/ollama-client.ts stay in sync.
 *
 * These two files must share identical routing, health-check,
 * and format-translation logic. This test catches drift by
 * comparing the critical code sections.
 *
 * To run: place this in the project root test path so both files
 * are accessible. Uses fs.readFileSync to compare source text.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Adjust these paths to your project root
const SCRIPTS_CLIENT = path.resolve("scripts/lib/ollama-client.ts");
const DASHBOARD_CLIENT = path.resolve("dashboard/src/lib/ollama-client.ts");

function readFile(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

/**
 * Extract the core logic sections that MUST be identical between the two copies.
 * Strips comments and the file-level JSDoc (which differ by design).
 */
function extractCoreLogic(source: string): {
  envVars: string[];
  healthCheckBody: string;
  failOpenLogic: string;
  defenseclawUrl: string;
  thinkRegex: string;
} {
  // Environment variable declarations (must match exactly)
  const envVarPattern =
    /const (OLLAMA_URL|DEFENSECLAW_URL|DEFENSECLAW_KEY|DEFENSECLAW_FAIL_OPEN) = .+;/g;
  const envVars = [...source.matchAll(envVarPattern)].map((m) => m[0]);

  // Health check interval body
  const healthMatch = source.match(
    /setInterval\(async \(\) => \{([\s\S]*?)\}, \d+\)/
  );
  const healthCheckBody = healthMatch?.[1]?.trim() || "";

  // Fail-open logic (the if-block that decides routing)
  const failOpenMatch = source.match(
    /if \(DEFENSECLAW_URL && !defenseClawHealthy[\s\S]*?\}/
  );
  const failOpenLogic = failOpenMatch?.[0]?.trim() || "";

  // DefenseClaw URL construction
  const urlMatch = source.match(
    /fetch\(`\$\{DEFENSECLAW_URL\}\/v1\/chat\/completions`/
  );
  const defenseclawUrl = urlMatch?.[0] || "";

  // Think tag stripping regex (must be identical)
  const thinkMatch = source.match(/<think>[\s\S]*?<\/think>/);
  const thinkRegex = thinkMatch?.[0] || "";

  return { envVars, healthCheckBody, failOpenLogic, defenseclawUrl, thinkRegex };
}

describe("ollama-client parity", () => {
  it("both files exist", () => {
    expect(fs.existsSync(SCRIPTS_CLIENT)).toBe(true);
    expect(fs.existsSync(DASHBOARD_CLIENT)).toBe(true);
  });

  it("environment variable declarations are identical", () => {
    const scripts = extractCoreLogic(readFile(SCRIPTS_CLIENT));
    const dashboard = extractCoreLogic(readFile(DASHBOARD_CLIENT));

    expect(scripts.envVars).toEqual(dashboard.envVars);
  });

  it("health check poll logic is identical", () => {
    const scripts = extractCoreLogic(readFile(SCRIPTS_CLIENT));
    const dashboard = extractCoreLogic(readFile(DASHBOARD_CLIENT));

    expect(scripts.healthCheckBody).toBe(dashboard.healthCheckBody);
  });

  it("fail-open/fail-closed branching is identical", () => {
    const scripts = extractCoreLogic(readFile(SCRIPTS_CLIENT));
    const dashboard = extractCoreLogic(readFile(DASHBOARD_CLIENT));

    expect(scripts.failOpenLogic).toBe(dashboard.failOpenLogic);
  });

  it("DefenseClaw endpoint URL construction is identical", () => {
    const scripts = extractCoreLogic(readFile(SCRIPTS_CLIENT));
    const dashboard = extractCoreLogic(readFile(DASHBOARD_CLIENT));

    expect(scripts.defenseclawUrl).toBe(dashboard.defenseclawUrl);
  });

  it("think-tag stripping regex is identical", () => {
    const scripts = extractCoreLogic(readFile(SCRIPTS_CLIENT));
    const dashboard = extractCoreLogic(readFile(DASHBOARD_CLIENT));

    expect(scripts.thinkRegex).toBe(dashboard.thinkRegex);
  });

  it("dashboard copy does NOT export ollamaEmbed", () => {
    const dashboard = readFile(DASHBOARD_CLIENT);
    expect(dashboard).not.toContain("export async function ollamaEmbed");
  });

  it("scripts copy DOES export ollamaEmbed", () => {
    const scripts = readFile(SCRIPTS_CLIENT);
    expect(scripts).toContain("export async function ollamaEmbed");
  });

  it("dashboard copy does NOT handle images parameter", () => {
    const dashboard = readFile(DASHBOARD_CLIENT);
    // Dashboard version should not have image_url content blocks
    expect(dashboard).not.toContain("image_url");
  });

  it("scripts copy handles images parameter", () => {
    const scripts = readFile(SCRIPTS_CLIENT);
    expect(scripts).toContain("image_url");
  });
});
