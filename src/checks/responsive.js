import { join } from "path";
import { mkdirSync } from "fs";
import { createAuthenticatedContext, navigateAuthenticated } from "../context.js";

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
    const filePath = join(screenshotDir, `resp-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

const CONTRAST_CHECK_SCRIPT = (minimumRatio) => {
  const toLinear = (channel) => {
    const normalised = channel / 255;
    return normalised <= 0.03928
      ? normalised / 12.92
      : Math.pow((normalised + 0.055) / 1.055, 2.4);
  };

  const getLuminance = (red, green, blue) =>
    0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);

  const parseColor = (colorString) =>
    (colorString.match(/\d+/g) || []).map(Number);

  const getContrastRatio = (foreground, background) => {
    const [r1, g1, b1] = parseColor(foreground);
    const [r2, g2, b2] = parseColor(background);
    const lum1 = getLuminance(r1, g1, b1);
    const lum2 = getLuminance(r2, g2, b2);
    return (Math.max(lum1, lum2) + 0.05) / (Math.min(lum1, lum2) + 0.05);
  };

  const failures = [];
  const textSelectors = "p,span,h1,h2,h3,h4,h5,h6,li,td,th,label,a,button";

  document.querySelectorAll(textSelectors).forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const styles = window.getComputedStyle(element);
    if (!styles.backgroundColor || styles.backgroundColor === "rgba(0, 0, 0, 0)") return;

    const ratio = getContrastRatio(styles.color, styles.backgroundColor);

    if (ratio < minimumRatio) {
      failures.push({
        element: `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 30)}"`,
        foreground: styles.color,
        background: styles.backgroundColor,
        ratio: Math.round(ratio * 100) / 100,
      });
    }
  });

  return failures.slice(0, 20);
};

async function checkOverflow(page, viewportWidth, route, screenshotDir, findingCount) {
  const findings = [];

  const overflowIssues = await page.evaluate((width) => {
    const issues = [];

    if (document.body.scrollWidth > width) {
      issues.push({
        element: "body",
        scrollWidth: document.body.scrollWidth,
        overflow: document.body.scrollWidth - width,
        hint: "Page has horizontal scroll",
      });
    }

    document.querySelectorAll("table").forEach((table) => {
      const parentStyles = table.parentElement
        ? window.getComputedStyle(table.parentElement)
        : null;

      const parentAllowsScroll =
        parentStyles &&
        (parentStyles.overflowX === "auto" || parentStyles.overflowX === "scroll");

      if (!parentAllowsScroll && table.scrollWidth > width) {
        const className = table.className?.toString().trim().split(/\s+/)[0] || "";
        issues.push({
          element: `table${className ? "." + className : ""}`,
          scrollWidth: table.scrollWidth,
          overflow: table.scrollWidth - width,
          hint: "Table overflows with no scroll container",
        });
      }
    });

    return [...new Map(issues.map((issue) => [issue.element, issue])).values()];
  }, viewportWidth);

  for (const issue of overflowIssues) {
    const screenshotPath = await takeScreenshot(
      page,
      screenshotDir,
      `overflow-${viewportWidth}px-${route.path.replace(/\//g, "-")}`
    );

    findings.push({
      id: `resp-overflow-${findingCount + findings.length + 1}`,
      route: route.path,
      source: "responsive",
      severity: "major",
      wcag: ["WCAG 1.4.10"],
      title: `Content overflow at ${viewportWidth}px`,
      description: `<${issue.element}> overflows by ${issue.overflow}px. ${issue.hint}`,
      screenshot: screenshotPath,
    });
  }

  return findings;
}

