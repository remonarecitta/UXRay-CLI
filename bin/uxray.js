#!/usr/bin/env node
/**
 * bin/uxray.js
 * UXRay CLI entry point
 *
 * Usage:
 *   npx uxray                         run full audit
 *   npx uxray init                    copy uxray.config.js template
 *   npx uxray --checks axe,keyboard   run specific checks only
 *   npx uxray --route /campaigns      audit one route
 *   npx uxray --viewport mobile       one viewport only
 *   npx uxray --no-personas           skip persona scoring
 *   npx uxray --bedrock               run AI fix suggestions after audit
 *   npx uxray --out .uxray            custom output directory
 *   npx uxray --help                  show help
 */

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { loadConfig, validateConfig, resolveOutputPaths } from "../src/config.js";
import { createAuthSession } from "../src/auth.js";
import { runAxeChecks } from "../src/checks/axe.js";
import { runKeyboardChecks } from "../src/checks/keyboard.js";
import { runScreenReaderChecks } from "../src/checks/screenReader.js";
import { runResponsiveChecks } from "../src/checks/responsive.js";
import { runErrorChecks } from "../src/checks/errors.js";
import { runWcagExtendedChecks } from "../src/checks/wcag-extended.js";
import { runPersonas } from "../src/personas/scorer.js";
import { generateHtmlReport } from "../src/report/html.js";
import { runLiveDemo } from "../src/live.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

// Normalise path separator for cross-platform compatibility
const normalisePath = (p) => p?.replace(/\\/g, "/") ?? p;

const CHECK_MODULES = {
  axe:          runAxeChecks,
  keyboard:     runKeyboardChecks,
  screenReader: runScreenReaderChecks,
  responsive:   runResponsiveChecks,
  errors:       runErrorChecks,
  wcagExtended: runWcagExtendedChecks,
};

function parseArguments(argv) {
  const args = {
    command:     null,
    checks:      null,
    route:       null,
    viewport:    null,
    runPersonas: true,
    runBedrock:  false,
    bedrockHtml: null,   // path to report.html for HTML-mode bedrock input
    runLive:     false,
    outputDir:   null,
    showHelp:    false,
    showVersion: false,
    dryRun:      false,
  };

  for (let i = 2; i < argv.length; i++) {
    const argument = argv[i];

    if (argument === "init") {
      args.command = "init";
    } else if (argument === "--help" || argument === "-h") {
      args.showHelp = true;
    } else if (argument === "--version" || argument === "-v") {
      args.showVersion = true;
    } else if (argument === "--dry-run") {
      args.dryRun = true;
    } else if (argument === "--no-personas") {
      args.runPersonas = false;
    } else if (argument === "--bedrock") {
      args.runBedrock = true;
    } else if (argument.startsWith("--bedrock=")) {
      // --bedrock=path/to/report.html  → HTML-mode: parse the HTML directly
      args.runBedrock  = true;
      args.bedrockHtml = argument.split("=").slice(1).join("=");
    } else if (argument === "--live") {
      args.runLive = true;
    } else if (argument === "--checks") {
      args.checks = argv[++i]?.split(",").map((check) => check.trim());
    } else if (argument === "--route") {
      args.route = argv[++i];
    } else if (argument === "--viewport") {
      args.viewport = argv[++i];
    } else if (argument === "--out") {
      args.outputDir = argv[++i];
    } else if (argument.startsWith("--checks=")) {
      args.checks = argument.split("=")[1].split(",").map((check) => check.trim());
    } else if (argument.startsWith("--route=")) {
      args.route = argument.split("=")[1];
    } else if (argument.startsWith("--viewport=")) {
      args.viewport = argument.split("=")[1];
    } else if (argument.startsWith("--out=")) {
      args.outputDir = argument.split("=")[1];
    }
  }

  return args;
}

