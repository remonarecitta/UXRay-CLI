import { mkdirSync } from "fs";
import { join } from "path";

const MINIMUM_FOCUS_OUTLINE_WIDTH = 0;

async function navigateToPage(page, url, route) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

  if (route.waitFor) {
    await page.locator(route.waitFor)
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
  }

  await page.waitForTimeout(400);
}

async function takeScreenshot(page, screenshotDir, name) {
  try {
    const filePath = join(screenshotDir, `kb-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

async function checkSkipNavigation(page, route, screenshotDir, findingId) {
  await page.keyboard.press("Tab");

  const firstFocusedElement = await page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName?.toLowerCase(),
      href: element?.getAttribute("href") || "",
      text: (element?.textContent || "").trim().slice(0, 40),
    };
  });

  const isSkipLink =
    firstFocusedElement.href?.startsWith("#") &&
    /skip|main|content/i.test(firstFocusedElement.text);

  if (!isSkipLink) {
    const screenshotPath = await takeScreenshot(
      page,
      screenshotDir,
      `skip-nav-${route.path.replace(/\//g, "-")}`
    );

    return {
      id: `kb-skip-${findingId}`,
      route: route.path,
      source: "keyboard",
      severity: "major",
      wcag: ["WCAG 2.4.1"],
      title: "No skip navigation link",
      description:
        `First focusable element is <${firstFocusedElement.tag}> "${firstFocusedElement.text}" — ` +
        `not a skip link. Keyboard users must tab through nav on every page.`,
      screenshot: screenshotPath,
    };
  }

  return null;
}

async function checkFocusVisible(page, route, screenshotDir, findingId, maximumTabs) {
  const elementsWithoutFocus = [];
  const visitedElements = new Set();

  for (let tabIndex = 0; tabIndex < Math.min(maximumTabs, 40); tabIndex++) {
    await page.keyboard.press("Tab");

    const focusedElement = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;

      const styles = window.getComputedStyle(active);

      return {
        tag: active.tagName.toLowerCase(),
        testId: active.getAttribute("data-testid") || "",
        text: (active.getAttribute("aria-label") || active.textContent || "").trim().slice(0, 30),
        outlineWidth: parseFloat(styles.outlineWidth),
        hasBoxShadow: styles.boxShadow !== "none",
      };
    });

    if (!focusedElement) break;

    const elementKey = `${focusedElement.tag}|${focusedElement.testId}|${focusedElement.text}`;
    if (visitedElements.has(elementKey)) break;
    visitedElements.add(elementKey);

    const hasFocusIndicator =
      focusedElement.outlineWidth > MINIMUM_FOCUS_OUTLINE_WIDTH ||
      focusedElement.hasBoxShadow;

    if (!hasFocusIndicator) {
      elementsWithoutFocus.push(focusedElement);
    }
  }

  if (elementsWithoutFocus.length > 0) {
    const first = elementsWithoutFocus[0];
    const screenshotPath = await takeScreenshot(
      page,
      screenshotDir,
      `focus-visible-${route.path.replace(/\//g, "-")}`
    );

    return {
      id: `kb-focus-${findingId}`,
      route: route.path,
      source: "keyboard",
      severity: "major",
      wcag: ["WCAG 2.4.7"],
      title: "Focus indicator not visible",
      description:
        `${elementsWithoutFocus.length} interactive element(s) have no visible focus ring. ` +
        `e.g. <${first.tag}> "${first.text}"`,
      screenshot: screenshotPath,
    };
  }

  return null;
}

async function checkKeyboardTrap(page, route, screenshotDir, findingId, maximumTabs) {
  const visitCounts = new Map();
  let trappedElement = null;

  for (let tabIndex = 0; tabIndex < maximumTabs; tabIndex++) {
    await page.keyboard.press("Tab");

    const focusedElement = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      return {
        tag: active.tagName.toLowerCase(),
        id: active.id,
        testId: active.getAttribute("data-testid") || "",
        text: (active.textContent || "").trim().slice(0, 30),
      };
    });

    if (!focusedElement) break;

    const elementKey = `${focusedElement.tag}|${focusedElement.id}|${focusedElement.testId}`;
    const visitCount = (visitCounts.get(elementKey) || 0) + 1;
    visitCounts.set(elementKey, visitCount);

    if (visitCount >= 5) {
      trappedElement = focusedElement;
      break;
    }
  }

  if (trappedElement) {
    const screenshotPath = await takeScreenshot(
      page,
      screenshotDir,
      `trap-${route.path.replace(/\//g, "-")}`
    );

    return {
      id: `kb-trap-${findingId}`,
      route: route.path,
      source: "keyboard",
      severity: "critical",
      wcag: ["WCAG 2.1.2"],
      title: "Keyboard trap detected",
      description:
        `Focus cycled to <${trappedElement.tag}> "${trappedElement.text}" 5+ times — ` +
        `keyboard users cannot exit this element.`,
      screenshot: screenshotPath,
    };
  }

  return null;
}

