import { join } from "path";
import { mkdirSync } from "fs";
import { createAuthenticatedContext, navigateAuthenticated } from "../context.js";

/**
 * Cognitive accessibility checks — WCAG 3.1.x / 3.3.x and plain-language best practices.
 *
 * Automated tools cannot evaluate meaning, but they can detect patterns that
 * reliably predict cognitive difficulty: long sentences, complex instructions,
 * sensory references, and unexpanded abbreviations.
 *
 * Reading level target: WCAG AAA recommends ≤ 8th grade (Flesch score ≥ 60).
 * Even at AA, unusually low readability on instructional content is a red flag.
 */

async function takeScreenshot(page, screenshotsDir, name) {
  try {
    const filePath = join(screenshotsDir, `cog-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

// ─── Readability (Flesch-Kincaid) ─────────────────────────────────────────────

async function checkReadability(page, route) {
  const findings = [];

  const results = await page.evaluate(() => {
    /**
     * Approximate syllable count using vowel-group heuristic.
     * Accurate to ±10% for English text — sufficient for a readability flag.
     */
    function countSyllables(word) {
      const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
      if (cleaned.length <= 3) return 1;
      const groups   = cleaned.match(/[aeiouy]+/g) ?? [];
      let count      = groups.length;
      if (cleaned.endsWith("e") && count > 1) count--;  // silent trailing -e
      return Math.max(1, count);
    }

    function gradeLabel(score) {
      if (score >= 90) return "5th grade (very easy)";
      if (score >= 70) return "6th grade (easy)";
      if (score >= 60) return "7th–8th grade (standard)";
      if (score >= 50) return "10th–12th grade (fairly difficult)";
      if (score >= 30) return "college level (difficult)";
      return "professional/technical (very confusing)";
    }

    const issues = [];

    // Analyse each visible <p> with substantial text
    document.querySelectorAll("p, li, td, th, label, [role='status'], [role='alert']").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const text = (el.textContent ?? "").trim();
      if (text.length < 80) return;  // too short to be meaningful

      const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
      const words     = text.split(/\s+/).filter((w) => w.trim().length > 0);
      if (sentences.length === 0 || words.length < 15) return;

      const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
      const asl       = words.length / sentences.length;       // avg sentence length
      const asw       = syllables  / words.length;             // avg syllables per word
      const score     = 206.835 - (1.015 * asl) - (84.6 * asw);
      const rounded   = Math.round(score);

      if (rounded < 50) {  // flag "fairly difficult" and worse
        issues.push({
          score:   rounded,
          level:   gradeLabel(rounded),
          asl:     Math.round(asl),
          excerpt: text.slice(0, 100),
          tag:     el.tagName.toLowerCase(),
        });
      }
    });

    // Deduplicate by excerpt prefix so the same repeated CMS block doesn't spam
    const seen = new Set();
    return issues
      .filter((item) => {
        const key = item.excerpt.slice(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5);
  });

  for (const item of results) {
    findings.push({
      id:          `cog-read-${findings.length + 1}`,
      route:       route.path,
      source:      "cognitive",
      severity:    item.score < 30 ? "major" : "minor",
      wcag:        ["WCAG 3.1.5"],
      title:       `Reading level too high (Flesch score ${item.score})`,
      description:
        `<${item.tag}> "${item.excerpt}…" scores ${item.score} (${item.level}). ` +
        `Average sentence length: ${item.asl} words. ` +
        `WCAG 3.1.5 recommends content readable at lower secondary level. ` +
        `Shorten sentences, prefer common words, and break complex ideas into steps.`,
    });
  }

  return findings;
}

// ─── Sensory Characteristics (WCAG 1.3.3) ─────────────────────────────────────

async function checkSensoryCharacteristics(page, route, paths) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const SENSORY_PATTERNS = [
      { re: /\b(above|below|to the (left|right)|on the (left|right)( side)?)\b/gi,       type: "position" },
      { re: /\b(the )?(red|green|blue|yellow|orange|purple|grey|gray|pink|white|black)\s+(box|button|link|icon|area|section|field|text|label|form|panel)\b/gi, type: "color" },
      { re: /\b(the )?(round|circular|square|triangular|diamond[-\s]shaped)\s+(button|icon|element)\b/gi, type: "shape" },
      { re: /\bsee (the )?(image|figure|diagram|chart|photo|screenshot|picture) (above|below|to the (left|right))\b/gi, type: "position+visual" },
    ];

    const results = [];

    document.querySelectorAll("p, li, label, td, [role='alert'], h1, h2, h3, h4, h5, h6").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const text = (el.textContent ?? "").trim();
      if (!text) return;

      for (const { re, type } of SENSORY_PATTERNS) {
        const match = re.exec(text);
        if (match) {
          results.push({
            type,
            match:   match[0].slice(0, 60),
            excerpt: text.slice(0, 100),
            tag:     el.tagName.toLowerCase(),
          });
          break;
        }
      }
    });

    return results.slice(0, 8);
  });

  for (const item of issues) {
    const screenshotPath = await takeScreenshot(
      page, paths.screenshots, `sensory-${route.path.replace(/\//g, "-")}`
    );
    findings.push({
      id:          `cog-sensory-${findings.length + 1}`,
      route:       route.path,
      source:      "cognitive",
      severity:    "major",
      wcag:        ["WCAG 1.3.3"],
      title:       `Instruction relies on ${item.type} (sensory characteristic)`,
      description:
        `"${item.excerpt}…" uses "${item.match}" to identify an element by ${item.type} alone. ` +
        `WCAG 1.3.3: instructions must not rely solely on shape, size, visual location, or color. ` +
        `Fix: add a text label or reference the element by name ("the Submit button") in addition to its position or color.`,
      screenshot:  screenshotPath,
    });
  }

  return findings;
}

// ─── Unexpanded Abbreviations (WCAG 3.1.4) ────────────────────────────────────

async function checkAbbreviations(page, route) {
  const findings = [];

  const issues = await page.evaluate(() => {
    // Common abbreviations that should be wrapped in <abbr> or expanded on first use
    const COMMON_ABBR = [
      "TBD", "TBC", "ETA", "FAQ", "SLA", "CTA", "KPI", "ROI", "B2B", "B2C",
      "API", "UI", "UX", "CMS", "CRM", "ERP", "PII", "GDPR", "WCAG", "PDF",
    ];

    const ABBR_RE = new RegExp(`\\b(${COMMON_ABBR.join("|")})\\b`, "g");

    const results = [];
    const foundAbbrs = new Set();

    // Collect <abbr> elements already on page
    const expandedAbbrs = new Set(
      Array.from(document.querySelectorAll("abbr")).map((el) => el.textContent?.trim().toUpperCase())
    );

    document.querySelectorAll("p, li, td, th, [role='alert'], h1, h2, h3, h4, h5, h6").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const text = (el.textContent ?? "");
      let match;
      while ((match = ABBR_RE.exec(text)) !== null) {
        const abbr = match[1];
        if (!expandedAbbrs.has(abbr) && !foundAbbrs.has(abbr)) {
          foundAbbrs.add(abbr);
          results.push({ abbr, excerpt: text.slice(Math.max(0, match.index - 20), match.index + 40) });
        }
      }
    });

    return results.slice(0, 6);
  });

  for (const item of issues) {
    findings.push({
      id:          `cog-abbr-${findings.length + 1}`,
      route:       route.path,
      source:      "cognitive",
      severity:    "minor",
      wcag:        ["WCAG 3.1.4"],
      title:       `Abbreviation "${item.abbr}" not expanded`,
      description:
        `"${item.abbr}" appears in "…${item.excerpt}…" without expansion or an <abbr title="..."> element. ` +
        `WCAG 3.1.4: provide the expanded form on first use. ` +
        `Fix: use <abbr title="Full meaning">${item.abbr}</abbr> or write out the full phrase on first occurrence.`,
    });
  }

  return findings;
}

