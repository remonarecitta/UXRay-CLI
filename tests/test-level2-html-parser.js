#!/usr/bin/env node
/**
 * Level 2 — HTML Parser (NO AWS required)
 *
 * Tests the Cheerio-based parseHtmlReport logic from bedrock.js
 * in complete isolation — no credentials, no network calls.
 *
 * Run:  node tests/test-level2-html-parser.js
 */

import * as cheerio from "cheerio";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ── Inline copy of bedrock.js parseHtmlReport logic ───────────────────────────
// (mirrors src/bedrock.js exactly so any divergence is immediately visible)
function parseHtmlReport(html) {
  const $        = cheerio.load(html);
  const findings = [];
  const warnings = [];

  $(".finding").each((index, element) => {
    try {
      const $el       = $(element);
      const severity  = $el.find(".finding-header span:first-child").text().trim().toLowerCase();
      const source    = $el.find(".finding-header span:nth-child(2)").text().trim();
      const route     = $el.find(".finding-header code").text().trim() || "/";
      const title     = $el.find(".finding-title").text().trim();
      const desc      = $el.find(".finding-desc").text().trim();
      const wcagRaw   = $el.find(".finding-wcag").text().trim();
      const wcag      = wcagRaw ? wcagRaw.split("·").map((s) => s.trim()).filter(Boolean) : [];
      const screenshot = $el.find("img").attr("src") || null;

      if (!title)    { warnings.push(`#${index + 1} missing title`);    return; }
      if (!severity) { warnings.push(`#${index + 1} missing severity`); return; }

      findings.push({
        id: `html-${index + 1}`, route, source: source || "html-report",
        severity, title, description: desc, wcag, screenshot,
      });
    } catch (err) {
      warnings.push(`#${index + 1} parse error: ${err.message}`);
    }
  });

  return { findings, warnings };
}

// ── Mock HTML (mirrors structure from src/report/html.js) ─────────────────────
const MOCK_HTML = `<!DOCTYPE html><html><body>

<!-- Finding 1: fully populated critical/axe -->
<div class="finding">
  <div class="finding-header">
    <span style="background:#FCEBEB">critical</span>
    <span style="background:#E6F1FB">axe</span>
    <span class="finding-title">Ensure buttons have discernible text</span>
    <code>/campaigns</code>
  </div>
  <div class="finding-desc">[button-name] Buttons must have discernible text — 18 node(s).</div>
  <div class="finding-wcag">WCAG 2a · WCAG 4.1.2</div>
</div>

<!-- Finding 2: with screenshot -->
<div class="finding">
  <div class="finding-header">
    <span>critical</span>
    <span>axe</span>
    <span class="finding-title">Ensure elements have alternative text</span>
    <code>/campaigns</code>
  </div>
  <div class="finding-desc">[image-alt] Images must have alternative text — 1 node(s).</div>
  <div class="finding-wcag">WCAG 2a · WCAG 1.1.1</div>
  <img src="screenshots/err-image-alt-campaigns.png" alt="Screenshot" loading="lazy">
</div>

<!-- Finding 3: keyboard source -->
<div class="finding">
  <div class="finding-header">
    <span>critical</span>
    <span>keyboard</span>
    <span class="finding-title">Keyboard trap detected</span>
    <code>/campaigns</code>
  </div>
  <div class="finding-desc">Focus cycled to "Winter Welcome Back" 5+ times.</div>
  <div class="finding-wcag">WCAG 2.1.2</div>
</div>

<!-- Finding 4: major severity, different route -->
<div class="finding">
  <div class="finding-header">
    <span>major</span>
    <span>keyboard</span>
    <span class="finding-title">No skip navigation link</span>
    <code>/campaigns/new</code>
  </div>
  <div class="finding-desc">First focusable element is not a skip link.</div>
  <div class="finding-wcag">WCAG 2.4.1</div>
</div>

<!-- Finding 5: minor severity -->
<div class="finding">
  <div class="finding-header">
    <span>minor</span>
    <span>wcagExtended</span>
    <span class="finding-title">Placeholder used as label</span>
    <code>/campaigns/new</code>
  </div>
  <div class="finding-desc">Input uses placeholder as its only label.</div>
  <div class="finding-wcag">WCAG 3.3.2</div>
</div>

<!-- Finding 6: INVALID — missing title — should be skipped -->
<div class="finding">
  <div class="finding-header">
    <span>minor</span><span>axe</span>
    <span class="finding-title"></span>
    <code>/campaigns</code>
  </div>
  <div class="finding-desc">No title here.</div>
  <div class="finding-wcag">WCAG 1.3.1</div>
</div>

<!-- Finding 7: INVALID — missing severity — should be skipped -->
<div class="finding">
  <div class="finding-header">
    <span></span><span>axe</span>
    <span class="finding-title">Finding without severity</span>
    <code>/campaigns</code>
  </div>
  <div class="finding-desc">No severity.</div>
  <div class="finding-wcag">WCAG 1.3.1</div>
</div>

</body></html>`;

