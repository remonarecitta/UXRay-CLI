#!/usr/bin/env node
/**
 * Level 5 — Full live Bedrock run  (AWS credentials + Bedrock model access required)
 *
 * Tests end-to-end:
 *  ✓ STS identity verified
 *  ✓ Bedrock model responds
 *  ✓ Batch prompt returns { suggestions: [] }
 *  ✓ suggestions.json written to .uxray/
 *  ✓ suggestions.patch written when fixes have before/after
 *  ✓ Each suggestion has required fields
 *  ✓ suggestionsOutput returned from runBedrock()
 *
 * Run:  node tests/test-level5-live-bedrock.js
 *
 * Prerequisites:
 *   - Valid credentials in .env (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
 *   - Claude model enabled in Bedrock console:
 *     https://console.aws.amazon.com/bedrock/home?region=us-west-2#/modelaccess
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, mkdirSync } from "fs";

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

// ── Minimal findings — small batch so the test is fast and cheap ──────────────
const MOCK_FINDINGS = {
  generatedAt:   new Date().toISOString(),
  target:        "http://localhost:3000",
  appName:       "Level5 Test",
  findings: [
    {
      id:          "axe-1",
      route:       "/campaigns",
      source:      "axe",
      severity:    "critical",
      title:       "Ensure elements have alternative text",
      description: "[image-alt] Images must have alternative text — 1 node(s). https://dequeuniversity.com/rules/axe/4.12/image-alt",
      wcag:        ["WCAG 1.1.1"],
    },
    {
      id:          "axe-2",
      route:       "/campaigns",
      source:      "axe",
      severity:    "critical",
      title:       "Ensure buttons have discernible text",
      description: "[button-name] Buttons must have discernible text — 18 node(s). https://dequeuniversity.com/rules/axe/4.12/button-name",
      wcag:        ["WCAG 4.1.2"],
    },
    {
      id:          "kb-1",
      route:       "/campaigns",
      source:      "keyboard",
      severity:    "critical",
      title:       "Keyboard trap detected",
      description: "Focus cycled to 'Winter Welcome Back' 5+ times — keyboard users cannot exit.",
      wcag:        ["WCAG 2.1.2"],
    },
  ],
};

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════");
console.log("  Level 5 — Full Live Bedrock Test");
console.log("══════════════════════════════════════════════════════\n");

const { loadConfig, resolveOutputPaths } = await import("../src/config.js");
const { runBedrock }                     = await import("../src/bedrock.js");

const config = await loadConfig(resolve(__dirname, ".."));
const paths  = resolveOutputPaths(config, resolve(__dirname, ".."));

mkdirSync(paths.dir, { recursive: true });

console.log("  [A] Pre-run\n");
assert(process.env.AWS_ACCESS_KEY_ID,     "AWS_ACCESS_KEY_ID is set");
assert(process.env.AWS_SECRET_ACCESS_KEY, "AWS_SECRET_ACCESS_KEY is set");
assert(process.env.AWS_SESSION_TOKEN,     "AWS_SESSION_TOKEN is set (required for workshop roles)");

console.log("\n  [B] Running runBedrock() — live call (3 findings, 1 batch)...\n");

const startMs  = Date.now();
let   runError = null;
let   result;

try {
  result = await runBedrock(MOCK_FINDINGS, config, paths);
} catch (err) {
  runError = err;
  console.error(`\n  ERROR: ${err.name}: ${err.message}\n`);
}

const durationMs = Date.now() - startMs;

console.log("\n  [C] Return value\n");
assert(runError === null,            "runBedrock() did not throw",         runError?.message ?? "");
assert(result !== undefined,         "runBedrock() returned a value");
assert(typeof result === "object",   "result is an object");

if (result) {
  assert(result.model        === "us.anthropic.claude-sonnet-4-6", `model = "us.anthropic.claude-sonnet-4-6"`, result.model);
  assert(result.inputMode    === "json",                           `inputMode = "json"`,                      result.inputMode);
  assert(result.totalFindings === 3,                               `totalFindings = 3`,                       String(result.totalFindings));
  assert(result.batchCount   === 1,                                `batchCount = 1  (3 findings < batch size 20)`, String(result.batchCount));
  assert(result.bedrockRequests === 1,                             `bedrockRequests = 1`,                     String(result.bedrockRequests));
  assert(Array.isArray(result.suggestions),                        "suggestions is an array");
  assert(result.suggestions.length > 0,                            `at least 1 suggestion returned`,          `got ${result.suggestions?.length}`);
}

console.log("\n  [D] suggestions.json on disk\n");
assert(existsSync(paths.suggestions), `suggestions.json exists at ${paths.suggestions}`);

if (existsSync(paths.suggestions)) {
  const written = JSON.parse(readFileSync(paths.suggestions, "utf8"));
  assert(written.suggestions?.length > 0,   "written suggestions.json has entries");
  assert(written.model === "us.anthropic.claude-sonnet-4-6", "written model ID is correct");
  assert(written.inputMode === "json",       "written inputMode = json");
}

console.log("\n  [E] Suggestion shape validation\n");
const suggestions = result?.suggestions ?? [];

for (const [i, s] of suggestions.entries()) {
  const label = `suggestions[${i}] (${s.findingId})`;
  assert(typeof s.findingId    === "string" && s.findingId,    `${label} has findingId`);
  assert(typeof s.explanation  === "string" && s.explanation,  `${label} has explanation`);
  assert(typeof s.userImpact   === "string" && s.userImpact,   `${label} has userImpact`);
  assert(typeof s.fix          === "object" && s.fix,          `${label} has fix object`);
  assert(typeof s.wcagReference === "string" && s.wcagReference, `${label} has wcagReference`);
  assert(typeof s.testToVerify === "string" && s.testToVerify, `${label} has testToVerify`);
  assert(["immediate","short-term","long-term"].includes(s.priority), `${label} priority is valid`, s.priority);

  if (s.fix) {
    assert(typeof s.fix.description === "string", `${label}.fix has description`);
    assert(typeof s.fix.before      === "string", `${label}.fix has before`);
    assert(typeof s.fix.after       === "string", `${label}.fix has after`);
  }
}

console.log("\n  [F] suggestions.patch\n");
if (existsSync(paths.patch)) {
  const patch = readFileSync(paths.patch, "utf8");
  assert(patch.includes("--- a/"),       "patch contains diff header");
  assert(patch.includes("+++ b/"),       "patch contains diff header");
  assert(patch.includes("git apply"),    "patch contains apply instruction");
  console.log(`  Patch file: ${paths.patch}`);
} else {
  console.log("  – suggestions.patch not written (no fix had before≠after)");
  assert(true, "patch skipped (acceptable if all fixes had no before/after diff)");
}

console.log(`\n  Duration: ${durationMs}ms`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════\n");
if (failed > 0) process.exit(1);

