/**
 * src/checks/wcag-extended.mjs
 * UXRay — extended WCAG 2.1 AA checks
 *
 * Automated checks (10):
 *   1.4.11  Non-text contrast (UI component borders)
 *   2.4.2   Page titled
 *   2.4.6   Headings and labels descriptive
 *   2.4.4   Link purpose in context          ← NEW
 *   2.5.3   Label in name                    ← NEW
 *   3.2.1   On focus — no unexpected context change
 *   3.2.2   On input — no unexpected context change
 *   3.3.2   Labels or instructions           ← NEW
 *   3.3.3   Error suggestion quality
 *   4.1.3   Status messages announced via aria-live
 *
 * Manual gaps flagged (7):
 *   1.2.1   Audio-only and video-only
 *   1.2.2   Captions (pre-recorded)
 *   1.2.5   Audio description (pre-recorded)
 *   2.2.1   Timing adjustable
 *   2.3.1   Three flashes or below threshold
 *   3.2.4   Consistent identification
 *   3.3.4   Error prevention (legal/financial)
 *
 * Add "wcagExtended" to checks[] in uxray.config.js to enable.
 */

import { join }      from "path";
import { mkdirSync } from "fs";

async function loadPage(page, url, route) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  if (route?.waitFor) await page.locator(route.waitFor).waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function screenshot(page, paths, id) {
  try {
    const file = join(paths.screenshots, `ext-${id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch { return null; }
}

// ─── 1.4.11 Non-text contrast ─────────────────────────────────────────────────
// UI components (inputs, buttons, checkboxes) need 3:1 contrast ratio
// between their visual boundary and adjacent colour.

async function checkNonTextContrast(page, route, paths, minRatio = 3.0) {
  const findings = [];

  const issues = await page.evaluate((min) => {
    const toL = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const lum = (r, g, b) => 0.2126 * toL(r) + 0.7152 * toL(g) + 0.0722 * toL(b);
    const parse = s => (s.match(/\d+/g) || []).map(Number);
    const ratio = (fg, bg) => {
      const [r1, g1, b1] = parse(fg), [r2, g2, b2] = parse(bg);
      const l1 = lum(r1, g1, b1), l2 = lum(r2, g2, b2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    const results = [];
    const sel = "input:not([type='hidden']), select, textarea, button, [role='checkbox'], [role='radio'], [role='switch']";

    document.querySelectorAll(sel).forEach(el => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const s = window.getComputedStyle(el);
      const border = s.borderColor;
      const pageBg = window.getComputedStyle(document.body).backgroundColor;

      if (border && pageBg && border !== "rgba(0, 0, 0, 0)") {
        const r = ratio(border, pageBg);
        if (r < min) {
          results.push({
            el: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.getAttribute("data-testid") ? `[data-testid=${el.getAttribute("data-testid")}]` : ""}`,
            type: "border vs page-background",
            border, pageBg,
            ratio: Math.round(r * 100) / 100,
            required: min,
          });
        }
      }
    });

    return results.slice(0, 10);
  }, minRatio);

  for (const iss of issues) {
    const ss = await screenshot(page, paths, `non-text-contrast-${route.path.replace(/\//g, "-")}`);
    findings.push({
      id: `ext-ntc-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "major",
      wcag: ["WCAG 1.4.11"],
      title: "Non-text contrast failure",
      description: `<${iss.el}> ${iss.type}: ratio ${iss.ratio} (need ${iss.required}). Border: ${iss.border}`,
      screenshot: ss,
    });
  }

  return findings;
}

// ─── 2.4.2 Page titled ────────────────────────────────────────────────────────
// Every page must have a descriptive <title> element.

async function checkPageTitle(page, route) {
  const findings = [];

  const { title, missing, generic } = await page.evaluate(() => {
    const t = document.title?.trim() ?? "";
    const genericTitles = ["untitled", "home", "page", "document", "index", "app", "react app", ""];
    return {
      title: t,
      missing: t.length === 0,
      generic: genericTitles.includes(t.toLowerCase()),
    };
  });

  if (missing) {
    findings.push({
      id: `ext-title-missing-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "critical",
      wcag: ["WCAG 2.4.2"],
      title: "Page has no <title> element",
      description: `Route "${route.path}" has no document title. Screen reader users and browser tab users cannot identify the page.`,
    });
  } else if (generic) {
    findings.push({
      id: `ext-title-generic-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "minor",
      wcag: ["WCAG 2.4.2"],
      title: "Page title is generic",
      description: `<title>${title}</title> is not descriptive. Each page should have a unique title describing its purpose.`,
    });
  }

  return findings;
}

// ─── 2.4.4 Link purpose in context ───────────────────────────────────────────
// Every link's purpose must be determinable from the link text alone,
// or from the link text + its surrounding context.
//
// axe-core's `link-name` only catches EMPTY links. This catches links with
// text that is present but non-descriptive ("click here", "read more", etc.).

async function checkLinkPurpose(page, route) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const VAGUE = new Set([
      "click here", "here", "read more", "more", "link", "this",
      "continue", "learn more", "see more", "go", "details",
      "info", "information", "page", "website", "url",
    ]);

    const results = [];

    document.querySelectorAll("a[href]").forEach(el => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const ariaLabel   = el.getAttribute("aria-label")?.trim().toLowerCase();
      const textContent = el.textContent?.trim().toLowerCase();
      const title       = el.getAttribute("title")?.trim().toLowerCase();
      const name        = ariaLabel || textContent || title || "";

      if (!name) return; // empty links caught by axe `link-name`

      if (VAGUE.has(name)) {
        results.push({
          text:      el.textContent?.trim().slice(0, 60) ?? "(no text)",
          href:      el.getAttribute("href")?.slice(0, 60) ?? "",
          ariaLabel: el.getAttribute("aria-label") ?? null,
        });
      }
    });

    return results.slice(0, 15);
  });

  for (const iss of issues) {
    findings.push({
      id:          `ext-link-purpose-${findings.length + 1}`,
      route:       route.path,
      source:      "wcagExtended",
      severity:    "minor",
      wcag:        ["WCAG 2.4.4"],
      title:       "Link text is not descriptive",
      description: `Link "${iss.text}" (href: ${iss.href}) is vague out of context. `
                 + `Screen reader users navigating by links list hear only "${iss.text}". `
                 + `Replace with descriptive text or add aria-label.`
                 + (iss.ariaLabel ? ` (current aria-label: "${iss.ariaLabel}")` : ""),
    });
  }

  return findings;
}

// ─── 2.4.6 Headings and labels descriptive ───────────────────────────────────
// Headings and labels must describe their topic or purpose.
// We flag: empty headings, very short headings, and known generic patterns.

async function checkDescriptiveHeadings(page, route) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const genericPatterns = [
      /^section\s*\d*$/i, /^heading\s*\d*$/i, /^title\s*\d*$/i,
      /^content$/i, /^main$/i, /^page\s*\d*$/i, /^untitled$/i,
    ];

    const results = [];
    document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']").forEach(el => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const text = el.textContent?.trim() ?? "";
      const level = el.tagName.match(/H(\d)/)?.[1] ?? el.getAttribute("aria-level") ?? "?";

      if (text.length === 0) {
        results.push({ level, text: "(empty)", issue: "Heading is empty — SR users hear nothing" });
      } else if (text.length < 3) {
        results.push({ level, text, issue: `Heading "${text}" is too short to be descriptive` });
      } else if (genericPatterns.some(p => p.test(text))) {
        results.push({ level, text, issue: `Heading "${text}" appears generic — not descriptive of content` });
      }
    });
    return results;
  });

  for (const iss of issues) {
    findings.push({
      id: `ext-heading-desc-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "minor",
      wcag: ["WCAG 2.4.6"],
      title: "Heading is not descriptive",
      description: `H${iss.level}: ${iss.issue}`,
    });
  }

  return findings;
}

