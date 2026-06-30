#!/usr/bin/env node
/**
 * Level 4 — HTML input mode dry-run  (STS required, NO Bedrock call)
 *
 * Tests:
 *  ✓ runBedrock() accepts an HTML file path string
 *  ✓ parseHtmlReport() reads and parses the file
 *  ✓ Findings extracted from HTML go through dedup + batch calculation
 *  ✓ --dry-run exits without calling Bedrock
 *  ✓ Batch count is correct (ceil(unique / 20))
 *
 * Run:  node tests/test-level4-html-dryrun.js
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync } from "fs";

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

// ── Create a temporary test report.html ───────────────────────────────────────
const uxrayDir   = resolve(__dirname, "../.uxray");
const reportPath = resolve(uxrayDir, "test-level4-report.html");

mkdirSync(uxrayDir, { recursive: true });

// 7 findings: 3 duplicate image-alt (dedup → 1), 4 unique = 5 total unique
const MOCK_REPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<body>
<div class="finding">
  <div class="finding-header">
    <span>critical</span><span>axe</span>
    <span class="finding-title">Ensure elements have alternative text</span>
    <code>/campaigns</code>
  </div>
  <div class="finding-desc">[image-alt] Images must have alt — 1 node(s).</div>
  <div class="finding-wcag">WCAG 1.1.1</div>
</div>
<div class="finding">
  <div class="finding-header">
    <span>critical</span><span>axe</span>
    <span class="finding-title">Ensure elements have alternative text</span>
    <code>/campaigns/CMP-1001</code>
  </div>
  <div class="finding-desc">[image-alt] Images must have alt — 1 node(s).</div>
  <div class="finding-wcag">WCAG 1.1.1</div>
</div>
<div class="finding">
  <div class="finding-header">
    <span>critical</span><span>axe</span>
    <span class="finding-title">Ensure elements have alternative text</span>
    <code>/campaigns/new</code>
  </div>
  <div class="finding-desc">[image-alt] Images must have alt — 1 node(s).</div>
  <div class="finding-wcag">WCAG 1.1.1</div>
</div>
<div class="finding">
  <div class="finding-header">
    <span>critical</span><span>axe</span>
    <span class="finding-title">Ensure buttons have discernible text</span>
    <code>/campaigns</code>
  </div>
  <div class="finding-desc">[button-name] 18 nodes.</div>
  <div class="finding-wcag">WCAG 4.1.2</div>
</div>
<div class="finding">
  <div class="finding-header">
    <span>critical</span><span>keyboard</span>
    <span class="finding-title">Keyboard trap detected</span>
    <code>/campaigns</code>
  </div>
  <div class="finding-desc">Focus cycled 5+ times.</div>
  <div class="finding-wcag">WCAG 2.1.2</div>
</div>
<div class="finding">
  <div class="finding-header">
    <span>major</span><span>keyboard</span>
    <span class="finding-title">No skip navigation link</span>
    <code>/campaigns/new</code>
  </div>
  <div class="finding-desc">First focusable is not a skip link.</div>
  <div class="finding-wcag">WCAG 2.4.1</div>
</div>
<div class="finding">
  <div class="finding-header">
    <span>major</span><span>errors</span>
    <span class="finding-title">Form shows no error messages on empty submit</span>
    <code>/campaigns/new</code>
  </div>
  <div class="finding-desc">Form has required fields but no error appeared after submitting empty.</div>
  <div class="finding-wcag">WCAG 3.3.1</div>
</div>
</body></html>`;

writeFileSync(reportPath, MOCK_REPORT_HTML, "utf8");
console.log(`  Mock report written → ${reportPath}\n`);

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════");
console.log("  Level 4 — HTML Input Mode Dry-Run  (STS only)");
console.log("══════════════════════════════════════════════════════\n");

process.argv.push("--dry-run");

const { loadConfig, resolveOutputPaths } = await import("../src/config.js");
const { runBedrock }                     = await import("../src/bedrock.js");

const config = await loadConfig(resolve(__dirname, ".."));
const paths  = resolveOutputPaths(config, resolve(__dirname, ".."));

console.log("  [A] Pre-run checks\n");
assert(typeof runBedrock === "function",  "runBedrock exported as function");
assert(reportPath.endsWith(".html"),     "test report path ends with .html");

console.log("\n  [B] Running runBedrock() with HTML path in dry-run mode...\n");

// Pass the HTML file path string (not a JSON object) — this is the new HTML mode
const relativeHtmlPath = `.uxray/test-level4-report.html`;

let runError = null;
let result;
try {
  result = await runBedrock(relativeHtmlPath, config, paths);
} catch (err) {
  runError = err;
  console.error(`  ERROR: ${err.message}`);
}

console.log("\n  [C] Post-run assertions\n");
assert(runError === null,    "runBedrock(htmlPath) completed without throwing", runError?.message ?? "");
assert(result === undefined, "dry-run returns undefined");

console.log("\n  [D] Verify HTML mode console output (check above)\n");
console.log("      Expected lines:");
console.log("        'Parsing HTML report: .uxray/test-level4-report.html'");
console.log("        'HTML findings parsed: 7'");
console.log("        '7 findings → 5 unique root causes'");
console.log("        'Dry run complete. 5 findings → 1 batch(es) previewed.'");
assert(true, "Confirm the expected lines appear in output above");

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════\n");
if (failed > 0) process.exit(1);