function printHelp() {
  console.log(`
UXRay — WCAG 2.1 AA accessibility and responsiveness auditor

Usage:
  npx uxray [command] [options]

Commands:
  init                Copy uxray.config.js template to current directory

Options:
  --checks <list>     Comma-separated checks to run (default: all)
                      Available: axe, keyboard, screenReader, responsive, errors, wcagExtended
  --route <path>      Audit a single route only (e.g. --route /campaigns)
  --viewport <name>   Run on one viewport only: mobile, tablet, desktop, dark
  --no-personas       Skip persona health scoring
  --live              Open browser visibly, tab through pages, speak announcements
  --bedrock           Run AI fix suggestions after audit (requires AWS credentials)
  --out <dir>         Output directory (default: .uxray)
  --dry-run           Print what would run without executing checks
  --help, -h          Show this help message
  --version, -v       Show version number

Environment variables:
  BASE_URL              Override baseUrl from config
  UXRAY_USER            Login username (if auth is configured)
  UXRAY_PASS            Login password (if auth is configured)
  AWS_REGION            AWS region for Bedrock (default: us-east-1)
  AWS_ACCESS_KEY_ID     AWS credentials for Bedrock
  AWS_SECRET_ACCESS_KEY AWS credentials for Bedrock

Examples:
  npx uxray
  npx uxray --checks axe,keyboard
  npx uxray --route /campaigns --viewport mobile
  npx uxray --bedrock
  BASE_URL=http://staging.example.com npx uxray
`);
}

async function runInitCommand(workingDirectory) {
  const destinationPath = join(workingDirectory, "uxray.config.js");

  if (existsSync(destinationPath)) {
    console.log(`uxray.config.js already exists at ${destinationPath}`);
    console.log("Delete it first if you want a fresh template.");
    return;
  }

  const templatePath = join(currentDirectory, "../init/uxray.config.template.js");
  copyFileSync(templatePath, destinationPath);

  console.log(`\nCreated: ${destinationPath}`);
  console.log("\nNext steps:");
  console.log("  1. Edit uxray.config.js — set baseUrl and your routes");
  console.log("  2. If your app needs login, fill in the auth block");
  console.log("  3. Run: npx uxray\n");
}

function calculateAuditScore(findings, scoringWeights) {
  const automatedFindings = findings.filter(
    (finding) => finding.source !== "manual-required"
  );

  const uniqueFindings = [
    ...new Map(
      automatedFindings.map((f) => [`${f.title}|${f.source}`, f])
    ).values(),
  ];

  const deductions =
    uniqueFindings.filter((f) => f.severity === "critical").length * (scoringWeights.critical || 10) +
    uniqueFindings.filter((f) => f.severity === "major").length    * (scoringWeights.major    || 5)  +
    uniqueFindings.filter((f) => f.severity === "minor").length    * (scoringWeights.minor    || 2);

  return Math.max(0, 100 - deductions);
}

function printSummary(findings, auditScore, outputPaths, personaScore) {
  const automatedFindings = findings.filter((f) => f.source !== "manual-required");
  const manualFindings    = findings.filter((f) => f.source === "manual-required");

  console.log(`\n${"═".repeat(56)}`);
  console.log("  UXRAY SUMMARY");
  console.log(`${"═".repeat(56)}`);
  console.log(`  Audit score:    ${auditScore} / 100`);

  if (personaScore != null) {
    console.log(`  Persona score:  ${personaScore} / 100`);
  }

  console.log(`  Findings:       ${automatedFindings.length} automated · ${manualFindings.length} manual gaps`);
  console.log(`    critical:     ${automatedFindings.filter((f) => f.severity === "critical").length}`);
  console.log(`    major:        ${automatedFindings.filter((f) => f.severity === "major").length}`);
  console.log(`    minor:        ${automatedFindings.filter((f) => f.severity === "minor").length}`);
  console.log(`\n  Report: ${outputPaths.report}`);
  console.log(`${"═".repeat(56)}\n`);
}