// ─── Long paragraphs ──────────────────────────────────────────────────────────

async function checkLongContent(page, route) {
  const findings = [];

  const issues = await page.evaluate(() => {
    const results = [];

    document.querySelectorAll("p").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const text  = (el.textContent ?? "").trim();
      const words = text.split(/\s+/).filter(Boolean);

      if (words.length > 80) {
        results.push({ words: words.length, excerpt: text.slice(0, 100) });
      }
    });

    return results.slice(0, 5);
  });

  for (const item of issues) {
    findings.push({
      id:          `cog-long-${findings.length + 1}`,
      route:       route.path,
      source:      "cognitive",
      severity:    "minor",
      wcag:        ["WCAG 3.1.5"],
      title:       `Paragraph is ${item.words} words — too long for easy scanning`,
      description:
        `"${item.excerpt}…" has ${item.words} words in a single paragraph. ` +
        `Cognitive accessibility best practice: keep paragraphs under 80 words. ` +
        `Break into shorter paragraphs, use lists for multi-part content, or add subheadings.`,
    });
  }

  return findings;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function runCognitiveChecks(browser, config, paths) {
  const findings = [];
  const baseUrl  = process.env.BASE_URL || config.baseUrl;

  mkdirSync(paths.screenshots, { recursive: true });

  const context = await createAuthenticatedContext(browser, config);
  const page    = await context.newPage();

  for (const route of config.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   cog  ${route.name.padEnd(16)}`);

    let issueCount = 0;

    try {
      await navigateAuthenticated(page, url, config, route.waitFor);

      for (const check of [
        () => checkReadability(page, route),
        () => checkSensoryCharacteristics(page, route, paths),
        () => checkAbbreviations(page, route),
        () => checkLongContent(page, route),
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
