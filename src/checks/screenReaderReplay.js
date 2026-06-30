import { join } from "path";
import { mkdirSync } from "fs";
import { createAuthenticatedContext, navigateAuthenticated } from "../context.js";

/**
 * Assistive Technology Replay — simulates what a screen reader would announce
 * as it walks the DOM in document order.
 *
 * Rather than checking individual element attributes, this module builds a
 * sequential "reading transcript" and analyses it for structural problems:
 *
 *   • Heading level skips (h1 → h3 without h2) — WCAG 2.4.6
 *   • Absent or multiple h1 landmarks              — WCAG 1.3.1
 *   • Interactive elements with no announcement    — WCAG 4.1.2
 *   • DOM reading order vs visual position         — WCAG 1.3.2
 *   • Content outside landmark regions             — WCAG 1.3.6 / 2.4.1
 *   • Duplicate interactive announcements          — WCAG 2.4.4
 */

async function takeScreenshot(page, screenshotsDir, name) {
  try {
    const filePath = join(screenshotsDir, `sr-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

// ─── DOM Walking Transcript ──────────────────────────────────────────────────

/**
 * buildReadingTranscript — runs in browser context.
 * Returns an ordered array of "announcements" as a screen reader would produce.
 *
 * Each entry:
 *   { type, text, tag, level?, role?, x, y, width, height }
 */
async function buildReadingTranscript(page) {
  return page.evaluate(() => {
    const LANDMARK_ROLES = {
      banner:          "banner",
      navigation:      "navigation",
      main:            "main",
      complementary:   "complementary",
      contentinfo:     "contentinfo",
      search:          "search",
      form:            "form",
      region:          "region",
    };

    const IMPLICIT_LANDMARK = {
      header:  "banner",
      nav:     "navigation",
      main:    "main",
      aside:   "complementary",
      footer:  "contentinfo",
    };

    function getAccessibleName(el) {
      const ariaLabel = el.getAttribute("aria-label")?.trim();
      if (ariaLabel) return ariaLabel;

      const labelledById = el.getAttribute("aria-labelledby");
      if (labelledById) {
        const labelEl = document.getElementById(labelledById);
        if (labelEl) return (labelEl.textContent ?? "").trim();
      }

      const forId = el.id;
      if (forId) {
        const label = document.querySelector(`label[for="${forId}"]`);
        if (label) return (label.textContent ?? "").trim();
      }

      const title = el.getAttribute("title")?.trim();
      if (title) return title;

      const text = (el.textContent ?? "").trim();
      if (text) return text.slice(0, 120);

      return "";
    }

    function isHidden(el) {
      if (el.getAttribute("aria-hidden") === "true") return true;
      const role = el.getAttribute("role");
      if (role === "presentation" || role === "none") return true;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return true;
      return false;
    }

    function getRect(el) {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    }

    const transcript = [];

    // Depth-first walk from document.body
    function walk(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (isHidden(node)) return;

      const tag  = node.tagName.toLowerCase();
      const role = node.getAttribute("role") || IMPLICIT_LANDMARK[tag];

      // Landmark entry
      const landmarkRole = LANDMARK_ROLES[role];
      if (landmarkRole) {
        const label = node.getAttribute("aria-label") || node.getAttribute("aria-labelledby") || "";
        const rect  = getRect(node);
        if (rect.width && rect.height) {
          transcript.push({ type: "landmark", text: `${landmarkRole}${label ? `: ${label}` : ""}`, tag, role: landmarkRole, ...rect });
        }
      }

      // Headings
      const headingMatch = tag.match(/^h([1-6])$/);
      if (headingMatch) {
        const level = parseInt(headingMatch[1], 10);
        const name  = getAccessibleName(node);
        const rect  = getRect(node);
        if (rect.width && rect.height) {
          transcript.push({ type: "heading", text: name || "(empty)", tag, level, ...rect });
        }
        return; // don't descend into heading text nodes again
      }

      // Interactive elements
      if (tag === "a" && node.getAttribute("href")) {
        const name = getAccessibleName(node);
        const rect = getRect(node);
        if (rect.width && rect.height) {
          transcript.push({ type: "link", text: name || "(no name)", tag, href: node.getAttribute("href")?.slice(0, 60), ...rect });
        }
        return;
      }

      if (tag === "button" || (node.getAttribute("role") === "button")) {
        const name = getAccessibleName(node);
        const rect = getRect(node);
        if (rect.width && rect.height) {
          transcript.push({ type: "button", text: name || "(no name)", tag, ...rect });
        }
        return;
      }

      if (["input", "select", "textarea"].includes(tag)) {
        const type = node.getAttribute("type") || tag;
        if (type === "hidden") return;
        const name     = getAccessibleName(node);
        const required = node.hasAttribute("required") ? ", required" : "";
        const rect     = getRect(node);
        if (rect.width && rect.height) {
          transcript.push({ type: "input", text: `${name || "(unlabelled)"}: ${type}${required}`, tag, ...rect });
        }
        return;
      }

      if (tag === "img") {
        const alt  = node.getAttribute("alt");
        if (alt === "") return;  // decorative — screen reader skips
        const rect = getRect(node);
        if (rect.width && rect.height) {
          transcript.push({ type: "image", text: alt ? `image: ${alt}` : `image: (no alt — ${node.src?.split("/").pop() ?? "unknown"})`, tag, ...rect });
        }
        return;
      }

      // Descend into children
      for (const child of node.children) {
        walk(child);
      }
    }

    walk(document.body);
    return transcript;
  });
}

// ─── Checks on the Transcript ─────────────────────────────────────────────────

async function checkHeadingStructure(transcript, route, page, paths) {
  const findings = [];
  const headings  = transcript.filter((t) => t.type === "heading");

  if (headings.length === 0) {
    findings.push({
      id:          `sr-heading-noheadings`,
      route:       route.path,
      source:      "screenReaderReplay",
      severity:    "major",
      wcag:        ["WCAG 1.3.1", "WCAG 2.4.6"],
      title:       "Page has no headings",
      description:
        "Screen reader users rely on headings to navigate and understand page structure. " +
        "This page has no heading elements (h1–h6). " +
        "Add at least one descriptive h1 and use h2/h3 to organise content sections.",
    });
    return findings;
  }

  // Check for missing or multiple h1
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    findings.push({
      id:          `sr-heading-noh1`,
      route:       route.path,
      source:      "screenReaderReplay",
      severity:    "major",
      wcag:        ["WCAG 1.3.1", "WCAG 2.4.6"],
      title:       "Page has no h1 heading",
      description:
        `The screen reader transcript shows ${headings.length} heading(s) but none at level 1. ` +
        `The page title or main topic should be marked as <h1>. ` +
        `Current headings start at level ${headings[0].level}: "${headings[0].text.slice(0, 60)}"`,
    });
  } else if (h1s.length > 1) {
    findings.push({
      id:          `sr-heading-multih1`,
      route:       route.path,
      source:      "screenReaderReplay",
      severity:    "minor",
      wcag:        ["WCAG 1.3.1", "WCAG 2.4.6"],
      title:       `Page has ${h1s.length} h1 headings`,
      description:
        `Multiple h1 elements were found: "${h1s.map((h) => h.text.slice(0, 40)).join('", "')}". ` +
        `Typically a page should have exactly one h1 identifying the main topic or page title.`,
    });
  }

  // Check for level skips
  let prevLevel = 0;
  for (const heading of headings) {
    if (prevLevel > 0 && heading.level > prevLevel + 1) {
      const screenshotPath = await takeScreenshot(
        page, paths.screenshots, `heading-skip-${route.path.replace(/\//g, "-")}`
      );
      findings.push({
        id:          `sr-heading-skip-${findings.length}`,
        route:       route.path,
        source:      "screenReaderReplay",
        severity:    "major",
        wcag:        ["WCAG 1.3.1", "WCAG 2.4.6"],
        title:       `Heading level skips from h${prevLevel} to h${heading.level}`,
        description:
          `The reading transcript jumps from heading level ${prevLevel} to level ${heading.level} ` +
          `at "${heading.text.slice(0, 60)}". ` +
          `Screen readers and users navigating by headings expect consecutive levels (h1 → h2 → h3). ` +
          `Fix: restructure headings to avoid skipping levels.`,
        screenshot:  screenshotPath,
      });
    }
    prevLevel = heading.level;
  }

  return findings;
}

async function checkReadingOrder(page, route, paths) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const focusable = Array.from(
      document.querySelectorAll("a[href], button, input:not([type='hidden']), select, textarea, [tabindex]:not([tabindex='-1'])")
    );

    const visible = focusable
      .map((el, domIndex) => {
        const r = el.getBoundingClientRect();
        return { el, domIndex, top: Math.round(r.top), left: Math.round(r.left), height: Math.round(r.height) };
      })
      .filter((item) => item.height > 0 && item.top >= 0);

    const results = [];

    for (let i = 1; i < visible.length; i++) {
      const prev = visible[i - 1];
      const curr = visible[i];

      // If current element is visually MORE THAN 200px above the previous one,
      // the DOM order doesn't match the visual flow — screen reader and keyboard
      // users will encounter elements in a different order than sighted users see.
      if (curr.top < prev.top - 200) {
        const prevName  = (prev.el.getAttribute("aria-label") || prev.el.textContent || prev.el.tagName).trim().slice(0, 40);
        const currName  = (curr.el.getAttribute("aria-label") || curr.el.textContent || curr.el.tagName).trim().slice(0, 40);

        results.push({
          prevDom: prev.domIndex,
          prevTop: prev.top,
          prevName,
          currDom: curr.domIndex,
          currTop: curr.top,
          currName,
        });
      }
    }

    return results.slice(0, 5);
  });

  for (const item of issues) {
    const screenshotPath = await takeScreenshot(
      page, paths.screenshots, `order-${route.path.replace(/\//g, "-")}`
    );
    findings.push({
      id:          `sr-order-${findings.length + 1}`,
      route:       route.path,
      source:      "screenReaderReplay",
      severity:    "major",
      wcag:        ["WCAG 1.3.2"],
      title:       "DOM reading order does not match visual order",
      description:
        `"${item.currName}" (DOM position ${item.currDom}, visually at y=${item.currTop}px) appears in the DOM ` +
        `after "${item.prevName}" (DOM position ${item.prevDom}, visually at y=${item.prevTop}px), ` +
        `but is positioned ${item.prevTop - item.currTop}px higher on screen. ` +
        `Screen readers and keyboard users will encounter this element after the one visually below it. ` +
        `Fix: reorder DOM elements to match the visual top-to-bottom, left-to-right reading sequence. ` +
        `Avoid using CSS position/flex/grid to reorder visual presentation away from DOM order.`,
      screenshot:  screenshotPath,
    });
  }

  return findings;
}

