import { join } from "path";
import { mkdirSync } from "fs";

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
    const filePath = join(screenshotDir, `ext-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

async function checkNonTextContrast(page, route, paths, minimumRatio = 3.0) {
  const findings = [];

  const issues = await page.evaluate((minimum) => {
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

    const results = [];
    const componentSelectors =
      "input:not([type='hidden']), select, textarea, button, [role='checkbox'], [role='radio'], [role='switch']";

    document.querySelectorAll(componentSelectors).forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const styles = window.getComputedStyle(element);
      const borderColor = styles.borderColor;
      const pageBackground = window.getComputedStyle(document.body).backgroundColor;

      if (borderColor && pageBackground && borderColor !== "rgba(0, 0, 0, 0)") {
        const ratio = getContrastRatio(borderColor, pageBackground);

        if (ratio < minimum) {
          const testId = element.getAttribute("data-testid");
          results.push({
            element: `${element.tagName.toLowerCase()}${element.id ? "#" + element.id : ""}${testId ? `[data-testid=${testId}]` : ""}`,
            type: "border vs page-background",
            borderColor,
            pageBackground,
            ratio: Math.round(ratio * 100) / 100,
            required: minimum,
          });
        }
      }
    });

    return results.slice(0, 10);
  }, minimumRatio);

  for (const issue of issues) {
    const screenshotPath = await takeScreenshot(
      page,
      paths.screenshots,
      `non-text-contrast-${route.path.replace(/\//g, "-")}`
    );

    findings.push({
      id: `ext-ntc-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "major",
      wcag: ["WCAG 1.4.11"],
      title: "Non-text contrast failure",
      description: `<${issue.element}> ${issue.type}: ratio ${issue.ratio} (need ${issue.required}). Border: ${issue.borderColor}`,
      screenshot: screenshotPath,
    });
  }

  return findings;
}

async function checkPageTitle(page, route) {
  const findings = [];

  const titleInfo = await page.evaluate(() => {
    const title = document.title?.trim() || "";
    const genericTitles = ["untitled", "home", "page", "document", "index", "app", "react app", ""];

    return {
      title,
      isMissing: title.length === 0,
      isGeneric: genericTitles.includes(title.toLowerCase()),
    };
  });

  if (titleInfo.isMissing) {
    findings.push({
      id: `ext-title-missing-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "critical",
      wcag: ["WCAG 2.4.2"],
      title: "Page has no <title> element",
      description: `Route "${route.path}" has no document title. Screen reader users and browser tab users cannot identify the page.`,
    });
  } else if (titleInfo.isGeneric) {
    findings.push({
      id: `ext-title-generic-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "minor",
      wcag: ["WCAG 2.4.2"],
      title: "Page title is generic",
      description: `<title>${titleInfo.title}</title> is not descriptive. Each page should have a unique title describing its purpose.`,
    });
  }

  return findings;
}

async function checkLinkPurpose(page, route) {
  const findings = [];

  const vagueLinks = await page.evaluate(() => {
    const VAGUE_LINK_TEXTS = new Set([
      "click here", "here", "read more", "more", "link", "this",
      "continue", "learn more", "see more", "go", "details",
      "info", "information", "page", "website", "url",
    ]);

    const results = [];

    document.querySelectorAll("a[href]").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const ariaLabel = element.getAttribute("aria-label")?.trim().toLowerCase();
      const textContent = element.textContent?.trim().toLowerCase();
      const titleAttr = element.getAttribute("title")?.trim().toLowerCase();
      const accessibleName = ariaLabel || textContent || titleAttr || "";

      if (!accessibleName) return;

      if (VAGUE_LINK_TEXTS.has(accessibleName)) {
        results.push({
          text: element.textContent?.trim().slice(0, 60) || "(no text)",
          href: element.getAttribute("href")?.slice(0, 60) || "",
          ariaLabel: element.getAttribute("aria-label") || null,
        });
      }
    });

    return results.slice(0, 15);
  });

  for (const link of vagueLinks) {
    findings.push({
      id: `ext-link-purpose-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "minor",
      wcag: ["WCAG 2.4.4"],
      title: "Link text is not descriptive",
      description:
        `Link "${link.text}" (href: ${link.href}) is vague out of context. ` +
        `Screen reader users navigating by links list hear only "${link.text}". ` +
        `Replace with descriptive text or add aria-label.` +
        (link.ariaLabel ? ` (current aria-label: "${link.ariaLabel}")` : ""),
    });
  }

  return findings;
}