// ─── 2.5.3 Label in name ──────────────────────────────────────────────────────
// When a UI component has a visible text label, its accessible name must
// CONTAIN that visible label. If aria-label overrides the visible text with
// something different, voice-control users who speak the visible label fail.

async function checkLabelInName(page, route) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const results = [];
    const sel = "button[aria-label], a[href][aria-label], [role='button'][aria-label], input[aria-label]";

    document.querySelectorAll(sel).forEach(el => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const ariaLabel   = (el.getAttribute("aria-label") ?? "").trim().toLowerCase();
      const visibleText = (el.textContent ?? el.getAttribute("value") ?? "").trim().toLowerCase();

      if (!visibleText || visibleText.length < 2) return;
      if (ariaLabel.includes(visibleText)) return; // passes

      results.push({
        tag:         el.tagName.toLowerCase(),
        visibleText: el.textContent?.trim().slice(0, 40) ?? "",
        ariaLabel:   el.getAttribute("aria-label")?.slice(0, 60) ?? "",
        testId:      el.getAttribute("data-testid") ?? "",
      });
    });

    return results.slice(0, 10);
  });

  for (const iss of issues) {
    findings.push({
      id:          `ext-label-in-name-${findings.length + 1}`,
      route:       route.path,
      source:      "wcagExtended",
      severity:    "major",
      wcag:        ["WCAG 2.5.3"],
      title:       "Accessible name does not contain visible label",
      description: `<${iss.tag}${iss.testId ? ` data-testid="${iss.testId}"` : ""}> `
                 + `is visually labelled "${iss.visibleText}" but aria-label is "${iss.ariaLabel}". `
                 + `Voice-control users saying "${iss.visibleText}" cannot activate this control. `
                 + `Fix: make aria-label start with or contain "${iss.visibleText}".`,
    });
  }

  return findings;
}