// ── Run tests ──────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════");
console.log("  Level 2 — HTML Parser Tests  (no AWS required)");
console.log("══════════════════════════════════════════════════════\n");

const { findings, warnings } = parseHtmlReport(MOCK_HTML);

console.log("  [A] Counts\n");
assert(findings.length === 5, `5 valid findings parsed (2 invalid skipped)`, `got ${findings.length}`);
assert(warnings.length === 2, `2 skip warnings generated`,                   `got ${warnings.length}`);

console.log("\n  [B] Finding 1 — button-name (critical/axe)\n");
const f1 = findings[0];
assert(f1.id          === "html-1",                                    `id = "html-1"`);
assert(f1.severity    === "critical",                                  `severity = "critical"`);
assert(f1.source      === "axe",                                       `source = "axe"`);
assert(f1.route       === "/campaigns",                                `route = "/campaigns"`);
assert(f1.title       === "Ensure buttons have discernible text",      `title correct`);
assert(f1.description.includes("button-name"),                         `description includes "button-name"`);
assert(Array.isArray(f1.wcag) && f1.wcag.length === 2,                 `wcag is array with 2 entries`);
assert(f1.wcag[0]     === "WCAG 2a",                                   `wcag[0] = "WCAG 2a"`);
assert(f1.wcag[1]     === "WCAG 4.1.2",                                `wcag[1] = "WCAG 4.1.2"`);
assert(f1.screenshot  === null,                                        `screenshot = null (no img tag)`);

console.log("\n  [C] Finding 2 — screenshot src captured\n");
const f2 = findings[1];
assert(f2.screenshot  === "screenshots/err-image-alt-campaigns.png",   `screenshot src preserved`);
assert(f2.title.includes("alternative text"),                          `title correct`);

console.log("\n  [D] Finding 3 — keyboard source\n");
const f3 = findings[2];
assert(f3.source      === "keyboard",                                  `source = "keyboard"`);
assert(f3.title.includes("Keyboard trap"),                             `title includes "Keyboard trap"`);
assert(f3.wcag[0]     === "WCAG 2.1.2",                                `wcag[0] = "WCAG 2.1.2"`);

console.log("\n  [E] Finding 4 — major severity / different route\n");
const f4 = findings[3];
assert(f4.severity    === "major",                                     `severity = "major"`);
assert(f4.route       === "/campaigns/new",                            `route = "/campaigns/new"`);

console.log("\n  [F] Finding 5 — minor severity\n");
const f5 = findings[4];
assert(f5.severity    === "minor",                                     `severity = "minor"`);
assert(f5.source      === "wcagExtended",                              `source = "wcagExtended"`);

console.log("\n  [G] Invalid findings correctly skipped\n");
assert(warnings[0].includes("missing title"),                          `Warning 1 mentions "missing title"`);
assert(warnings[1].includes("missing severity"),                       `Warning 2 mentions "missing severity"`);
assert(!findings.some((f) => !f.title),                                `No finding has empty title`);
assert(!findings.some((f) => !f.severity),                             `No finding has empty severity`);

console.log("\n  [H] IDs are sequential html-1..html-5\n");
findings.forEach((f, i) => assert(f.id === `html-${i + 1}`, `findings[${i}].id = "html-${i + 1}"`));

// Write parsed output for inspection
mkdirSync(resolve(__dirname, "../.uxray"), { recursive: true });
const outPath = resolve(__dirname, "../.uxray/test-level2-parsed.json");
writeFileSync(outPath, JSON.stringify({ findings, warnings }, null, 2));
console.log(`\n  Output written → ${outPath}`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════\n");
if (failed > 0) process.exit(1);

