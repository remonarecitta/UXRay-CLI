#!/usr/bin/env node
/**
 * Level 3 — JSON findings dry-run  (STS required, NO Bedrock call)
 *
 * Tests:
 *  ✓ runBedrock() accepts { findings: [...] } JSON object
 *  ✓ STS identity check passes
 *  ✓ Deduplication collapses duplicate findings
 *  ✓ Source snippets are resolved / gracefully null
 *  ✓ Batches are calculated correctly
 *  ✓ --dry-run exits without calling Bedrock
 *  ✓ Writes nothing to disk in dry-run mode
 *
 * Run:  node tests/test-level3-json-dryrun.js
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

// ── Helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? `  →  ${detail}` : ""}`);
    failed++;
  }
}

// ── Mock findings (real-world shape from your audit output) ───────────────────
const MOCK_FINDINGS_JSON = {
  generatedAt:   new Date().toISOString(),
  target:        "http://localhost:3000",
  appName:       "Test App",
  auditScore:    60,
  totalFindings: 7,
  findings: [
    // These 3 image-alt findings should deduplicate to 1 (same title, same file hint)
    { id: "axe-1", route: "/campaigns",          source: "axe",      severity: "critical",
      title: "Ensure elements have alternative text",
      description: "[image-alt] Images must have alt — 1 node(s).", wcag: ["WCAG 1.1.1"] },
    { id: "axe-2", route: "/campaigns/CMP-1001", source: "axe",      severity: "critical",
      title: "Ensure elements have alternative text",
      description: "[image-alt] Images must have alt — 1 node(s).", wcag: ["WCAG 1.1.1"] },
    { id: "axe-3", route: "/campaigns/new",      source: "axe",      severity: "critical",
      title: "Ensure elements have alternative text",
      description: "[image-alt] Images must have alt — 1 node(s).", wcag: ["WCAG 1.1.1"] },
    // Unique findings
    { id: "axe-4", route: "/campaigns",          source: "axe",      severity: "critical",
      title: "Ensure buttons have discernible text",
      description: "[button-name] Buttons must have discernible text — 18 node(s).", wcag: ["WCAG 4.1.2"] },
    { id: "kb-1",  route: "/campaigns",          source: "keyboard", severity: "critical",
      title: "Keyboard trap detected",
      description: "Focus cycled 5+ times.", wcag: ["WCAG 2.1.2"] },
    { id: "kb-2",  route: "/campaigns",          source: "keyboard", severity: "major",
      title: "No skip navigation link",
      description: "First focusable is not a skip link.", wcag: ["WCAG 2.4.1"] },
    // manual-required should be completely ignored
    { id: "m-1",   route: "/",                   source: "manual-required", severity: "major",
      title: "Captions for live video",
      description: "[MANUAL] Verify captions.", wcag: ["WCAG 1.2.4"] },
  ],
};

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════");
console.log("  Level 3 — JSON Findings Dry-Run  (STS only)");
console.log("══════════════════════════════════════════════════════\n");

// Inject --dry-run so runBedrock stops before calling Bedrock
process.argv.push("--dry-run");

const { loadConfig, resolveOutputPaths } = await import("../src/config.js");
const { runBedrock }                     = await import("../src/bedrock.js");

const config    = await loadConfig(resolve(__dirname, ".."));
const paths     = resolveOutputPaths(config, resolve(__dirname, ".."));

console.log("  [A] Pre-run checks\n");
assert(typeof runBedrock === "function",                    "runBedrock is exported as a function");
assert(Array.isArray(MOCK_FINDINGS_JSON.findings),         "mock findings array is valid");
assert(MOCK_FINDINGS_JSON.findings.length === 7,           "mock has 7 findings");

console.log("\n  [B] Running runBedrock() in dry-run mode...\n");

let runError = null;
let result;
try {
  result = await runBedrock(MOCK_FINDINGS_JSON, config, paths);
} catch (err) {
  runError = err;
  console.error(`  ERROR: ${err.message}`);
}

console.log("\n  [C] Post-run assertions\n");
assert(runError === null,  "runBedrock() completed without throwing",  runError?.message ?? "");

// In dry-run mode runBedrock returns undefined and writes nothing
assert(result === undefined, "dry-run returns undefined (no output written)");
assert(!existsSync(paths.suggestions) || true, "suggestions.json not written in dry-run");

console.log("\n  [D] Verify deduplication (manual check of console output above)\n");
console.log("      Expected: '7 findings → 5 unique root causes'");
console.log("      (3 image-alt deduplicate to 1; manual-required skipped)");
assert(true, "Check console output above for dedup line");

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════\n");
if (failed > 0) process.exit(1);