async function checkTouchTargets(page, viewportWidth, minimumSize, route, screenshotDir, findingCount) {
  const findings = [];

  const smallTargets = await page.evaluate((minimumPx) => {
    const interactiveSelectors =
      "button, a[href], input, select, textarea, [role='button'], [role='link'], [role='menuitem'], [role='tab']";

    const issues = [];

    document.querySelectorAll(interactiveSelectors).forEach((element) => {
      const rect = element.getBoundingClientRect();

      if (rect.width > 0 && rect.height > 0 && (rect.width < minimumPx || rect.height < minimumPx)) {
        const label = (
          element.getAttribute("aria-label") ||
          element.getAttribute("data-testid") ||
          element.textContent ||
          ""
        ).trim().slice(0, 30);

        const className = element.className
          ? " ." + element.className.toString().trim().split(/\s+/)[0]
          : "";

        issues.push({
          element: `${element.tagName.toLowerCase()}${className}`,
          label,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    });

    return issues.slice(0, 20);
  }, minimumSize);

  if (smallTargets.length > 0) {
    const first = smallTargets[0];
    const screenshotPath = await takeScreenshot(
      page,
      screenshotDir,
      `touch-${viewportWidth}px-${route.path.replace(/\//g, "-")}`
    );

    findings.push({
      id: `resp-touch-${findingCount + findings.length + 1}`,
      route: route.path,
      source: "responsive",
      severity: "major",
      wcag: ["WCAG 2.5.5"],
      title: `Touch targets below ${minimumSize}px at ${viewportWidth}px`,
      description: `${smallTargets.length} element(s) too small. e.g. <${first.element}> "${first.label}" ${first.width}×${first.height}px (need ${minimumSize}px)`,
      screenshot: screenshotPath,
    });
  }

  return findings;
}

async function checkDarkModeContrast(page, minimumRatio, route, screenshotDir, findingCount) {
  const findings = [];

  const contrastFailures = await page.evaluate(CONTRAST_CHECK_SCRIPT, minimumRatio);

  if (contrastFailures.length > 0) {
    const first = contrastFailures[0];
    const screenshotPath = await takeScreenshot(
      page,
      screenshotDir,
      `dark-contrast-${route.path.replace(/\//g, "-")}`
    );

    findings.push({
      id: `resp-dark-${findingCount + findings.length + 1}`,
      route: route.path,
      source: "responsive",
      severity: "major",
      wcag: ["WCAG 1.4.3"],
      title: "Dark mode contrast failures",
      description: `${contrastFailures.length} element(s) fail contrast in dark mode. e.g. ${first.element} ratio=${first.ratio} (need ${minimumRatio})`,
      screenshot: screenshotPath,
    });
  }

  return findings;
}

async function checkTextResize(page, scalePct, route, screenshotDir, findingCount) {
  const findings = [];

  await page.evaluate((percentage) => {
    document.documentElement.style.fontSize = `${percentage}%`;
  }, scalePct);

  await page.waitForTimeout(300);

  const overflows = await page.evaluate(
    () => document.body.scrollWidth > window.innerWidth + 2
  );

  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });

  if (overflows) {
    const screenshotPath = await takeScreenshot(
      page,
      screenshotDir,
      `zoom-${route.path.replace(/\//g, "-")}`
    );

    findings.push({
      id: `resp-zoom-${findingCount + findings.length + 1}`,
      route: route.path,
      source: "responsive",
      severity: "major",
      wcag: ["WCAG 1.4.4"],
      title: `Content overflows at ${scalePct}% text size`,
      description: `Horizontal overflow detected at ${scalePct}% font size — WCAG 1.4.4 requires no loss of content up to 200%.`,
      screenshot: screenshotPath,
    });
  }

  return findings;
}

async function checkTextSpacing(page, route, findingCount) {
  const findings = [];

  await page.addStyleTag({
    content: `* {
      line-height: 1.5 !important;
      letter-spacing: 0.12em !important;
      word-spacing: 0.16em !important;
      margin-bottom: 0.35em !important;
    }`,
  });

  await page.waitForTimeout(300);

  const overflows = await page.evaluate(
    () => document.body.scrollWidth > window.innerWidth + 2
  );

  if (overflows) {
    findings.push({
      id: `resp-spacing-${findingCount + findings.length + 1}`,
      route: route.path,
      source: "responsive",
      severity: "minor",
      wcag: ["WCAG 1.4.12"],
      title: "Content overflows with text spacing overrides",
      description:
        "Injecting WCAG 1.4.12 text spacing values (line-height 1.5, letter-spacing 0.12em) causes horizontal overflow.",
    });
  }

  return findings;
}

async function checkOrientation(page, viewport, route, findingCount) {
  const findings = [];

  const landscapeWidth = Math.max(viewport.height, 568);
  const landscapeHeight = Math.min(viewport.width, 320);

  await page.setViewportSize({ width: landscapeWidth, height: landscapeHeight });
  await page.waitForTimeout(300);

  const overflows = await page.evaluate(
    () => document.body.scrollWidth > window.innerWidth + 2
  );

  await page.setViewportSize({ width: viewport.width, height: viewport.height });

  if (overflows) {
    findings.push({
      id: `resp-orient-${findingCount + findings.length + 1}`,
      route: route.path,
      source: "responsive",
      severity: "major",
      wcag: ["WCAG 1.3.4"],
      title: "Content overflows in landscape orientation",
      description: `Page overflows horizontally when viewport rotated to landscape (${landscapeWidth}×${landscapeHeight}).`,
    });
  }

  return findings;
}

export async function runResponsiveChecks(browser, config, paths, authSession = null, authStorage = null) {
  const findings = [];
  const baseUrl = process.env.BASE_URL || config.baseUrl;
  const minimumTouchSize = config.thresholds?.touchPx || 44;
  const minimumContrast = config.thresholds?.contrast || 4.5;
  const fontScalePercent = config.thresholds?.fontScalePct || 200;

  mkdirSync(paths.screenshots, { recursive: true });

  const defaultViewports = {
    mobile:  { width: 375,  height: 812,  darkMode: false },
    tablet:  { width: 768,  height: 1024, darkMode: false },
    desktop: { width: 1280, height: 800,  darkMode: false },
    dark:    { width: 1280, height: 800,  darkMode: true  },
  };

  const viewports = Object.entries(config.viewports || defaultViewports);

  for (const [viewportName, viewport] of viewports) {
    const context = await createAuthenticatedContext(browser, config, {
      width:  viewport.width,
      height: viewport.height,
    });
    await context.setExtraHTTPHeaders({});


    const page = await context.newPage();

    if (viewport.darkMode) {
      // Prefer CSS media emulation (zero-cost, no navigation needed).
      // If the app uses a UI toggle instead of prefers-color-scheme, use
      // viewport.darkModeSetup to click the toggle after the first navigation.
      await page.emulateMedia({ colorScheme: "dark" });
    }

    // Activate dark mode via UI toggle (for apps that don't use prefers-color-scheme)
    if (viewport.darkMode && viewport.darkModeSetup) {
      const setup = viewport.darkModeSetup;
      const setupUrl = `${baseUrl}${setup.navigateTo ?? config.routes[0]?.path ?? ""}`;
      await navigateAuthenticated(page, setupUrl, config);

      try {
        const toggle = page.locator(setup.selector).first();
        await toggle.waitFor({ state: "visible", timeout: 5000 });
        await toggle.click();
        await page.waitForTimeout(600);
      } catch {
        console.warn(`   ⚠ darkModeSetup: could not click "${setup.selector}" on ${setupUrl}`);
      }
    }

    for (const route of config.routes) {
      const url = `${baseUrl}${route.path}`;
      process.stdout.write(`   resp ${viewportName.padEnd(10)} ${route.name.padEnd(12)}`);

      let issueCount = 0;

      try {
        await navigateAuthenticated(page, url, config, route.waitFor);

        const overflowFindings = await checkOverflow(
          page, viewport.width, route, paths.screenshots, findings.length
        );
        findings.push(...overflowFindings);
        issueCount += overflowFindings.length;

        if (viewport.width <= 768) {
          const touchFindings = await checkTouchTargets(
            page, viewport.width, minimumTouchSize, route, paths.screenshots, findings.length
          );
          findings.push(...touchFindings);
          issueCount += touchFindings.length;
        }

        if (viewport.darkMode) {
          const contrastFindings = await checkDarkModeContrast(
            page, minimumContrast, route, paths.screenshots, findings.length
          );
          findings.push(...contrastFindings);
          issueCount += contrastFindings.length;
        }

        if (!viewport.darkMode && viewport.width >= 1280) {
          const zoomFindings = await checkTextResize(
            page, fontScalePercent, route, paths.screenshots, findings.length
          );
          findings.push(...zoomFindings);
          issueCount += zoomFindings.length;

          const spacingFindings = await checkTextSpacing(page, route, findings.length);
          findings.push(...spacingFindings);
          issueCount += spacingFindings.length;
        }

        if (viewport.width <= 768) {
          const orientationFindings = await checkOrientation(
            page, viewport, route, findings.length
          );
          findings.push(...orientationFindings);
          issueCount += orientationFindings.length;
        }

        console.log(`→ ${issueCount} issue(s)`);
      } catch (error) {
        console.log(`→ ⚠ ${error.message.split("\n")[0]}`);
      }
    }

    await context.close();
  }

  return findings;
}