async function checkModalEscape(page, route, screenshotDir, findingId) {
  const findings = [];

  const modalTriggers = await page.evaluate(() => {
    const triggers = [];

    document.querySelectorAll("button, [role='button']").forEach((element) => {
      const text = (
        element.textContent ||
        element.getAttribute("aria-label") ||
        ""
      ).trim().toLowerCase();

      const isModalTrigger =
        /cancel|modal|dialog|confirm|open/i.test(text) ||
        element.getAttribute("aria-haspopup") === "dialog";

      if (isModalTrigger) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0) {
          triggers.push({
            text: element.textContent.trim().slice(0, 30),
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          });
        }
      }
    });

    return triggers.slice(0, 2);
  });

  for (const trigger of modalTriggers) {
    await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      if (element) element.click();
    }, trigger);

    await page.waitForTimeout(600);

    const isDialogOpen = await page.evaluate(() => {
      const dialog = document.querySelector("[role='dialog'], dialog");
      return dialog ? dialog.offsetHeight > 0 : false;
    });

    if (!isDialogOpen) continue;

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    const isStillOpen = await page.evaluate(() => {
      const dialog = document.querySelector("[role='dialog'], dialog");
      return dialog ? dialog.offsetHeight > 0 : false;
    });

    if (isStillOpen) {
      const screenshotPath = await takeScreenshot(
        page,
        screenshotDir,
        `modal-escape-${route.path.replace(/\//g, "-")}`
      );

      findings.push({
        id: `kb-modal-${findingId + findings.length}`,
        route: route.path,
        source: "keyboard",
        severity: "critical",
        wcag: ["WCAG 2.1.2"],
        title: "Modal not dismissible with Escape",
        description: `Dialog triggered by "${trigger.text}" does not close on Escape — keyboard trap.`,
        screenshot: screenshotPath,
      });

      await page.evaluate(() => {
        document.querySelector("[role='dialog'] button")?.click();
      });
      await page.waitForTimeout(300);
    }

    const focusReturnedToTrigger = await page.evaluate(() => {
      const dialog = document.querySelector("[role='dialog'], dialog");
      return !(dialog?.contains(document.activeElement));
    });

    if (!focusReturnedToTrigger) {
      findings.push({
        id: `kb-focus-return-${findingId + findings.length}`,
        route: route.path,
        source: "keyboard",
        severity: "major",
        wcag: ["WCAG 2.1.2", "WCAG 2.4.3"],
        title: "Focus not returned after modal closes",
        description: `After closing dialog from "${trigger.text}", focus did not return to the trigger.`,
      });
    }
  }

  return findings;
}

export async function runKeyboardChecks(browser, config, paths) {
  const findings = [];
  const baseUrl = process.env.BASE_URL || config.baseUrl;
  const maximumTabs = config.thresholds?.maxTabs || 60;

  mkdirSync(paths.screenshots, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  const cdpSession = await context.newCDPSession(page);
  await cdpSession
    .send("Emulation.setEmitTouchEventsForMouse", { enabled: false })
    .catch(() => {});

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   kb   ${route.name.padEnd(16)}`);

    let issueCount = 0;

    try {
      await navigateToPage(page, url, route);
      const skipNavFinding = await checkSkipNavigation(
        page, route, paths.screenshots, findings.length + 1
      );
      if (skipNavFinding) {
        findings.push(skipNavFinding);
        issueCount++;
      }

      await navigateToPage(page, url, route);
      const focusFinding = await checkFocusVisible(
        page, route, paths.screenshots, findings.length + 1, maximumTabs
      );
      if (focusFinding) {
        findings.push(focusFinding);
        issueCount++;
      }

      await navigateToPage(page, url, route);
      const trapFinding = await checkKeyboardTrap(
        page, route, paths.screenshots, findings.length + 1, maximumTabs
      );
      if (trapFinding) {
        findings.push(trapFinding);
        issueCount++;
      }

      await navigateToPage(page, url, route);
      const modalFindings = await checkModalEscape(
        page, route, paths.screenshots, findings.length + 1
      );
      findings.push(...modalFindings);
      issueCount += modalFindings.length;

      console.log(`→ ${issueCount} issue(s)`);
    } catch (error) {
      console.log(`→ ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  await cdpSession.detach().catch(() => {});
  await context.close();

  return findings;
}
