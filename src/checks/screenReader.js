import { join } from "path";
import { mkdirSync } from "fs";

const GET_A11Y_TREE = () => {
  function getAccessibleName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (names.length) return { name: names.join(" "), source: "aria-labelledby" };
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel?.trim()) return { name: ariaLabel.trim(), source: "aria-label" };

    if (element.id) {
      const labelElement = document.querySelector(`label[for="${element.id}"]`);
      if (labelElement) return { name: labelElement.textContent.trim(), source: "label[for]" };
    }

    const wrappingLabel = element.closest("label");
    if (wrappingLabel) {
      const clone = wrappingLabel.cloneNode(true);
      clone.querySelectorAll("input, select, textarea").forEach((el) => el.remove());
      const text = clone.textContent.trim();
      if (text) return { name: text, source: "label[wrap]" };
    }

    const title = element.getAttribute("title");
    if (title?.trim()) return { name: title.trim(), source: "title" };

    const placeholder = element.getAttribute("placeholder");
    if (placeholder?.trim()) return { name: placeholder.trim(), source: "placeholder" };

    const innerText = element.textContent?.trim();
    if (innerText) return { name: innerText.slice(0, 80), source: "inner-text" };

    return { name: "", source: "none" };
  }

  function getRole(element) {
    const explicitRole = element.getAttribute("role");
    if (explicitRole) return explicitRole;

    const tag = element.tagName.toLowerCase();
    const inputType = element.getAttribute("type")?.toLowerCase();

    const roleMap = {
      a:        "link",
      button:   "button",
      h1:       "heading",
      h2:       "heading",
      h3:       "heading",
      h4:       "heading",
      h5:       "heading",
      h6:       "heading",
      input:    inputType === "checkbox" ? "checkbox"
              : inputType === "radio"    ? "radio"
              : inputType === "submit"   ? "button"
              : "textbox",
      select:   "combobox",
      textarea: "textbox",
      img:      "img",
      nav:      "navigation",
      main:     "main",
      dialog:   "dialog",
    };

    return roleMap[tag] || tag;
  }

  const INTERACTIVE_ROLES = [
    "textbox", "combobox", "button", "link", "checkbox",
    "radio", "slider", "menuitem", "tab",
  ];

  const selector =
    "a[href], button, input, select, textarea, [role], " +
    "h1, h2, h3, h4, h5, h6, img, [aria-label], [aria-labelledby], [tabindex]";

  const seen = new Set();
  const tree = [];

  document.querySelectorAll(selector).forEach((element) => {
    if (seen.has(element)) return;
    seen.add(element);

    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const { name, source } = getAccessibleName(element);
    const role = getRole(element);
    const isWeakName = source === "placeholder" || source === "none";
    const isInteractive = INTERACTIVE_ROLES.includes(role);

    let violation = null;
    if (!name && isInteractive) {
      violation = `${role} has no accessible name`;
    } else if (isWeakName && ["textbox", "combobox"].includes(role)) {
      violation = `${role} name from ${source} — axe passes but screen reader users hear placeholder only`;
    }

    const headingLevel = element.tagName.match(/H(\d)/)?.[1];

    tree.push({
      tag:         element.tagName.toLowerCase(),
      id:          element.id || "",
      testId:      element.getAttribute("data-testid") || "",
      role,
      name,
      source,
      isWeakName,
      isInteractive,
      violation,
      level:       headingLevel ? parseInt(headingLevel) : null,
      altText:     element.getAttribute("alt"),
      href:        element.getAttribute("href") || "",
    });
  });

  return tree;
};

