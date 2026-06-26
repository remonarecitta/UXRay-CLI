#!/usr/bin/env node
/**
 * bin/uxray.mjs
 * UXRay CLI entry point
 *
 * Usage:
 *   npx uxray                        run full audit
 *   npx uxray init                   copy uxray.config.js template
 *   npx uxray --checks axe,keyboard  run specific checks
 *   npx uxray --route /campaigns     audit one route
 *   npx uxray --viewport mobile      one viewport only
 *   npx uxray --no-personas          skip persona scoring
 *   npx uxray --out .uxray           custom output dir
 *   npx uxray --bedrock              run AI fix suggestions after audit
 *   npx uxray --help                 show help
 */

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig, validateConfig, resolveOutputPaths } from "../src/config.mjs";
import { runAxeChecks }          from "../src/checks/axe.mjs";
import { runKeyboardChecks }     from "../src/checks/keyboard.mjs";
import { runScreenReaderChecks } from "../src/checks/screenReader.mjs";
import { runResponsiveChecks }   from "../src/checks/responsive.mjs";
import { runErrorChecks }        from "../src/checks/errors.mjs";
import { runWcagExtendedChecks } from "../src/checks/wcag-extended.mjs";
import { runPersonas }           from "../src/personas/scorer.mjs";
import { generateHtmlReport }    from "../src/report/html.mjs";
import { createAuthSession }     from "../src/auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    command:     null,
    checks:      null,       // null = all
    route:       null,       // null = all
    viewport:    null,       // null = all
    personas:    true,
    bedrock:     false,
    out:         null,
    help:        false,
    version:     false,
    dryRun:      false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "init")              args.command   = "init";
    else if (a === "--help" || a === "-h")  args.help      = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--dry-run")    args.dryRun    = true;
    else if (a === "--no-personas") args.personas = false;
    else if (a === "--bedrock")    args.bedrock   = true;
    else if (a === "--checks")     args.checks    = argv[++i]?.split(",").map((s) => s.trim());
    else if (a === "--route")      args.route     = argv[++i];
    else if (a === "--viewport")   args.viewport  = argv[++i];
    else if (a === "--out")        args.out       = argv[++i];
    else if (a.startsWith("--checks="))   args.checks   = a.split("=")[1].split(",");
    else if (a.startsWith("--route="))    args.route    = a.split("=")[1];
    else if (a.startsWith("--viewport=")) args.viewport = a.split("=")[1];
    else if (a.startsWith("--out="))      args.out      = a.split("=")[1];
  }
  return args;
}

// ─── Help ────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
UXRay — WCAG 2.1 AA accessibility and responsiveness auditor

Usage:
  npx uxray [command] [options]

Commands:
  init                Copy uxray.config.js template to current directory

Options:
  --checks <list>     Comma-separated checks to run (default: all)
                      Available: axe, keyboard, screenReader, responsive, errors
  --route <path>      Audit a single route (e.g. --route /campaigns)
  --viewport <name>   Run on one viewport: mobile, tablet, desktop, dark
  --no-personas       Skip persona health scoring
  --bedrock           Run AI fix suggestions after audit (requires AWS credentials)
  --out <dir>         Output directory (default: .uxray)
  --dry-run           Print what would run without making checks
  --help, -h          Show this help
  --version, -v       Show version

Config:
  Create uxray.config.js in your project root.
  Run \`npx uxray init\` for a template.

Environment:
  BASE_URL            Override baseUrl from config
  UXRAY_USER          Login username (if auth configured)
  UXRAY_PASS          Login password (if auth configured)
  AWS_REGION          AWS region for Bedrock (default: us-east-1)
  AWS_ACCESS_KEY_ID   AWS credentials for Bedrock
  AWS_SECRET_ACCESS_KEY

Examples:
  npx uxray
  npx uxray --checks axe,keyboard
  npx uxray --route /campaigns --viewport mobile
  npx uxray --bedrock
  BASE_URL=http://staging.example.com npx uxray
`);
}

