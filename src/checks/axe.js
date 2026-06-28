import AxeBuilder from "@axe-core/playwright";

const SEVERITY_MAP = {
  critical: "critical",
  serious: "critical",
  moderate: "major",
  minor: "minor",
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

function createFinding(violation, route, id) {
  return {
    id: `axe-${id}`,
    route: route.path,
    source: "axe",
    severity: SEVERITY_MAP[violation.impact] || "minor",
    wcag: getWcagTags(violation),
    title: violation.description,
    description: `[${violation.id}] ${violation.help} — ${violation.nodes.length} node(s). ${violation.helpUrl}`,
  };
}

export async function runAxeChecks(browser, config) {
  const findings = [];

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  const baseUrl = process.env.BASE_URL || config.baseUrl;

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   axe  ${route.name.padEnd(16)}`);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

      if (route.waitFor) {
        await page.locator(route.waitFor)
          .waitFor({ state: "visible", timeout: 5000 })
          .catch(() => {});
      }

      await page.waitForTimeout(400);

      const { violations } = await new AxeBuilder({ page }).analyze();

      for (const violation of violations) {
        findings.push(createFinding(violation, route, findings.length + 1));
      }

      console.log(`→ ${violations.length} violation(s)`);
    } catch (error) {
      console.log(`→ ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  await context.close();
  return findings;
}