async function takeScreenshot(page, paths, name) {
  try {
    const filePath = join(paths.screenshots, `sr-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

export async function runScreenReaderChecks(browser, config, paths) {
  const findings = [];
  const baseUrl = process.env.BASE_URL || config.baseUrl;

  mkdirSync(paths.screenshots, { recursive: true });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   sr   ${route.name.padEnd(16)}`);

    let issueCount = 0;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

      if (route.waitFor) {
        await page.locator(route.waitFor)
          .waitFor({ state: "visible", timeout: 5000 })
          .catch(() => {});
      }

      await page.waitForTimeout(400);

      const accessibilityTree = await page.evaluate(GET_A11Y_TREE);

      const unnamedElements = [
        ...new Map(
          accessibilityTree
            .filter((node) => node.violation && node.isInteractive)
            .map((node) => [`${node.role}|${node.testId}`, node])
        ).values(),
      ];

      for (const node of unnamedElements.slice(0, 5)) {
        const screenshotPath = await takeScreenshot(
          page,
          paths,
          `unnamed-${node.testId || node.tag}-${route.path.replace(/\//g, "-")}`
        );

        findings.push({
          id:          `sr-name-${findings.length + 1}`,
          route:       route.path,
          source:      "screenReader",
          severity:    node.source === "none" ? "critical" : "major",
          wcag:        ["WCAG 4.1.2", "WCAG 1.3.1"],
          title:       `${node.role} has no accessible name`,
          description: node.violation,
          screenshot:  screenshotPath,
        });

        issueCount++;
      }

      if (unnamedElements.length > 5) {
        findings.push({
          id:          `sr-bulk-${findings.length + 1}`,
          route:       route.path,
          source:      "screenReader",
          severity:    "critical",
          wcag:        ["WCAG 4.1.2"],
          title:       `${unnamedElements.length - 5} more unnamed interactive elements`,
          description: `Total ${unnamedElements.length} elements with no accessible name.`,
        });

        issueCount++;
      }

      const headings = accessibilityTree.filter((node) => node.role === "heading" && node.level);

      for (let i = 1; i < headings.length; i++) {
        if (headings[i].level - headings[i - 1].level > 1) {
          const screenshotPath = await takeScreenshot(
            page,
            paths,
            `headings-${route.path.replace(/\//g, "-")}`
          );

          findings.push({
            id:          `sr-heading-${findings.length + 1}`,
            route:       route.path,
            source:      "screenReader",
            severity:    "minor",
            wcag:        ["WCAG 1.3.1"],
            title:       "Heading order skips a level",
            description:
              `H${headings[i - 1].level} "${headings[i - 1].name.slice(0, 30)}" → ` +
              `H${headings[i].level} "${headings[i].name.slice(0, 30)}"`,
            screenshot:  screenshotPath,
          });

          issueCount++;
          break;
        }
      }

      const images = accessibilityTree.filter((node) => node.role === "img");

      for (const image of images) {
        if (image.altText === null || image.altText === undefined) {
          const screenshotPath = await takeScreenshot(
            page,
            paths,
            `img-${route.path.replace(/\//g, "-")}`
          );

          findings.push({
            id:          `sr-img-${findings.length + 1}`,
            route:       route.path,
            source:      "screenReader",
            severity:    "critical",
            wcag:        ["WCAG 1.1.1"],
            title:       "Image has no alt attribute",
            description: `<img${image.id ? "#" + image.id : ""}> missing alt — SR announces "image" with no context.`,
            screenshot:  screenshotPath,
          });

          issueCount++;
        }
      }

      const VAGUE_LINK_TEXTS = ["click here", "here", "read more", "learn more", "more", "link", "this", "go"];
      const links = accessibilityTree.filter((node) => node.role === "link");

      for (const link of links) {
        if (VAGUE_LINK_TEXTS.includes(link.name.toLowerCase().trim())) {
          findings.push({
            id:          `sr-link-${findings.length + 1}`,
            route:       route.path,
            source:      "screenReader",
            severity:    "minor",
            wcag:        ["WCAG 2.4.4"],
            title:       `Vague link text: "${link.name}"`,
            description: `"${link.name}" gives no context. Screen reader users browsing by links cannot tell where this goes.`,
          });

          issueCount++;
        }
      }

      console.log(`→ ${issueCount} issue(s)`);
    } catch (error) {
      console.log(`→ ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  await context.close();
  return findings;
}