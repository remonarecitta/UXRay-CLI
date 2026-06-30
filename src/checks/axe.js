import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "fs";
import { join } from "path";
import { createAuthenticatedContext, navigateAuthenticated } from "../context.js";

const SEVERITY_MAP = {
  critical: "critical",
  serious:  "critical",
  moderate: "major",
  minor:    "minor",
};

function getWcagTags(violation) {
  const tags = (violation.tags || []).filter((tag) => tag.startsWith("wcag"));

  if (!tags.length) {
    return ["WCAG (unknown)"];
  }

  return tags.map((tag) =>
    `WCAG ${tag.replace("wcag", "").replace(/(\d)(\d+)/, "$1.$2")}`
  );
}

async function takeScreenshot(page, screenshotsDir, name) {
  try {
    const filePath = join(screenshotsDir, `axe-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

async function highlightViolatingElement(page, selector) {
  try {
    await page.evaluate((sel) => {
      const element = document.querySelector(sel);
      if (!element) return;
      element.style.outline = "3px solid #E24B4A";
      element.style.outlineOffset = "2px";
      element.scrollIntoView({ behavior: "instant", block: "center" });
    }, selector);
    await page.waitForTimeout(200);
  } catch {
    // Element may not be queryable — skip highlight
  }
}

async function removeHighlights(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll("[style*='outline']").forEach((element) => {
        element.style.outline = "";
        element.style.outlineOffset = "";
      });
    });
  } catch {
    // ignore
  }
}

function createFinding(violation, route, id, screenshotPath) {
  return {
    id:          `axe-${id}`,
    route:       route.path,
    source:      "axe",
    severity:    SEVERITY_MAP[violation.impact] || "minor",
    wcag:        getWcagTags(violation),
    title:       violation.description,
    description: `[${violation.id}] ${violation.help} — ${violation.nodes.length} node(s). ${violation.helpUrl}`,
    screenshot:  screenshotPath,
  };
}

export async function runAxeChecks(browser, config, paths, authSession = null, authStorage = null) {
  const findings = [];

  mkdirSync(paths.screenshots, { recursive: true });

  const context = await createAuthenticatedContext(browser, config);

  const page    = await context.newPage();
  const baseUrl = process.env.BASE_URL || config.baseUrl;

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   axe  ${route.name.padEnd(16)}`);

    try {
      await navigateAuthenticated(page, url, config, route.waitFor);

      const { violations } = await new AxeBuilder({ page }).analyze();

      for (const violation of violations) {
        const findingId     = findings.length + 1;
        const firstSelector = violation.nodes[0]?.target?.[0];

        // Highlight the violating element and take a screenshot
        if (firstSelector) {
          await highlightViolatingElement(page, firstSelector);
        }

        const screenshotName = `${violation.id}-${route.path.replace(/\//g, "-")}`;
        const screenshotPath = await takeScreenshot(page, paths.screenshots, screenshotName);

        await removeHighlights(page);

        findings.push(createFinding(violation, route, findingId, screenshotPath));
      }

      console.log(`→ ${violations.length} violation(s)`);
    } catch (error) {
      console.log(`→ ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  await context.close();
  return findings;
}
