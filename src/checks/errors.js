import { join } from "path";
import { mkdirSync } from "fs";

async function takeScreenshot(page, paths, name) {
  try {
    const filePath = join(paths.screenshots, `err-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

export async function runErrorChecks(browser, config, paths) {
  const findings = [];
  const baseUrl = process.env.BASE_URL || config.baseUrl;

  mkdirSync(paths.screenshots, { recursive: true });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   err  ${route.name.padEnd(16)}`);

    let issueCount = 0;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

      if (route.waitFor) {
        await page.locator(route.waitFor)
          .waitFor({ state: "visible", timeout: 5000 })
          .catch(() => {});
      }

      await page.waitForTimeout(400);

      const pageHasForm = await page.evaluate(() => !!document.querySelector("form"));

      if (!pageHasForm) {
        console.log("→ no form");
        continue;
      }

      const unlabeledFields = await page.evaluate(() => {
        const issues = [];

        document.querySelectorAll("input[required], select[required], textarea[required]").forEach((element) => {
          const hasLabel =
            !!document.querySelector(`label[for="${element.id}"]`) ||
            !!element.getAttribute("aria-label") ||
            !!element.getAttribute("aria-labelledby") ||
            !!element.closest("label");

          if (!hasLabel) {
            issues.push({
              element: `${element.tagName.toLowerCase()}${element.id ? "#" + element.id : ""}`,
              type: element.getAttribute("type") || element.tagName.toLowerCase(),
              placeholder: element.getAttribute("placeholder") || "",
            });
          }
        });

        return issues;
      });

      for (const field of unlabeledFields) {
        const screenshotPath = await takeScreenshot(
          page,
          paths,
          `unlabeled-${route.path.replace(/\//g, "-")}`
        );

        findings.push({
          id: `err-label-${findings.length + 1}`,
          route: route.path,
          source: "errors",
          severity: "critical",
          wcag: ["WCAG 3.3.2", "WCAG 1.3.1", "WCAG 4.1.2"],
          title: "Required field has no label",
          description:
            `<${field.element}> type="${field.type}" is required but has no label. ` +
            `Placeholder "${field.placeholder}" is not a substitute.`,
          screenshot: screenshotPath,
        });

        issueCount++;
      }

      const urlBeforeSubmit = page.url();

      await page.evaluate(() => {
        const form = document.querySelector("form");
        const submitButton = form?.querySelector("button[type='submit'], input[type='submit']");
        if (submitButton) submitButton.click();
      });

      await page.waitForTimeout(1000);

      const navigatedAway = page.url() !== urlBeforeSubmit;
      if (navigatedAway) {
        console.log(`→ ${issueCount} issue(s)`);
        continue;
      }

      const errorState = await page.evaluate(() => {
        const errorElements = document.querySelectorAll(
          "[role='alert'], [aria-live='assertive'], [aria-live='polite'], " +
          ".error, [class*='error'], [class*='invalid']"
        );
        const requiredFields = document.querySelectorAll(
          "input[required], select[required], textarea[required]"
        );

        const unassociatedErrors = [];
        errorElements.forEach((element) => {
          if (!element.id) return;
          const isLinkedToInput = !!document.querySelector(`[aria-describedby~="${element.id}"]`);
          if (!isLinkedToInput) {
            unassociatedErrors.push(element.textContent.trim().slice(0, 60));
          }
        });

        return {
          errorCount:         errorElements.length,
          requiredFieldCount: requiredFields.length,
          unassociatedErrors,
          noErrorsShown:      errorElements.length === 0 && requiredFields.length > 0,
        };
      });

      if (errorState.noErrorsShown) {
        const screenshotPath = await takeScreenshot(
          page,
          paths,
          `no-errors-${route.path.replace(/\//g, "-")}`
        );

        findings.push({
          id: `err-no-msg-${findings.length + 1}`,
          route: route.path,
          source: "errors",
          severity: "major",
          wcag: ["WCAG 3.3.1"],
          title: "Form shows no error messages on empty submit",
          description:
            `Form has ${errorState.requiredFieldCount} required field(s) but no error ` +
            `appeared after submitting empty.`,
          screenshot: screenshotPath,
        });

        issueCount++;
      }

      for (const errorMessage of errorState.unassociatedErrors) {
        findings.push({
          id: `err-assoc-${findings.length + 1}`,
          route: route.path,
          source: "errors",
          severity: "minor",
          wcag: ["WCAG 3.3.1"],
          title: "Error message not associated with input",
          description: `Error "${errorMessage}" not referenced by any input's aria-describedby.`,
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