// ─── 3.2.1 On focus — no unexpected context change ───────────────────────────
// Focusing an element must not trigger navigation, form submission,
// or other unexpected context changes.

async function checkOnFocus(page, route, paths) {
  const findings = [];

  const focusable = await page.evaluate(() => {
    const sel = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
    return Array.from(document.querySelectorAll(sel))
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 20)
      .map((el, i) => ({ index: i, tag: el.tagName.toLowerCase(), testId: el.getAttribute("data-testid") ?? "", text: (el.textContent ?? "").trim().slice(0, 30) }));
  });

  for (const el of focusable) {
    const beforeUrl = page.url();

    await page.evaluate((idx) => {
      const sel = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
      const els = Array.from(document.querySelectorAll(sel)).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      els[idx]?.focus();
    }, el.index);

    await page.waitForTimeout(200);
    const afterUrl = page.url();

    if (afterUrl !== beforeUrl) {
      const ss = await screenshot(page, paths, `on-focus-${route.path.replace(/\//g, "-")}`);
      findings.push({
        id: `ext-onfocus-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "critical",
        wcag: ["WCAG 3.2.1"],
        title: "Focus causes unexpected navigation",
        description: `Focusing <${el.tag}> "${el.text}" changed URL from "${beforeUrl}" to "${afterUrl}" — unexpected context change on focus.`,
        screenshot: ss,
      });
      await page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await page.waitForTimeout(300);
      break;
    }
  }

  return findings;
}

// ─── 3.2.2 On input — no unexpected context change ───────────────────────────
// Changing a form control must not auto-submit or navigate without warning.

async function checkOnInput(page, route, paths) {
  const findings = [];

  const selects = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("select"))
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 5)
      .map((el, i) => ({
        index: i,
        id: el.id,
        testId: el.getAttribute("data-testid") ?? "",
        optionCount: el.options.length,
      }));
  });

  for (const sel of selects) {
    if (sel.optionCount < 2) continue;

    const beforeUrl = page.url();

    await page.evaluate((idx) => {
      const els = Array.from(document.querySelectorAll("select")).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const el = els[idx];
      if (!el || el.options.length < 2) return;
      el.value = el.options[1].value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sel.index);

    await page.waitForTimeout(400);
    const afterUrl = page.url();

    if (afterUrl !== beforeUrl) {
      const ss = await screenshot(page, paths, `on-input-${route.path.replace(/\//g, "-")}`);
      findings.push({
        id: `ext-oninput-${findings.length + 1}`,
        route: route.path,
        source: "wcagExtended",
        severity: "critical",
        wcag: ["WCAG 3.2.2"],
        title: "Input change causes unexpected navigation",
        description: `Changing <select${sel.id ? "#" + sel.id : ""}> triggered navigation to "${afterUrl}" without user confirmation — violates 3.2.2.`,
        screenshot: ss,
      });
      await page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await page.waitForTimeout(300);
      break;
    }
  }

  return findings;
}

// ─── 3.3.2 Labels or instructions ─────────────────────────────────────────────
// When user input is required, the form must provide labels or instructions
// sufficient to complete the field correctly.
//
// We check:
//   a) Required fields using ONLY a placeholder as their label
//      (placeholder disappears on input, not reliably announced by all SRs)
//   b) Date/phone/postcode inputs with no format hint

async function checkLabelsOrInstructions(page, route) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const results = [];
    const FORMAT_TYPES    = new Set(["date", "time", "datetime-local", "tel", "number", "email", "url"]);
    const FORMAT_PATTERNS = [/date/i, /phone/i, /postcode/i, /zip/i, /dob/i, /birth/i, /code/i];

    document.querySelectorAll("input, textarea, select").forEach(el => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (el.getAttribute("type") === "hidden") return;

      const isRequired  = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
      const hasLabel    = !!el.labels?.length || !!el.getAttribute("aria-label") || !!el.getAttribute("aria-labelledby");
      const placeholder = el.getAttribute("placeholder") ?? "";
      const inputType   = (el.getAttribute("type") ?? "text").toLowerCase();
      const name        = (el.getAttribute("name") ?? el.getAttribute("id") ?? "").toLowerCase();
      const testId      = el.getAttribute("data-testid") ?? "";

      // a) Required field with placeholder as its only label
      if (isRequired && !hasLabel && placeholder) {
        results.push({
          issue:       "placeholder-only-label",
          el:          el.tagName.toLowerCase(),
          testId,
          placeholder,
          description: `Required field uses placeholder "${placeholder}" as its only label. `
                     + `Placeholder disappears on input and is not reliably announced by screen readers. `
                     + `Add a visible <label> or aria-label.`,
        });
      }

      // b) Date/phone/format fields with no format hint
      const needsFormatHint = FORMAT_TYPES.has(inputType) || FORMAT_PATTERNS.some(p => p.test(name));
      if (needsFormatHint) {
        const describedBy = el.getAttribute("aria-describedby");
        const hasHintEl   = describedBy ? !!document.getElementById(describedBy) : false;
        const hintInLabel = placeholder.length > 4;

        if (!hasHintEl && !hintInLabel) {
          results.push({
            issue:       "missing-format-hint",
            el:          el.tagName.toLowerCase(),
            testId,
            inputType,
            name,
            description: `<${el.tagName.toLowerCase()} type="${inputType}"> "${name || testId}" `
                       + `requires a specific format but has no hint text or aria-describedby. `
                       + `Add visible hint text (e.g. "DD/MM/YYYY") linked via aria-describedby.`,
          });
        }
      }
    });

    return results.slice(0, 15);
  });

  for (const iss of issues) {
    findings.push({
      id:          `ext-labels-instr-${findings.length + 1}`,
      route:       route.path,
      source:      "wcagExtended",
      severity:    iss.issue === "placeholder-only-label" ? "major" : "minor",
      wcag:        ["WCAG 3.3.2"],
      title:       iss.issue === "placeholder-only-label"
                     ? "Required field uses placeholder as its only label"
                     : "Format field missing input instructions",
      description: iss.description,
    });
  }

  return findings;
}