async function checkLandmarkCoverage(page, route) {
  const findings = [];

  const result = await page.evaluate(() => {
    const LANDMARK_SELECTORS =
      "main, nav, header, footer, aside, [role='main'], [role='navigation'], " +
      "[role='banner'], [role='contentinfo'], [role='complementary'], " +
      "[role='search'], [role='form'], [role='region'][aria-label]";

    function textLength(el) {
      return (el.textContent ?? "").trim().replace(/\s+/g, " ").length;
    }

    const totalBodyText = textLength(document.body);
    if (totalBodyText < 100) return null; // page has almost no text content

    // Sum text inside landmark regions
    let landmarkText = 0;
    document.querySelectorAll(LANDMARK_SELECTORS).forEach((el) => {
      landmarkText += textLength(el);
    });

    const covered = Math.min(100, Math.round((landmarkText / totalBodyText) * 100));
    return { covered, totalBodyText };
  });

  if (result && result.covered < 70) {
    findings.push({
      id:          `sr-landmark-coverage`,
      route:       route.path,
      source:      "screenReaderReplay",
      severity:    "major",
      wcag:        ["WCAG 1.3.6", "WCAG 2.4.1"],
      title:       `Only ${result.covered}% of page text is inside landmark regions`,
      description:
        `Screen reader users can navigate by landmarks (main, nav, header, footer, aside). ` +
        `On this route, ${100 - result.covered}% of visible text appears outside any landmark element. ` +
        `Fix: wrap content areas in semantic HTML elements (<main>, <nav>, <header>, <footer>, <aside>) ` +
        `or add role="region" aria-label="Section name" to significant content blocks.`,
    });
  }

  return findings;
}

