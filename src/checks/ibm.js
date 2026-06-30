import { join } from "path";
import { mkdirSync } from "fs";
import { createAuthenticatedContext, navigateAuthenticated } from "../context.js";

/**
 * IBM Equal Access Accessibility Checker integration.
 *
 * Requires: npm install @ibm/equal-access-accessibility-checker
 * If the package is not installed, this check is skipped with a warning.
 *
 * The checker runs against the fully-rendered HTML of each authenticated
 * Playwright page, catching violations that axe-core does not cover
 * (IBM-specific rules, Carbon Design System patterns, additional WCAG mapping).
 */

const IBM_SEVERITY = {
  VIOLATION:         "critical",
  POTENTIALVIOLATION: "major",
  RECOMMENDATION:    "minor",
};

async function loadIBMChecker() {
  try {
    return await import("@ibm/equal-access-accessibility-checker");
  } catch {
    return null;
  }
}

async function takeScreenshot(page, screenshotsDir, name) {
  try {
    const filePath = join(screenshotsDir, `ibm-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

export async function runIBMChecks(browser, config, paths) {
  const checker = await loadIBMChecker();

  if (!checker) {
    console.log(
      "  ⚠ @ibm/equal-access-accessibility-checker not installed — skipping.\n" +
      "    To enable: npm install @ibm/equal-access-accessibility-checker"
    );
    return [];
  }

  const findings = [];
  const baseUrl  = process.env.BASE_URL || config.baseUrl;

  mkdirSync(paths.screenshots, { recursive: true });

  // IBM checker configuration
  await checker.configure({
    policies:      ["IBM_Accessibility"],
    reportLevels:  ["violation", "potentialviolation", "recommendation"],
    failLevels:    ["violation", "potentialviolation"],
  });

  const context = await createAuthenticatedContext(browser, config);
  const page    = await context.newPage();

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   ibm  ${route.name.padEnd(16)}`);

    let issueCount = 0;

    try {
      await navigateAuthenticated(page, url, config, route.waitFor);

      // Get the fully-rendered HTML (post-JS) for the IBM checker
      const html = await page.content();

      const { report } = await checker.getCompliance(html, `uxray-ibm-${route.path}`);

      // Deduplicate by ruleId+message so repeated identical DOM patterns
      // don't produce dozens of identical findings
      const seen = new Set();

      for (const result of report.results ?? []) {
        const [level] = result.value ?? [];
        const severity = IBM_SEVERITY[level];
        if (!severity) continue; // skip PASS, INFORMATION, MANUAL

        const dedupeKey = `${result.ruleId}::${result.message}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const wcagRefs = (result.standards ?? [])
          .filter((s) => s.num)
          .map((s) => `WCAG ${s.num}`);

        const screenshotPath =
          severity === "critical" && !findings.some((f) => f.route === route.path && f.source === "ibm")
            ? await takeScreenshot(page, paths.screenshots, `${route.path.replace(/\//g, "-")}-${findings.length + 1}`)
            : null;

        findings.push({
          id:          `ibm-${route.path.replace(/\//g, "-")}-${result.ruleId}-${findings.length + 1}`,
          route:       route.path,
          source:      "ibm",
          severity,
          wcag:        wcagRefs.length ? wcagRefs : ["IBM Accessibility"],
          title:       `[IBM] ${result.ruleId}`,
          description: `${result.message}${result.snippet ? `\n  Element: ${result.snippet.slice(0, 120)}` : ""}`,
          screenshot:  screenshotPath,
        });

        issueCount++;
      }

      console.log(`→ ${issueCount} issue(s)`);
    } catch (error) {
      console.log(`→ ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  await context.close();
  return findings;
}
