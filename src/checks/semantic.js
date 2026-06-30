import { join } from "path";
import { mkdirSync } from "fs";
import { createAuthenticatedContext, navigateAuthenticated } from "../context.js";

/**
 * Semantic quality checks — heuristic analysis beyond what axe-core covers.
 *
 * axe catches *missing* alt text. This module catches *bad* alt text.
 * axe catches empty links. This module catches ambiguous links in document context.
 * These checks surface quality issues that automated rule engines cannot express.
 */

async function takeScreenshot(page, screenshotsDir, name) {
  try {
    const filePath = join(screenshotsDir, `sem-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

// ─── Alt Text Quality ─────────────────────────────────────────────────────────

async function checkAltTextQuality(page, route, paths) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const MEANINGLESS_ALT = new Set([
      "image", "photo", "picture", "img", "icon", "logo", "graphic",
      "figure", "thumbnail", "banner", "spacer", "placeholder",
      "avatar", "chart", "graph", "diagram",
    ]);

    // Pattern that looks like a filename: word.ext or path/word.ext
    const FILENAME_RE = /\.(jpe?g|png|gif|svg|webp|avif|bmp|tiff?)$/i;
    // Starts with a numeric ID like "IMG_1234" or "DSC00001"
    const NUMERIC_ID_RE = /^(IMG|DSC|DCIM|DSF|_MG|photo|image|pic)\s*[\d_-]+/i;

    const results = [];

    document.querySelectorAll("img[alt]").forEach((img) => {
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const alt       = img.getAttribute("alt") ?? "";
      const src       = (img.getAttribute("src") ?? "").split("/").pop() ?? "";
      const isDecor   = alt === "";           // empty alt = decorative, skip
      if (isDecor) return;

      const altLower  = alt.trim().toLowerCase();
      let issue = null;

      if (altLower.length === 1) {
        issue = `alt="${alt}" is a single character — not a meaningful description`;
      } else if (MEANINGLESS_ALT.has(altLower)) {
        issue = `alt="${alt}" is a generic noun that describes the media type, not the content`;
      } else if (FILENAME_RE.test(altLower) || NUMERIC_ID_RE.test(alt)) {
        issue = `alt="${alt}" looks like a filename — replace with a description of what the image shows`;
      } else if (alt.length > 150) {
        issue = `alt text is ${alt.length} characters — consider using aria-describedby for long descriptions and a short alt`;
      } else if (/^(click|tap|press|button|link)\b/i.test(alt)) {
        issue = `alt="${alt.slice(0, 60)}" starts with an action word — alt text should describe what the image depicts, not what to do`;
      }

      if (issue) {
        results.push({
          src:   src.slice(0, 60),
          alt:   alt.slice(0, 80),
          issue,
        });
      }
    });

    return results.slice(0, 10);
  });

  for (const item of issues) {
    const screenshotPath = await takeScreenshot(
      page, paths.screenshots, `alt-${route.path.replace(/\//g, "-")}`
    );
    findings.push({
      id:          `sem-alt-${findings.length + 1}`,
      route:       route.path,
      source:      "semantic",
      severity:    "major",
      wcag:        ["WCAG 1.1.1"],
      title:       "Poor quality alt text",
      description: `<img src="${item.src}"> — ${item.issue}`,
      screenshot:  screenshotPath,
    });
  }

  return findings;
}

// ─── Duplicate Link Text (same label, different destination) ──────────────────

async function checkDuplicateLinkText(page, route) {
  const findings = [];

  const ambiguous = await page.evaluate(() => {
    const linkMap = new Map();

    document.querySelectorAll("a[href]").forEach((link) => {
      const rect = link.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const name = (
        link.getAttribute("aria-label") ||
        link.textContent ||
        link.getAttribute("title") ||
        ""
      ).trim().toLowerCase().replace(/\s+/g, " ");

      const href = link.getAttribute("href") ?? "";
      if (!name || name.length < 2) return;

      if (!linkMap.has(name)) linkMap.set(name, new Set());
      linkMap.get(name).add(href);
    });

    const results = [];
    for (const [name, hrefs] of linkMap.entries()) {
      if (hrefs.size > 1) {
        results.push({
          text:         name.slice(0, 50),
          destinations: [...hrefs].slice(0, 4).map((h) => h.slice(0, 60)),
        });
      }
    }

    return results.slice(0, 5);
  });

  for (const item of ambiguous) {
    findings.push({
      id:          `sem-duplink-${findings.length + 1}`,
      route:       route.path,
      source:      "semantic",
      severity:    "major",
      wcag:        ["WCAG 2.4.4", "WCAG 2.4.9"],
      title:       "Same link text leads to different destinations",
      description:
        `"${item.text}" is used as the visible label for ${item.destinations.length} different links. ` +
        `Screen reader users navigating by links list cannot tell them apart. ` +
        `Destinations: ${item.destinations.join(" | ")}. ` +
        `Fix: make each link label unique or add aria-label with context.`,
    });
  }

  return findings;
}

// ─── Icon-only buttons without accessible names ────────────────────────────────

async function checkIconOnlyControls(page, route, paths) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const results = [];

    // Unicode ranges for common icon fonts / emoji
    const ICON_ONLY_RE = /^[\u{1F000}-\u{1FFFF}\u{2000}-\u{27FF}\u{E000}-\u{F8FF}×✕✖✗✘←→↑↓⟨⟩‹›«»☰≡⊕⊗]+$/u;

    document.querySelectorAll("button, [role='button'], [role='link']").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const ariaLabel    = el.getAttribute("aria-label")?.trim();
      const ariaLabelledBy = el.getAttribute("aria-labelledby");
      const title        = el.getAttribute("title")?.trim();
      const visibleText  = (el.textContent ?? "").trim();

      // Already has a non-visual accessible name — fine
      if (ariaLabel || ariaLabelledBy || title) return;

      // Has real visible text — fine
      if (visibleText.length > 1 && !ICON_ONLY_RE.test(visibleText)) return;

      // Has a child img with alt — fine
      const imgAlt = el.querySelector("img[alt]")?.getAttribute("alt");
      if (imgAlt && imgAlt.trim()) return;

      // Has SVG with title — fine
      const svgTitle = el.querySelector("svg title")?.textContent?.trim();
      if (svgTitle) return;

      results.push({
        tag:    el.tagName.toLowerCase(),
        testId: el.getAttribute("data-testid") ?? "",
        text:   visibleText.slice(0, 30),
        cls:    (el.className ?? "").toString().slice(0, 40),
      });
    });

    return results.slice(0, 10);
  });

  for (const item of issues) {
    const screenshotPath = await takeScreenshot(
      page, paths.screenshots, `icon-btn-${route.path.replace(/\//g, "-")}`
    );
    findings.push({
      id:          `sem-icon-${findings.length + 1}`,
      route:       route.path,
      source:      "semantic",
      severity:    "critical",
      wcag:        ["WCAG 4.1.2", "WCAG 1.1.1"],
      title:       "Icon-only control has no accessible name",
      description:
        `<${item.tag}${item.testId ? ` data-testid="${item.testId}"` : ""}> ` +
        `"${item.text || "(icon only)"}" has no aria-label, aria-labelledby, title, or visible text. ` +
        `Screen reader users will hear only the role with no context. ` +
        `Fix: add aria-label="Descriptive action" or a visually-hidden <span>.`,
      screenshot:  screenshotPath,
    });
  }

  return findings;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function runSemanticChecks(browser, config, paths) {
  const findings = [];
  const baseUrl  = process.env.BASE_URL || config.baseUrl;

  mkdirSync(paths.screenshots, { recursive: true });

  const context = await createAuthenticatedContext(browser, config);
  const page    = await context.newPage();

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   sem  ${route.name.padEnd(16)}`);

    let issueCount = 0;

    try {
      await navigateAuthenticated(page, url, config, route.waitFor);

      for (const check of [
        () => checkAltTextQuality(page, route, paths),
        () => checkDuplicateLinkText(page, route),
        () => checkIconOnlyControls(page, route, paths),
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