async function checkDescriptiveHeadings(page, route) {
  const findings = [];

  const headingIssues = await page.evaluate(() => {
    const GENERIC_PATTERNS = [
      /^section\s*\d*$/i, /^heading\s*\d*$/i, /^title\s*\d*$/i,
      /^content$/i, /^main$/i, /^page\s*\d*$/i, /^untitled$/i,
    ];

    const results = [];

    document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const text = element.textContent?.trim() || "";
      const level = element.tagName.match(/H(\d)/)?.[1] || element.getAttribute("aria-level") || "?";

      if (text.length === 0) {
        results.push({ level, text: "(empty)", issue: "Heading is empty — screen reader users hear nothing" });
      } else if (text.length < 3) {
        results.push({ level, text, issue: `Heading "${text}" is too short to be descriptive` });
      } else if (GENERIC_PATTERNS.some((pattern) => pattern.test(text))) {
        results.push({ level, text, issue: `Heading "${text}" appears generic — not descriptive of content` });
      }
    });

    return results;
  });

  for (const heading of headingIssues) {
    findings.push({
      id: `ext-heading-desc-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "minor",
      wcag: ["WCAG 2.4.6"],
      title: "Heading is not descriptive",
      description: `H${heading.level}: ${heading.issue}`,
    });
  }

  return findings;
}

async function checkLabelInName(page, route) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const results = [];
    const elementsWithAriaLabel =
      "button[aria-label], a[href][aria-label], [role='button'][aria-label], input[aria-label]";

    document.querySelectorAll(elementsWithAriaLabel).forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const ariaLabel = (element.getAttribute("aria-label") || "").trim().toLowerCase();
      const visibleText = (element.textContent || element.getAttribute("value") || "").trim().toLowerCase();

      if (!visibleText || visibleText.length < 2) return;
      if (ariaLabel.includes(visibleText)) return;

      results.push({
        tag: element.tagName.toLowerCase(),
        visibleText: element.textContent?.trim().slice(0, 40) || "",
        ariaLabel: element.getAttribute("aria-label")?.slice(0, 60) || "",
        testId: element.getAttribute("data-testid") || "",
      });
    });

    return results.slice(0, 10);
  });

  for (const issue of issues) {
    findings.push({
      id: `ext-label-in-name-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "major",
      wcag: ["WCAG 2.5.3"],
      title: "Accessible name does not contain visible label",
      description:
        `<${issue.tag}${issue.testId ? ` data-testid="${issue.testId}"` : ""}> ` +
        `is visually labelled "${issue.visibleText}" but aria-label is "${issue.ariaLabel}". ` +
        `Voice-control users saying "${issue.visibleText}" cannot activate this control. ` +
        `Fix: make aria-label start with or contain "${issue.visibleText}".`,
    });
  }

  return findings;
}

