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

async function checkLabelInName(page, route, paths) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const results = [];
    const elementsWithAriaLabel =
      "button[aria-label], a[href][aria-label], [role='button'][aria-label], input[aria-label]";

    // Material Icons render icon ligature names as textContent (e.g. "keyboard_double_arrow_left")
    // These are not human-readable visible text — filter them out to avoid false positives.
    const MATERIAL_ICON_PATTERN = /^[a-z][a-z0-9_]{4,}$/;

    const isIconText = (text) => {
      const parts = text.split(/\s+/);
      // If ALL parts look like icon ligature names, skip this element
      return parts.every((part) => MATERIAL_ICON_PATTERN.test(part));
    };

    const stripIconText = (text) => {
      // Remove parts that look like Material Icon ligature names
      return text
        .split(/\s+/)
        .filter((part) => !MATERIAL_ICON_PATTERN.test(part))
        .join(" ")
        .trim();
    };

    document.querySelectorAll(elementsWithAriaLabel).forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const ariaLabel    = (element.getAttribute("aria-label") || "").trim().toLowerCase();
      const rawText      = (element.textContent || element.getAttribute("value") || "").trim();
      const visibleText  = stripIconText(rawText).toLowerCase();

      // Skip if no real visible text remains after stripping icon names
      if (!visibleText || visibleText.length < 2) return;

      // Skip if the aria-label contains the visible text
      if (ariaLabel.includes(visibleText)) return;

      // Skip if the visible text is just numbers or single characters
      if (/^[\d\s]+$/.test(visibleText)) return;

      results.push({
        tag:         element.tagName.toLowerCase(),
        visibleText: visibleText.slice(0, 40),
        ariaLabel:   element.getAttribute("aria-label")?.slice(0, 60) || "",
        testId:      element.getAttribute("data-testid") || "",
      });
    });

    return results.slice(0, 10);
  });

  for (const issue of issues) {
    const screenshotPath = await takeScreenshot(
      page,
      paths.screenshots,
      `label-in-name-${route.path.replace(/\//g, "-")}`
    );

    findings.push({
      id:          `ext-label-in-name-${findings.length + 1}`,
      route:       route.path,
      source:      "wcagExtended",
      severity:    "major",
      wcag:        ["WCAG 2.5.3"],
      title:       "Accessible name does not contain visible label",
      description:
        `<${issue.tag}${issue.testId ? ` data-testid="${issue.testId}"` : ""}> ` +
        `is visually labelled "${issue.visibleText}" but aria-label is "${issue.ariaLabel}". ` +
        `Voice-control users saying "${issue.visibleText}" cannot activate this control. ` +
        `Fix: make aria-label start with or contain the visible label text.`,
      screenshot:  screenshotPath,
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

async function checkLanguage(page, route) {
  const findings = [];

  const langInfo = await page.evaluate(() => {
    const html = document.documentElement;
    const lang = (html.getAttribute("lang") || "").trim();
    // BCP 47 primary subtag check: 2–8 letters, optional subtags
    const bcp47 = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/;
    return {
      lang,
      missing: lang.length === 0,
      invalid: lang.length > 0 && !bcp47.test(lang),
    };
  });

  if (langInfo.missing) {
    findings.push({
      id: `ext-lang-missing-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "critical",
      wcag: ["WCAG 3.1.1"],
      title: "Page has no lang attribute",
      description:
        `<html> has no lang attribute. Screen readers default to the OS language, causing incorrect pronunciation for all text. Add lang="en" (or appropriate BCP 47 tag).`,
    });
  } else if (langInfo.invalid) {
    findings.push({
      id: `ext-lang-invalid-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "major",
      wcag: ["WCAG 3.1.1"],
      title: "lang attribute value is not valid BCP 47",
      description:
        `<html lang="${langInfo.lang}"> is not a valid BCP 47 language tag. Use a tag such as "en", "en-US", or "fr-CA".`,
    });
  }

  return findings;
}

async function checkColorOnly(page, route, paths) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const results = [];

    // Links inside paragraph/list/table text — must be distinguishable from body text by more than color
    document.querySelectorAll("p a[href], li a[href], td a[href]").forEach((link) => {
      const rect = link.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const styles = window.getComputedStyle(link);
      const parentStyles = window.getComputedStyle(link.parentElement);

      const isUnderlined = styles.textDecorationLine.includes("underline");
      const isBolder = parseInt(styles.fontWeight) >= parseInt(parentStyles.fontWeight) + 200;
      const hasBorderBottom =
        styles.borderBottomStyle !== "none" && parseFloat(styles.borderBottomWidth) > 0;
      const hasOutline =
        styles.outlineStyle !== "none" && parseFloat(styles.outlineWidth) > 0;

      if (!isUnderlined && !isBolder && !hasBorderBottom && !hasOutline) {
        results.push({
          text: link.textContent.trim().slice(0, 50),
          href: (link.getAttribute("href") || "").slice(0, 50),
        });
      }
    });

    return results.slice(0, 5);
  });

  for (const issue of issues) {
    const screenshotPath = await takeScreenshot(
      page,
      paths.screenshots,
      `color-only-${route.path.replace(/\//g, "-")}`
    );

    findings.push({
      id: `ext-color-only-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "major",
      wcag: ["WCAG 1.4.1"],
      title: "Link distinguished from body text by color only",
      description:
        `Link "${issue.text}" (href: ${issue.href}) is embedded in body text and has no underline, ` +
        `bold weight, border, or other non-color visual cue. Users with color vision deficiency cannot identify it as a link.`,
      screenshot: screenshotPath,
    });
  }

  return findings;
}

async function checkMotionAndTiming(page, route, paths) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const problems = [];

    // 2.2.1 — meta refresh with a timeout
    const metaRefresh = document.querySelector("meta[http-equiv='refresh'], meta[http-equiv='Refresh']");
    if (metaRefresh) {
      const content = metaRefresh.getAttribute("content") || "";
      const seconds = parseInt(content.split(";")[0], 10);
      if (!isNaN(seconds) && seconds > 0) {
        problems.push({ type: "meta-refresh", seconds });
      }
    }

    // 2.2.2 — deprecated moving/blinking elements
    document.querySelectorAll("marquee, blink").forEach((el) => {
      problems.push({ type: "deprecated-motion", tag: el.tagName.toLowerCase() });
    });

    // 2.2.2 / 1.4.2 — autoplay audio (always a problem) or autoplay video with audio
    document.querySelectorAll("video[autoplay], audio[autoplay]").forEach((el) => {
      const isMuted = el.hasAttribute("muted");
      const tag = el.tagName.toLowerCase();
      if (tag === "audio" || !isMuted) {
        problems.push({
          type: "autoplay",
          tag,
          muted: isMuted,
          src: (el.getAttribute("src") || el.querySelector("source")?.getAttribute("src") || "").slice(0, 60),
        });
      }
    });

    // 2.2.2 — infinite CSS animations without prefers-reduced-motion safeguard
    const infiniteAnimated = [];
    document.querySelectorAll("*").forEach((el) => {
      const styles = window.getComputedStyle(el);
      if (
        styles.animationName !== "none" &&
        styles.animationIterationCount === "infinite" &&
        styles.animationPlayState === "running"
      ) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          infiniteAnimated.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || "").toString().slice(0, 40),
            animation: styles.animationName,
          });
        }
      }
    });
    if (infiniteAnimated.length > 0) {
      problems.push({ type: "infinite-animation", count: infiniteAnimated.length, examples: infiniteAnimated.slice(0, 3) });
    }

    return problems;
  });

  for (const issue of issues) {
    if (issue.type === "meta-refresh") {
      findings.push({
        id: `ext-timing-refresh-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "critical",
        wcag: ["WCAG 2.2.1"],
        title: "Page auto-refreshes with a time limit",
        description:
          `<meta http-equiv="refresh" content="${issue.seconds}"> causes the page to reload after ${issue.seconds}s, ` +
          `removing control from users. Remove the meta refresh or provide a mechanism to extend or disable it.`,
      });
    } else if (issue.type === "deprecated-motion") {
      findings.push({
        id: `ext-timing-motion-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "critical",
        wcag: ["WCAG 2.2.2"],
        title: `Deprecated <${issue.tag}> element causes uncontrollable motion`,
        description:
          `<${issue.tag}> is deprecated and violates 2.2.2 — users cannot pause, stop, or hide moving content. Replace with CSS animation controlled by prefers-reduced-motion.`,
      });
    } else if (issue.type === "autoplay") {
      const screenshotPath = await takeScreenshot(
        page,
        paths.screenshots,
        `autoplay-${route.path.replace(/\//g, "-")}`
      );
      findings.push({
        id: `ext-timing-autoplay-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "critical",
        wcag: issue.tag === "audio" ? ["WCAG 1.4.2"] : ["WCAG 2.2.2"],
        title: `<${issue.tag}> plays automatically with audio`,
        description:
          `<${issue.tag}${issue.src ? ` src="${issue.src}"` : ""}> autoplays${issue.tag === "audio" || !issue.muted ? " with audio" : ""}. ` +
          (issue.tag === "audio"
            ? "WCAG 1.4.2 requires audio that plays automatically for more than 3s to be pauseable or have volume control."
            : "WCAG 2.2.2 requires moving media to be pauseable."),
        screenshot: screenshotPath,
      });
    } else if (issue.type === "infinite-animation") {
      findings.push({
        id: `ext-timing-anim-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "minor",
        wcag: ["WCAG 2.2.2"],
        title: "Infinite CSS animation not gated by prefers-reduced-motion",
        description:
          `${issue.count} element(s) run infinite CSS animations without a @media (prefers-reduced-motion) rule to pause or stop them. ` +
          `Example: <${issue.examples[0].tag} class="${issue.examples[0].cls}"> animation="${issue.examples[0].animation}". ` +
          `Add: @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; } }`,
      });
    }
  }

  return findings;
}

async function checkMediaAlternatives(page, route, paths) {
  const findings = [];

  const mediaIssues = await page.evaluate(() => {
    const issues = [];

    document.querySelectorAll("video").forEach((video) => {
      const rect = video.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const hasCaptionTrack = Array.from(video.querySelectorAll("track")).some(
        (t) => t.getAttribute("kind") === "captions" || t.getAttribute("kind") === "subtitles"
      );
      const src = (video.getAttribute("src") || video.querySelector("source")?.getAttribute("src") || "").slice(0, 60);

      if (!hasCaptionTrack) {
        issues.push({ type: "video-no-captions", src });
      }
    });

    document.querySelectorAll("audio").forEach((audio) => {
      const rect = audio.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      // Heuristic: look for a transcript link in the nearest section/article/div ancestor
      const ancestor = audio.closest("section, article, div") || audio.parentElement;
      const nearbyText = ancestor?.textContent?.toLowerCase() || "";
      const hasTranscriptLink = /transcript|text alternative|read the|full text/i.test(nearbyText);

      const src = (audio.getAttribute("src") || audio.querySelector("source")?.getAttribute("src") || "").slice(0, 60);
      if (!hasTranscriptLink) {
        issues.push({ type: "audio-no-transcript", src });
      }
    });

    return issues;
  });

  for (const issue of mediaIssues) {
    const screenshotPath = await takeScreenshot(
      page,
      paths.screenshots,
      `media-alt-${route.path.replace(/\//g, "-")}`
    );

    if (issue.type === "video-no-captions") {
      findings.push({
        id: `ext-media-captions-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "critical",
        wcag: ["WCAG 1.2.2"],
        title: "Video element has no captions track",
        description:
          `<video${issue.src ? ` src="${issue.src}"` : ""}> has no <track kind="captions"> or <track kind="subtitles">. ` +
          `Deaf and hard-of-hearing users cannot access spoken content. Add a WebVTT captions file via <track kind="captions" src="...">.`,
        screenshot: screenshotPath,
      });
    } else if (issue.type === "audio-no-transcript") {
      findings.push({
        id: `ext-media-transcript-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "critical",
        wcag: ["WCAG 1.2.1"],
        title: "Audio element has no adjacent transcript",
        description:
          `<audio${issue.src ? ` src="${issue.src}"` : ""}> has no nearby transcript link. ` +
          `WCAG 1.2.1 requires audio-only content to have a text transcript. ` +
          `Add a visible transcript link adjacent to the audio element.`,
        screenshot: screenshotPath,
      });
    }
  }

  return findings;
}

async function checkPointerGestures(page, route) {
  const findings = [];

  const draggables = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("[draggable='true']"))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        testId: el.getAttribute("data-testid") || "",
        text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 50),
      }))
      .slice(0, 10);
  });

  for (const el of draggables) {
    findings.push({
      id: `ext-pointer-gesture-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "major",
      wcag: ["WCAG 2.5.1"],
      title: "Draggable element — verify single-pointer alternative",
      description:
        `<${el.tag}${el.testId ? ` data-testid="${el.testId}"` : ""}${el.role ? ` role="${el.role}"` : ""}> "${el.text}" ` +
        `is draggable. WCAG 2.5.1 requires all drag operations to also be completable with a single pointer without a path-based gesture ` +
        `(e.g. click-to-pick + click-to-drop, or reorder buttons). Manually verify the keyboard/single-click alternative is present.`,
    });
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

export async function runWcagExtendedChecks(browser, config, paths, authSession = null, authStorage = null) {
  const findings = [];
  const baseUrl = process.env.BASE_URL || config.baseUrl;
  const minimumNonTextContrast = config.thresholds?.nonTextContrast || 3.0;

  mkdirSync(paths.screenshots, { recursive: true });

  const context = await createAuthenticatedContext(browser, config);

  const page = await context.newPage();

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   ext  ${route.name.padEnd(16)}`);

    let issueCount = 0;

    try {
      // Passive checks — only read the DOM, safe to run after a single navigation
      await navigateAuthenticated(page, url, config, route.waitFor);

      const passiveChecks = [
        () => checkNonTextContrast(page, route, paths, minimumNonTextContrast),
        () => checkPageTitle(page, route),
        () => checkDescriptiveHeadings(page, route),
        () => checkLinkPurpose(page, route),
        () => checkLabelInName(page, route, paths),
        () => checkLabelsOrInstructions(page, route),
        () => checkStatusMessages(page, route),
        () => checkLanguage(page, route),
        () => checkColorOnly(page, route, paths),
        () => checkMotionAndTiming(page, route, paths),
        () => checkMediaAlternatives(page, route, paths),
        () => checkPointerGestures(page, route),
      ];

      for (const check of passiveChecks) {
        try {
          const results = await check();
          findings.push(...results);
          issueCount += results.length;
        } catch { /* skip individual check failure */ }
      }

      // Active checks — interact with the page (focus, input changes, form submit).
      // Re-navigate before each one so they start from a clean, authenticated state.
      const activeChecks = [
        () => checkOnFocus(page, route, paths),
        () => checkOnInput(page, route, paths),
        () => checkErrorSuggestions(page, route, paths),
      ];

      for (const check of activeChecks) {
        try {
          await navigateAuthenticated(page, url, config, route.waitFor);
          const results = await check();
          findings.push(...results);
          issueCount += results.length;
        } catch { /* skip individual check failure */ }
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