// ─── Init command ─────────────────────────────────────────────────────────────

async function runInit(cwd) {
  const dest = join(cwd, "uxray.config.js");
  if (existsSync(dest)) {
    console.log(`uxray.config.js already exists at ${dest}`);
    console.log("Delete it first if you want a fresh template.");
    return;
  }

  const templatePath = join(__dirname, "../init/uxray.config.template.js");
  copyFileSync(templatePath, dest);
  console.log(`\nCreated: ${dest}`);
  console.log("\nNext steps:");
  console.log("  1. Edit uxray.config.js — set baseUrl and your routes");
  console.log("  2. If your app needs auth, fill in the auth block");
  console.log("  3. Run: npx uxray\n");
}

// ─── Finding factory ─────────────────────────────────────────────────────────

let _seq = 0;
export function makeFinding({ route, source, severity, wcag, title, description, screenshot = null }) {
  return { id: `uxray-${String(++_seq).padStart(4, "0")}`, route, source, severity, wcag, title, description, ...(screenshot ? { screenshot } : {}) };
}

// ─── Page loader ──────────────────────────────────────────────────────────────

export async function loadPage(page, url, route) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  if (route?.waitFor) {
    await page.locator(route.waitFor).waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  }
  await page.waitForTimeout(400);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function computeScore(findings, scoring) {
  const automated = findings.filter((f) => f.source !== "manual-required");
  return Math.max(0, 100
    - automated.filter((f) => f.severity === "critical").length * (scoring.critical ?? 10)
    - automated.filter((f) => f.severity === "major").length    * (scoring.major    ?? 5)
    - automated.filter((f) => f.severity === "minor").length    * (scoring.minor    ?? 2)
  );
}

// ─── Summary printer ─────────────────────────────────────────────────────────