async function checkOnFocus(page, route, paths) {
  const findings = [];

  const focusableElements = await page.evaluate(() => {
    const selector =
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

    return Array.from(document.querySelectorAll(selector))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .slice(0, 20)
      .map((element, index) => ({
        index,
        tag: element.tagName.toLowerCase(),
        testId: element.getAttribute("data-testid") || "",
        text: (element.textContent || "").trim().slice(0, 30),
      }));
  });

  for (const element of focusableElements) {
    const urlBeforeFocus = page.url();

    await page.evaluate((elementIndex) => {
      const selector =
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

      const elements = Array.from(document.querySelectorAll(selector)).filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      elements[elementIndex]?.focus();
    }, element.index);

    await page.waitForTimeout(200);

    const urlAfterFocus = page.url();

    if (urlAfterFocus !== urlBeforeFocus) {
      const screenshotPath = await takeScreenshot(
        page,
        paths.screenshots,
        `on-focus-${route.path.replace(/\//g, "-")}`
      );

      findings.push({
        id: `ext-onfocus-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "critical",
        wcag: ["WCAG 3.2.1"],
        title: "Focus causes unexpected navigation",
        description:
          `Focusing <${element.tag}> "${element.text}" changed URL from "${urlBeforeFocus}" to "${urlAfterFocus}" — unexpected context change on focus.`,
        screenshot: screenshotPath,
      });

      await page.goto(urlBeforeFocus, { waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(300);
      break;
    }
  }

  return findings;
}

async function checkOnInput(page, route, paths) {
  const findings = [];

  const selectElements = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("select"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .slice(0, 5)
      .map((element, index) => ({
        index,
        id: element.id,
        testId: element.getAttribute("data-testid") || "",
        optionCount: element.options.length,
      }));
  });

  for (const selectElement of selectElements) {
    if (selectElement.optionCount < 2) continue;

    const urlBeforeChange = page.url();

    await page.evaluate((elementIndex) => {
      const elements = Array.from(document.querySelectorAll("select")).filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      const element = elements[elementIndex];
      if (!element || element.options.length < 2) return;

      element.value = element.options[1].value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, selectElement.index);

    await page.waitForTimeout(400);

    const urlAfterChange = page.url();

    if (urlAfterChange !== urlBeforeChange) {
      const screenshotPath = await takeScreenshot(
        page,
        paths.screenshots,
        `on-input-${route.path.replace(/\//g, "-")}`
      );

      findings.push({
        id: `ext-oninput-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "critical",
        wcag: ["WCAG 3.2.2"],
        title: "Input change causes unexpected navigation",
        description:
          `Changing <select${selectElement.id ? "#" + selectElement.id : ""}> triggered navigation to "${urlAfterChange}" without user confirmation — violates 3.2.2.`,
        screenshot: screenshotPath,
      });

      await page.goto(urlBeforeChange, { waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(300);
      break;
    }
  }

  return findings;
}

async function checkLabelsOrInstructions(page, route) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const results = [];
    const FORMAT_INPUT_TYPES = new Set(["date", "time", "datetime-local", "tel", "number", "email", "url"]);
    const FORMAT_NAME_PATTERNS = [/date/i, /phone/i, /postcode/i, /zip/i, /dob/i, /birth/i, /code/i];

    document.querySelectorAll("input, textarea, select").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (element.getAttribute("type") === "hidden") return;

      const isRequired = element.hasAttribute("required") || element.getAttribute("aria-required") === "true";
      const hasLabel =
        !!element.labels?.length ||
        !!element.getAttribute("aria-label") ||
        !!element.getAttribute("aria-labelledby");
      const placeholder = element.getAttribute("placeholder") || "";
      const inputType = (element.getAttribute("type") || "text").toLowerCase();
      const fieldName = (element.getAttribute("name") || element.getAttribute("id") || "").toLowerCase();
      const testId = element.getAttribute("data-testid") || "";

      if (isRequired && !hasLabel && placeholder) {
        results.push({
          issue: "placeholder-only-label",
          element: element.tagName.toLowerCase(),
          testId,
          placeholder,
          description:
            `Required field uses placeholder "${placeholder}" as its only label. ` +
            `Placeholder disappears on input and is not reliably announced by screen readers. ` +
            `Add a visible <label> or aria-label.`,
        });
      }

      const needsFormatHint =
        FORMAT_INPUT_TYPES.has(inputType) ||
        FORMAT_NAME_PATTERNS.some((pattern) => pattern.test(fieldName));

      if (needsFormatHint) {
        const describedBy = element.getAttribute("aria-describedby");
        const hasHintElement = describedBy ? !!document.getElementById(describedBy) : false;
        const hasPlaceholderHint = placeholder.length > 4;

        if (!hasHintElement && !hasPlaceholderHint) {
          results.push({
            issue: "missing-format-hint",
            element: element.tagName.toLowerCase(),
            testId,
            inputType,
            fieldName,
            description:
              `<${element.tagName.toLowerCase()} type="${inputType}"> "${fieldName || testId}" ` +
              `requires a specific format but has no hint text or aria-describedby. ` +
              `Add visible hint text (e.g. "DD/MM/YYYY") linked via aria-describedby.`,
          });
        }
      }
    });

    return results.slice(0, 15);
  });

  for (const issue of issues) {
    findings.push({
      id: `ext-labels-instr-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: issue.issue === "placeholder-only-label" ? "major" : "minor",
      wcag: ["WCAG 3.3.2"],
      title:
        issue.issue === "placeholder-only-label"
          ? "Required field uses placeholder as its only label"
          : "Format field missing input instructions",
      description: issue.description,
    });
  }

  return findings;
}

async function checkErrorSuggestions(page, route, paths) {
  const findings = [];

  const hasForm = await page.evaluate(() => !!document.querySelector("form"));
  if (!hasForm) return findings;

  await page.evaluate(() => {
    const submitButton = document.querySelector("button[type='submit'], input[type='submit']");
    if (submitButton) submitButton.click();
  });

  await page.waitForTimeout(800);

  const vagueErrors = await page.evaluate(() => {
    const VAGUE_ERROR_TEXTS = new Set([
      "required", "invalid", "error", "field required",
      "this field is required", "please fill in", "fill this field",
      "this is required", "mandatory",
    ]);

    const errorElements = document.querySelectorAll(
      "[role='alert'], [aria-live='assertive'], .error, [class*='error'], [class*='invalid'], [class*='field-error']"
    );

    const results = [];

    errorElements.forEach((element) => {
      const text = element.textContent?.trim().toLowerCase() || "";
      if (text && VAGUE_ERROR_TEXTS.has(text)) {
        const className = element.className
          ? "." + element.className.toString().trim().split(/\s+/)[0]
          : "";
        results.push({
          text: element.textContent.trim().slice(0, 80),
          element: element.tagName.toLowerCase() + className,
        });
      }
    });

    return results;
  });

  for (const error of vagueErrors) {
    const screenshotPath = await takeScreenshot(
      page,
      paths.screenshots,
      `error-suggest-${route.path.replace(/\//g, "-")}`
    );

    findings.push({
      id: `ext-err-suggest-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "minor",
      wcag: ["WCAG 3.3.3"],
      title: "Error message doesn't explain how to fix",
      description:
        `<${error.element}> shows "${error.text}" — too vague. ` +
        `Tell users what format or value is expected (e.g. "Enter a date in DD/MM/YYYY format").`,
      screenshot: screenshotPath,
    });
  }

  return findings;
}

async function checkStatusMessages(page, route) {
  const findings = [];

  const liveRegions = await page.evaluate(() => {
    const regions = document.querySelectorAll("[role='status'], [role='alert'], [aria-live]");

    return Array.from(regions).map((element) => ({
      role: element.getAttribute("role") || "",
      live: element.getAttribute("aria-live") || "",
      atomic: element.getAttribute("aria-atomic") || "",
      text: element.textContent?.trim().slice(0, 60) || "",
      element: element.tagName.toLowerCase() + (element.id ? "#" + element.id : ""),
    }));
  });

  const actionButtons = await page.evaluate(() => {
    const ACTION_WORDS = /save|delete|remove|submit|confirm|apply|update|create/i;

    return Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((element) => ACTION_WORDS.test(element.textContent || element.getAttribute("aria-label") || ""))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .slice(0, 5)
      .map((element) => (element.textContent || "").trim().slice(0, 40));
  });

  if (actionButtons.length > 0 && liveRegions.length === 0) {
    findings.push({
      id: `ext-status-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "major",
      wcag: ["WCAG 4.1.3"],
      title: "No aria-live region for status messages",
      description:
        `Page has action buttons (${actionButtons.slice(0, 3).join(", ")}) but no role="status" or aria-live region. ` +
        `Success/error outcomes won't be announced to screen reader users.`,
    });
  }

  for (const region of liveRegions) {
    if (region.role === "alert" && region.live && region.live !== "assertive") {
      findings.push({
        id: `ext-status-live-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "minor",
        wcag: ["WCAG 4.1.3"],
        title: "role=alert should use aria-live=assertive",
        description:
          `<${region.element}> has role="alert" but aria-live="${region.live}" — mixing them can confuse screen readers.`,
      });
    }
  }

  return findings;
}

export function getExtendedManualGaps(routePath) {
  return [
    {
      id: "ext-manual-audio-only",
      route: routePath,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 1.2.1"],
      title: "[MANUAL] Audio-only and video-only content",
      description: "Check that audio-only content has a transcript and video-only content has a text alternative.",
    },
    {
      id: "ext-manual-captions",
      route: routePath,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 1.2.2"],
      title: "[MANUAL] Captions (pre-recorded)",
      description: "Check that all pre-recorded video includes accurate closed captions.",
    },
    {
      id: "ext-manual-audio-desc",
      route: routePath,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 1.2.5"],
      title: "[MANUAL] Audio description (pre-recorded)",
      description: "Check that pre-recorded video has an audio description track describing visual-only information.",
    },
    {
      id: "ext-manual-seizures",
      route: routePath,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 2.3.1"],
      title: "[MANUAL] Three flashes or below threshold",
      description: "Check that no content flashes more than 3 times per second. Requires visual inspection — cannot be automated.",
    },
    {
      id: "ext-manual-timing",
      route: routePath,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 2.2.1"],
      title: "[MANUAL] Timing adjustable",
      description: "If any timed session or content exists, verify users can turn off, adjust, or extend the time limit.",
    },
    {
      id: "ext-manual-consistent-id",
      route: routePath,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 3.2.4"],
      title: "[MANUAL] Consistent identification",
      description: "Verify components with the same function are identified consistently across pages.",
    },
    {
      id: "ext-manual-error-prevention",
      route: routePath,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 3.3.4"],
      title: "[MANUAL] Error prevention (legal/financial)",
      description: "For forms involving legal or financial data, verify submissions are reversible, checkable, or confirmed before final commit.",
    },
  ];
}

export async function runWcagExtendedChecks(browser, config, paths) {
  const findings = [];
  const baseUrl = process.env.BASE_URL || config.baseUrl;
  const minimumNonTextContrast = config.thresholds?.nonTextContrast || 3.0;

  mkdirSync(paths.screenshots, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   ext  ${route.name.padEnd(16)}`);

    let issueCount = 0;

    try {
      await navigateToPage(page, url, route);

      const checkResults = await Promise.allSettled([
        checkNonTextContrast(page, route, paths, minimumNonTextContrast),
        checkPageTitle(page, route),
        checkDescriptiveHeadings(page, route),
        checkLinkPurpose(page, route),
        checkLabelInName(page, route),
        checkLabelsOrInstructions(page, route),
        checkOnFocus(page, route, paths),
        checkOnInput(page, route, paths),
        checkErrorSuggestions(page, route, paths),
        checkStatusMessages(page, route),
      ]);

      for (const result of checkResults) {
        if (result.status === "fulfilled") {
          findings.push(...result.value);
          issueCount += result.value.length;
        }
      }

      const manualGaps = getExtendedManualGaps(route.path);
      findings.push(...manualGaps);

      console.log(`→ ${issueCount} issue(s) + ${manualGaps.length} manual gaps`);
    } catch (error) {
      console.log(`→ ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  await context.close();
  return findings;
}