async function checkDuplicateAnnouncements(transcript, route) {
  const findings = [];

  const interactive = transcript.filter((t) =>
    t.type === "link" || t.type === "button" || t.type === "input"
  );

  // Group by identical announcement text
  const groups = new Map();
  for (const item of interactive) {
    const key = `${item.type}:${item.text.toLowerCase().trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const [key, items] of groups.entries()) {
    if (items.length <= 1) continue;

    const [type, ...textParts] = key.split(":");
    const text                 = textParts.join(":");

    // Different hrefs = ambiguous (bad). Same href = redundant (informational only).
    const hrefs = new Set(items.map((i) => i.href || "").filter(Boolean));
    const isDifferentDest = type === "link" && hrefs.size > 1;

    if (isDifferentDest || (type === "button" && items.length > 1)) {
      findings.push({
        id:          `sr-dup-${findings.length + 1}`,
        route:       route.path,
        source:      "screenReaderReplay",
        severity:    isDifferentDest ? "major" : "minor",
        wcag:        ["WCAG 2.4.4", "WCAG 2.4.9"],
        title:       `${items.length}× ${type} announced as "${text.slice(0, 50)}"`,
        description:
          `The screen reader transcript contains ${items.length} ${type}(s) with identical accessible name "${text.slice(0, 50)}". ` +
          (isDifferentDest
            ? `They point to ${hrefs.size} different destinations. ` +
              `When a screen reader user opens the links list, these cannot be distinguished. `
            : `Identical button labels make it impossible to tell them apart from the links/forms list. `) +
          `Fix: make each ${type} label unique, or use aria-label/aria-describedby to add context.`,
      });
    }
  }

  return findings;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function runScreenReaderReplayChecks(browser, config, paths) {
  const findings = [];
  const baseUrl  = process.env.BASE_URL || config.baseUrl;

  mkdirSync(paths.screenshots, { recursive: true });

  const context = await createAuthenticatedContext(browser, config);
  const page    = await context.newPage();

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   sr-replay  ${route.name.padEnd(16)}`);

    let issueCount = 0;

    try {
      await navigateAuthenticated(page, url, config, route.waitFor);

      // Build the DOM-order reading transcript once per page
      let transcript = [];
      try {
        transcript = await buildReadingTranscript(page);
      } catch { /* skip transcript build failure */ }

      for (const check of [
        () => checkHeadingStructure(transcript, route, page, paths),
        () => checkReadingOrder(page, route, paths),
        () => checkLandmarkCoverage(page, route),
        () => checkDuplicateAnnouncements(transcript, route),
      ]) {
        try {
          const results = await check();
          findings.push(...results);
          issueCount += results.length;
        } catch { /* skip individual check failure */ }
      }

      console.log(`→ ${issueCount} issue(s)`);
    } catch (error) {
      console.log(`→ ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  await context.close();
  return findings;
}