function printSummary(findings, score, paths, personaScore) {
  const automated = findings.filter((f) => f.source !== "manual-required");
  const manual    = findings.filter((f) => f.source === "manual-required");
  const bySev = {
    critical: automated.filter((f) => f.severity === "critical").length,
    major:    automated.filter((f) => f.severity === "major").length,
    minor:    automated.filter((f) => f.severity === "minor").length,
  };

  console.log(`\n${"═".repeat(56)}`);
  console.log("  UXRAY SUMMARY");
  console.log(`${"═".repeat(56)}`);
  console.log(`  Audit score:    ${score} / 100`);
  if (personaScore != null) console.log(`  Persona score:  ${personaScore} / 100`);
  console.log(`  Findings:       ${automated.length} automated · ${manual.length} manual gaps`);
  console.log(`    critical:     ${bySev.critical}`);
  console.log(`    major:        ${bySev.major}`);
  console.log(`    minor:        ${bySev.minor}`);
  console.log(`\n  Output:`);
  console.log(`    ${paths.findings}`);
  console.log(`    ${paths.report}`);
  if (existsSync(paths.reportJson)) console.log(`    ${paths.reportJson}`);
  console.log(`${"═".repeat(56)}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const cwd  = process.cwd();

  if (args.help)    { printHelp(); return; }
  if (args.version) { const { createRequire } = await import("module"); const req = createRequire(import.meta.url); console.log(req("../package.json").version); return; }
  if (args.command === "init") { await runInit(cwd); return; }

  console.log("\nUXRay — starting audit");
  console.log(`  cwd: ${cwd}`);

  // Load + validate config
  const cfg   = await loadConfig(cwd);
  validateConfig(cfg);

  // Apply CLI overrides
  if (args.out) cfg.output.dir = args.out;
  if (args.checks) cfg.checks = args.checks;
  if (args.route) cfg.routes = cfg.routes.filter((r) => r.path === args.route);
  if (args.viewport) {
    const vp = cfg.viewports[args.viewport];
    if (!vp) { console.error(`Unknown viewport "${args.viewport}". Available: ${Object.keys(cfg.viewports).join(", ")}`); process.exit(1); }
    cfg.viewports = { [args.viewport]: vp };
  }

  const paths = resolveOutputPaths(cfg, cwd);
  mkdirSync(paths.dir,        { recursive: true });
  mkdirSync(paths.screenshots, { recursive: true });

  console.log(`  Target:  ${cfg.baseUrl}`);
  console.log(`  Routes:  ${cfg.routes.map((r) => r.path).join(", ")}`);
  console.log(`  Checks:  ${cfg.checks.join(", ")}`);
  console.log(`  Output:  ${paths.dir}\n`);

  if (args.dryRun) {
    console.log("Dry run — no checks executed.\n");
    return;
  }

  const browser  = await chromium.launch();
  const startMs  = Date.now();
  const findings = [];

  // ── Auth session ───────────────────────────────────────────────────────────
  const hasAuthRoutes = cfg.routes.some((r) => r.requiresAuth);
  let authSession = null;
  if (hasAuthRoutes && cfg.auth) {
    try {
      authSession = await createAuthSession(browser, cfg);
    } catch (err) {
      console.error(`\nAuth error: ${err.message}\n`);
      await browser.close();
      process.exit(1);
    }
  }

  // ── Run checks in parallel ─────────────────────────────────────────────────
  const checkMap = {
    axe:          runAxeChecks,
    keyboard:     runKeyboardChecks,
    screenReader: runScreenReaderChecks,
    responsive:   runResponsiveChecks,
    errors:       runErrorChecks,
    wcagExtended: runWcagExtendedChecks,
  };

  const checkResults = await Promise.allSettled(
    cfg.checks
      .filter((c) => checkMap[c])
      .map((c) => {
        console.log(`\n── ${c} ─────────────────────────────────────────────────`);
        return checkMap[c](browser, cfg, paths, authSession);
      })
  );

  for (const result of checkResults) {
    if (result.status === "fulfilled") findings.push(...result.value);
    else console.log(`  ⚠ Check failed: ${result.reason?.message ?? result.reason}`);
  }

  // ── Persona scoring ────────────────────────────────────────────────────────
  let personaReport = null;
  if (args.personas && cfg.checks.length > 0) {
    console.log("\n── personas ────────────────────────────────────────────────");
    try {
      personaReport = await runPersonas(browser, cfg, paths);
      writeFileSync(paths.reportJson, JSON.stringify(personaReport, null, 2));
      console.log(`  report.json → ${paths.reportJson}`);
    } catch (err) {
      console.log(`  ⚠ Personas failed: ${err.message}`);
    }
  }

  await authSession?.save();
  await browser.close();

  // ── Compute score + write findings ────────────────────────────────────────
  const score  = computeScore(findings, cfg.scoring);
  const output = {
    generatedAt:  new Date().toISOString(),
    target:       cfg.baseUrl,
    appName:      cfg.appName,
    durationMs:   Date.now() - startMs,
    auditScore:   score,
    personaScore: personaReport?.overallScore ?? null,
    totalFindings: findings.filter((f) => f.source !== "manual-required").length,
    manualGaps:   findings.filter((f) => f.source === "manual-required").length,
    findings,
  };
  writeFileSync(paths.findings, JSON.stringify(output, null, 2));

  // ── HTML report ───────────────────────────────────────────────────────────
  await generateHtmlReport(output, personaReport, paths);
  console.log(`  report.html → ${paths.report}`);

  printSummary(findings, score, paths, personaReport?.overallScore ?? null);

  // ── Bedrock ───────────────────────────────────────────────────────────────
  if (args.bedrock) {
    console.log("── bedrock ─────────────────────────────────────────────────");
    try {
      const { runBedrock } = await import("../src/bedrock.mjs");
      await runBedrock(output, cfg, paths);
    } catch (err) {
      console.log(`  ⚠ Bedrock failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(`\nUXRay error: ${err.message}\n`);
  process.exit(1);
});