// ─── 3.3.3 Error suggestion quality ──────────────────────────────────────────
// Error messages should tell users HOW to fix the problem, not just that
// there is one. We flag errors that contain only generic words.

async function checkErrorSuggestions(page, route, paths) {
  const findings = [];
  const hasForm = await page.evaluate(() => !!document.querySelector("form"));
  if (!hasForm) return findings;

  await page.evaluate(() => {
    const btn = document.querySelector("button[type='submit'],input[type='submit']");
    if (btn) btn.click();
  });
  await page.waitForTimeout(800);

  const issues = await page.evaluate(() => {
    const vague = new Set([
      "required", "invalid", "error", "field required",
      "this field is required", "please fill in", "fill this field",
      "this is required", "mandatory",
    ]);

    const errorEls = document.querySelectorAll(
      "[role='alert'], [aria-live='assertive'], .error, [class*='error'], [class*='invalid'], [class*='field-error']"
    );

    const results = [];
    errorEls.forEach(el => {
      const text = el.textContent?.trim().toLowerCase() ?? "";
      if (text && vague.has(text)) {
        results.push({
          text: el.textContent.trim().slice(0, 80),
          el: el.tagName.toLowerCase() + (el.className ? "." + el.className.toString().trim().split(/\s+/)[0] : ""),
        });
      }
    });
    return results;
  });

  for (const iss of issues) {
    const ss = await screenshot(page, paths, `error-suggest-${route.path.replace(/\//g, "-")}`);
    findings.push({
      id: `ext-err-suggest-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "minor",
      wcag: ["WCAG 3.3.3"],
      title: "Error message doesn't explain how to fix",
      description: `<${iss.el}> shows "${iss.text}" — too vague. Tell users what format or value is expected (e.g. "Enter a date in DD/MM/YYYY format").`,
      screenshot: ss,
    });
  }

  return findings;
}

// ─── 4.1.3 Status messages ────────────────────────────────────────────────────
// Actions that produce status messages must announce via role="status" or
// aria-live so SR users are informed without focus moving to the message.

async function checkStatusMessages(page, route, paths) {
  const findings = [];

  const liveRegions = await page.evaluate(() => {
    const regions = document.querySelectorAll("[role='status'],[role='alert'],[aria-live]");
    return Array.from(regions).map(el => ({
      role:   el.getAttribute("role") ?? "",
      live:   el.getAttribute("aria-live") ?? "",
      atomic: el.getAttribute("aria-atomic") ?? "",
      text:   el.textContent?.trim().slice(0, 60) ?? "",
      el:     el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""),
    }));
  });

  const actionButtons = await page.evaluate(() => {
    const actionWords = /save|delete|remove|submit|confirm|apply|update|create/i;
    return Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(el => actionWords.test(el.textContent ?? el.getAttribute("aria-label") ?? ""))
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 5)
      .map(el => (el.textContent ?? "").trim().slice(0, 40));
  });

  if (actionButtons.length > 0 && liveRegions.length === 0) {
    findings.push({
      id: `ext-status-${findings.length + 1}`,
      route: route.path,
      source: "wcagExtended",
      severity: "major",
      wcag: ["WCAG 4.1.3"],
      title: "No aria-live region for status messages",
      description: `Page has action buttons (${actionButtons.slice(0, 3).join(", ")}) but no role="status" or aria-live region. Success/error outcomes won't be announced to screen reader users.`,
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
        description: `<${region.el}> has role="alert" but aria-live="${region.live}" — mixing them can confuse screen readers.`,
      });
    }
  }

  return findings;
}