async function main() {
  const args = parseArguments(process.argv);
  const workingDirectory = process.cwd();

  if (args.showHelp) {
    printHelp();
    return;
  }

  if (args.showVersion) {
    const { createRequire } = await import("module");
    const requireFile = createRequire(import.meta.url);
    console.log(requireFile("../package.json").version);
    return;
  }

  if (args.command === "init") {
    await runInitCommand(workingDirectory);
    return;
  }

  const config = await loadConfig(workingDirectory);
  validateConfig(config);

  if (args.outputDir) config.output.dir = args.outputDir;
  if (args.checks)    config.checks = args.checks;
  if (args.route)     config.routes = config.routes.filter((route) => route.path === args.route);

  if (args.viewport) {
    const requestedViewport = config.viewports[args.viewport];
    if (!requestedViewport) {
      console.error(
        `Unknown viewport "${args.viewport}". ` +
        `Available: ${Object.keys(config.viewports).join(", ")}`
      );
      process.exit(1);
    }
    config.viewports = { [args.viewport]: requestedViewport };
  }

  const outputPaths = resolveOutputPaths(config, workingDirectory);
  mkdirSync(outputPaths.dir, { recursive: true });
  mkdirSync(outputPaths.screenshots, { recursive: true });

  console.log(`\nUXRay — auditing ${config.baseUrl}`);

  if (args.dryRun) {
    console.log("Dry run — no checks executed.\n");
    return;
  }

  // Always run headless for the full audit — live mode adds a visual replay after
  const browser = await chromium.launch({ headless: true });
  const auditStartTime = Date.now();
  const allFindings = [];

  const routesRequireAuth = config.routes.some((route) => route.requiresAuth);
  let authSession = null;

  if (routesRequireAuth && config.auth) {
    try {
      authSession = await createAuthSession(browser, config);
    } catch (error) {
      console.error(`\nAuth error: ${error.message}\n`);
      await browser.close();
      process.exit(1);
    }
  }

  const checksToRun = config.checks.filter((checkName) => CHECK_MODULES[checkName]);

  const checkResults = await Promise.allSettled(
    checksToRun.map((checkName) => {
      console.log(`\n── ${checkName} ${"─".repeat(46 - checkName.length)}`);
      return CHECK_MODULES[checkName](browser, config, outputPaths, authSession);
    })
  );

  for (const result of checkResults) {
    if (result.status === "fulfilled") {
      allFindings.push(...result.value);
    } else {
      console.log(`  ⚠ Check failed: ${result.reason?.message || result.reason}`);
    }
  }

  let personaReport = null;

  if (args.runPersonas && config.checks.length > 0) {
    console.log(`\n── personas ${"─".repeat(45)}`);
    try {
      personaReport = await runPersonas(browser, config, outputPaths);
      writeFileSync(outputPaths.reportJson, JSON.stringify(personaReport, null, 2));
    } catch (error) {
      console.log(`  ⚠ Personas failed: ${error.message}`);
    }
  }

  await authSession?.save();
  await browser.close();

  const auditScore = calculateAuditScore(allFindings, config.scoring);

  const auditOutput = {
    generatedAt:   new Date().toISOString(),
    target:        config.baseUrl,
    appName:       config.appName,
    durationMs:    Date.now() - auditStartTime,
    auditScore,
    personaScore:  personaReport?.overallScore || null,
    totalFindings: allFindings.filter((f) => f.source !== "manual-required").length,
    manualGaps:    allFindings.filter((f) => f.source === "manual-required").length,
    findings:      allFindings,
  };

  writeFileSync(outputPaths.findings, JSON.stringify(auditOutput, null, 2));

  await generateHtmlReport(auditOutput, personaReport, outputPaths);

  printSummary(allFindings, auditScore, outputPaths, personaReport?.overallScore || null);

  if (args.runBedrock) {
    console.log(`── bedrock ${"─".repeat(46)}`);
    try {
      const { runBedrock } = await import("../src/bedrock.js");
      // If --bedrock=report.html was passed, parse the HTML directly.
      // Otherwise fall back to the in-memory audit JSON output.
      const bedrockInput = args.bedrockHtml ?? auditOutput;
      const bedrockSuggestions = await runBedrock(bedrockInput, config, outputPaths);

      if (bedrockSuggestions?.suggestions?.length) {
        const fixMap = new Map(
          bedrockSuggestions.suggestions.map((suggestion) => [suggestion.findingId, suggestion.fix])
        );

        const enrichedFindings = auditOutput.findings.map((finding) => ({
          ...finding,
          fix: fixMap.get(finding.id) || null,
        }));

        const enrichedOutput = { ...auditOutput, findings: enrichedFindings };
        writeFileSync(outputPaths.findings, JSON.stringify(enrichedOutput, null, 2));
        await generateHtmlReport(enrichedOutput, personaReport, outputPaths);
        console.log(`  Report updated with AI fixes → ${outputPaths.report}`);
      }
    } catch (error) {
      console.log(`  ⚠ Bedrock failed: ${error.message}`);
    }
  }

  if (args.runLive) {
    console.log(`\n── live demo ${"─".repeat(43)}`);
    console.log("  Opening browser to replay findings visually...\n");
    try {
      const liveBrowser = await chromium.launch({ headless: false });
      await runLiveDemo(liveBrowser, config, outputPaths);
      await liveBrowser.close();
    } catch (error) {
      console.log(`  ⚠ Live demo failed: ${error.message}`);
    }

    console.log(`\n${"═".repeat(56)}`);
    console.log(`  Report: ${outputPaths.report}`);
    console.log(`${"═".repeat(56)}\n`);
  }
}

main().catch((error) => {
  console.error(`\nUXRay error: ${error.message}\n`);
  process.exit(1);
});