// ─── Manual gaps ──────────────────────────────────────────────────────────────

export function getExtendedManualGaps(route) {
  return [
    {
      id: "ext-manual-audio-only",
      route,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 1.2.1"],
      title: "[MANUAL] Audio-only and video-only content",
      description: "Check that audio-only content has a transcript and video-only content has a text alternative.",
    },
    {
      id: "ext-manual-captions",
      route,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 1.2.2"],
      title: "[MANUAL] Captions (pre-recorded)",
      description: "Check that all pre-recorded video includes accurate closed captions.",
    },
    {
      id: "ext-manual-audio-desc",
      route,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 1.2.5"],
      title: "[MANUAL] Audio description (pre-recorded)",
      description: "Check that pre-recorded video has an audio description track describing visual-only information.",
    },
    {
      id: "ext-manual-seizures",
      route,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 2.3.1"],
      title: "[MANUAL] Three flashes or below threshold",
      description: "Check that no content flashes more than 3 times per second. Requires visual inspection — cannot be automated.",
    },
    {
      id: "ext-manual-timing",
      route,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 2.2.1"],
      title: "[MANUAL] Timing adjustable",
      description: "If any timed session or content exists, verify users can turn off, adjust, or extend the time limit.",
    },
    {
      id: "ext-manual-consistent-id",
      route,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 3.2.4"],
      title: "[MANUAL] Consistent identification",
      description: "Verify components with the same function are identified consistently across pages (e.g. search icon always labelled 'Search').",
    },
    {
      id: "ext-manual-error-prevention",
      route,
      source: "manual-required",
      severity: "manual",
      wcag: ["WCAG 3.3.4"],
      title: "[MANUAL] Error prevention (legal/financial)",
      description: "For forms involving legal or financial data, verify submissions are reversible, checkable, or confirmed before final commit.",
    },
  ];
}

// ─── Run all extended checks ──────────────────────────────────────────────────

export async function runWcagExtendedChecks(browser, cfg, paths) {
  const findings = [];
  const baseUrl  = process.env.BASE_URL ?? cfg.baseUrl;
  const minNonTextContrast = cfg.thresholds?.nonTextContrast ?? 3.0;
  mkdirSync(paths.screenshots, { recursive: true });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await context.newPage();

  for (const route of cfg.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   ext  ${route.name.padEnd(16)}`);
    let count = 0;

    try {
      await loadPage(page, url, route);

      const results = await Promise.allSettled([
        checkNonTextContrast(page, route, paths, minNonTextContrast),
        checkPageTitle(page, route),
        checkDescriptiveHeadings(page, route),
        checkLinkPurpose(page, route),
        checkLabelInName(page, route),
        checkLabelsOrInstructions(page, route),
        checkOnFocus(page, route, paths),
        checkOnInput(page, route, paths),
        checkErrorSuggestions(page, route, paths),
        checkStatusMessages(page, route, paths),
      ]);

      for (const result of results) {
        if (result.status === "fulfilled") {
          findings.push(...result.value);
          count += result.value.length;
        }
      }

      const manualGaps = getExtendedManualGaps(route.path);
      findings.push(...manualGaps);

      console.log(`→ ${count} issue(s) + ${manualGaps.length} manual gaps`);
    } catch (err) {
      console.log(`→ ⚠ ${err.message.split("\n")[0]}`);
    }
  }

  await context.close();
  return findings;
}
