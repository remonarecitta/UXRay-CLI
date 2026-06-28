import { mkdirSync } from "fs";
import { join } from "path";

const LIVE_HELPERS = `
  window.__uxrayClearHighlights = () => {
    document.querySelectorAll('[data-uxray]').forEach(el => {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.boxShadow = '';
      el.removeAttribute('data-uxray');
    });
  };

  window.__uxrayHighlight = (el, type) => {
    if (!el) return;
    const colors = { violation: '#E24B4A', focus: '#378ADD', pass: '#639922', warn: '#BA7517' };
    el.style.outline = '3px solid ' + (colors[type] || colors.violation);
    el.style.outlineOffset = '3px';
    el.setAttribute('data-uxray', type);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  window.__uxraySpeak = (text, rate) => {
    if (!text) return;
    window.speechSynthesis?.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate || 0.95;
    window.speechSynthesis?.speak(u);
  };

  window.__uxrayBanner = (message, type) => {
    let b = document.getElementById('uxray-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'uxray-banner';
      b.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;max-width:360px;padding:12px 16px;border-radius:10px;font-family:-apple-system,sans-serif;font-size:13px;line-height:1.5;font-weight:500;box-shadow:0 4px 20px rgba(0,0,0,0.2);transition:all 0.2s;white-space:pre-line';
      document.body.appendChild(b);
    }
    const themes = {
      info:      ['#1a1a2e','#fff','rgba(255,255,255,0.15)'],
      pass:      ['#EAF3DE','#27500A','#C0DD97'],
      violation: ['#FCEBEB','#791F1F','#F7C1C1'],
      focus:     ['#E6F1FB','#0C447C','#B5D4F4'],
      announce:  ['#EEEDFE','#3C3489','#CECBF6'],
      warn:      ['#FAEEDA','#633806','#FAC775'],
    };
    const [bg, fg, border] = themes[type] || themes.info;
    b.style.background = bg;
    b.style.color = fg;
    b.style.border = '1px solid ' + border;
    b.textContent = message;
  };

  window.__uxrayLabel = (el, text, type) => {
    const existing = el.querySelector('[data-uxray-label]');
    if (existing) existing.remove();
    const label = document.createElement('div');
    label.setAttribute('data-uxray-label', '1');
    const colors = { violation: '#E24B4A', pass: '#639922', focus: '#378ADD' };
    label.style.cssText = 'position:absolute;top:-26px;left:0;background:' + (colors[type]||'#E24B4A') + ';color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;white-space:nowrap;font-family:-apple-system,sans-serif;font-weight:500;z-index:999998;pointer-events:none';
    label.textContent = text;
    if (window.getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.appendChild(label);
  };
`;

async function inject(page) {
  await page.evaluate(LIVE_HELPERS).catch(() => {});
}

async function ensureHelpers(page) {
  const ready = await page.evaluate(() => typeof window.__uxrayBanner === "function").catch(() => false);
  if (!ready) await inject(page);
}

async function speak(page, text, rate) {
  await ensureHelpers(page);
  await page.evaluate(({ text, rate }) => window.__uxraySpeak(text, rate), { text, rate }).catch(() => {});
}

async function banner(page, message, type = "info") {
  await ensureHelpers(page);
  await page.evaluate(({ message, type }) => window.__uxrayBanner(message, type), { message, type }).catch(() => {});
}

async function clear(page) {
  await ensureHelpers(page);
  await page.evaluate(() => window.__uxrayClearHighlights()).catch(() => {});
}

async function navigate(page, url, route, ms) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

  if (route?.waitFor) {
    await page.locator(route.waitFor).waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  }

  await page.waitForTimeout(ms);
  await inject(page);

  // If redirected to login, wait for the page to settle (auth cookie may need a moment)
  const currentUrl = page.url();
  if (currentUrl.includes("login")) {
    await page.waitForTimeout(2000);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(ms);
    await inject(page);
  }
}

// ── Phase 1: axe violations ───────────────────────────────────────────────────

async function liveAxePhase(page, config, baseUrl, ms) {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const findings = [];
  console.log("\n  Phase 1 — axe-core violations");

  for (const route of config.routes) {
    await navigate(page, `${baseUrl}${route.path}`, route, ms);
    await inject(page);
    await banner(page, `🔍 Running axe-core: ${route.name}`, "info");
    await page.waitForTimeout(ms);

    const { violations } = await new AxeBuilder({ page }).analyze();

    if (violations.length === 0) {
      await banner(page, `✓ No axe violations on ${route.name}`, "pass");
      await page.waitForTimeout(ms);
      continue;
    }

    for (const violation of violations.slice(0, 5)) {
      await inject(page);
      await clear(page);

      const targetSelector = violation.nodes[0]?.target?.[0];

      if (targetSelector) {
        await page.evaluate(({ selector, label }) => {
          const el = document.querySelector(selector);
          if (!el) return;
          window.__uxrayHighlight(el, "violation");
          window.__uxrayLabel(el, label, "violation");
        }, { selector: targetSelector, label: `❌ ${violation.id}` });
      }

      const wcagTags = (violation.tags || [])
        .filter((t) => t.startsWith("wcag"))
        .map((t) => `WCAG ${t.replace("wcag", "").replace(/(\d)(\d+)/, "$1.$2")}`)
        .join(", ");

      await banner(
        page,
        `❌ ${violation.help}\n${wcagTags} — ${violation.nodes.length} element(s)`,
        "violation"
      );
      await speak(page, violation.help);
      await page.waitForTimeout(ms * 1.5);

      findings.push({
        id:          `axe-${findings.length + 1}`,
        route:       route.path,
        source:      "axe",
        severity:    violation.impact === "critical" || violation.impact === "serious" ? "critical" : "major",
        wcag:        [wcagTags || "WCAG (unknown)"],
        title:       violation.description,
        description: `[${violation.id}] ${violation.help} — ${violation.nodes.length} node(s). ${violation.helpUrl}`,
      });
    }

    if (violations.length > 5) {
      await banner(page, `+ ${violations.length - 5} more axe violations on ${route.name}`, "warn");
      await page.waitForTimeout(ms);
    }
  }

  return findings;
}

// ── Phase 2: keyboard navigation ──────────────────────────────────────────────

async function liveKeyboardPhase(page, config, baseUrl, ms) {
  const findings = [];
  console.log("\n  Phase 2 — keyboard navigation");

  for (const route of config.routes) {
    await navigate(page, `${baseUrl}${route.path}`, route, ms);
    await banner(page, `⌨ Keyboard navigation: ${route.name}`, "focus");
    await speak(page, `Testing keyboard navigation on ${route.name}`);
    await page.waitForTimeout(ms);

    const visitCounts = new Map();
    let   trapFound   = false;
    let   skipFound   = false;

    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(ms * 0.9);

      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const name = el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.textContent || "").trim().slice(0, 40) || el.tagName.toLowerCase();
        el.style.outline = "3px solid #378ADD";
        el.style.outlineOffset = "3px";
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return {
          tag:    el.tagName.toLowerCase(),
          name:   name.trim(),
          href:   el.getAttribute("href") || "",
          testId: el.getAttribute("data-testid") || "",
        };
      });

      if (!focused) break;

      if (i === 0 && focused.href?.startsWith("#") && /skip|main|content/i.test(focused.name)) {
        skipFound = true;
        await banner(page, `✓ WCAG 2.4.1 — Skip navigation link found\n"${focused.name}"`, "pass");
        await speak(page, "Skip to main content");
        await page.waitForTimeout(ms * 0.8);
        continue;
      }

      if (i === 0 && !skipFound) {
        await banner(page, `❌ WCAG 2.4.1 — No skip navigation link\nFirst focus: "${focused.name}"`, "violation");
        await speak(page, `No skip navigation. First focus is ${focused.name}`);
        await page.waitForTimeout(ms * 1.5);
        findings.push({
          id: `kb-skip-${findings.length + 1}`, route: route.path, source: "keyboard",
          severity: "major", wcag: ["WCAG 2.4.1"], title: "No skip navigation link",
          description: `First focusable element is "${focused.name}" — not a skip link.`,
        });
      }

      await banner(page, `🔊 ${focused.tag}: "${focused.name}"`, "announce");
      await speak(page, focused.name || focused.tag);
      await page.waitForTimeout(ms * 0.5);

      const key = `${focused.tag}|${focused.testId}|${focused.name}`;
      const count = (visitCounts.get(key) || 0) + 1;
      visitCounts.set(key, count);

      if (count >= 4 && !trapFound) {
        trapFound = true;
        await banner(page, `❌ WCAG 2.1.2 — Keyboard trap!\n"${focused.name}" focused ${count}× — users cannot escape`, "violation");
        await speak(page, `Keyboard trap detected. ${focused.name} keeps getting focus.`);
        await page.waitForTimeout(ms * 2);
        findings.push({
          id: `kb-trap-${findings.length + 1}`, route: route.path, source: "keyboard",
          severity: "critical", wcag: ["WCAG 2.1.2"], title: "Keyboard trap detected",
          description: `Focus cycled to "${focused.name}" ${count}× — keyboard users cannot exit.`,
        });
        break;
      }
    }

    // Modal test
    const trigger = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => /cancel|modal|dialog/i.test(b.textContent || ""));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { text: (btn.textContent || "").trim().slice(0, 30), x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

    if (trigger) {
      await banner(page, `⌨ Opening modal: "${trigger.text}"`, "focus");
      await speak(page, `Opening modal: ${trigger.text}`);
      await page.waitForTimeout(ms);

      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.click(), trigger);
      await page.waitForTimeout(ms * 1.2);

      const focusInDialog = await page.evaluate(() => {
        const d = document.querySelector("[role='dialog'], dialog");
        return d?.contains(document.activeElement) ?? false;
      });

      if (!focusInDialog) {
        await banner(page, `❌ WCAG 2.4.3 — Focus not in dialog\nScreen reader user cannot interact with modal`, "violation");
        await speak(page, "Focus did not move into dialog. Screen reader user is stranded.");
        await page.waitForTimeout(ms * 2);
        findings.push({
          id: `kb-modal-${findings.length + 1}`, route: route.path, source: "keyboard",
          severity: "critical", wcag: ["WCAG 2.4.3"], title: "Focus not moved into modal",
          description: `After opening "${trigger.text}", focus stayed on trigger.`,
        });
      } else {
        await banner(page, `✓ WCAG 2.4.3 — Focus moved into dialog`, "pass");
        await speak(page, "Focus moved into dialog. Good.");
        await page.waitForTimeout(ms);
      }

      await page.keyboard.press("Escape");
      await page.waitForTimeout(ms);

      const stillOpen = await page.evaluate(() => {
        const d = document.querySelector("[role='dialog'], dialog");
        return d ? d.offsetHeight > 0 : false;
      });

      if (stillOpen) {
        await banner(page, `❌ WCAG 2.1.2 — Escape did not close modal`, "violation");
        await speak(page, "Escape did not close the modal. Keyboard trap.");
        await page.waitForTimeout(ms * 1.5);
      } else {
        await banner(page, `✓ Escape key closed the modal`, "pass");
        await speak(page, "Modal closed with Escape.");
        await page.waitForTimeout(ms);
      }
    }
  }

  return findings;
}

// ── Phase 3: screen reader simulation ────────────────────────────────────────

async function liveScreenReaderPhase(page, config, baseUrl, ms) {
  const findings = [];
  console.log("\n  Phase 3 — screen reader simulation");

  for (const route of config.routes.slice(0, 2)) {
    await navigate(page, `${baseUrl}${route.path}`, route, ms);
    await banner(page, `👁 Screen reader walk: ${route.name}`, "announce");
    await speak(page, `Screen reader starting on ${route.name}`);
    await page.waitForTimeout(ms);

    const elements = await page.evaluate(() => {
      const getRole = (el) => {
        const r = el.getAttribute("role");
        if (r) return r;
        const m = { a: "link", button: "button", h1: "heading", h2: "heading", h3: "heading", input: "textbox", select: "combobox", textarea: "textbox", img: "img" };
        return m[el.tagName.toLowerCase()] || el.tagName.toLowerCase();
      };

      const getName = (el) =>
        el.getAttribute("aria-label") ||
        el.getAttribute("alt") ||
        el.getAttribute("placeholder") ||
        (el.textContent || "").trim().slice(0, 60) || "";

      return Array.from(document.querySelectorAll("h1,h2,h3,button,a[href],input,select,textarea,img,[role='button']"))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .slice(0, 12)
        .map((el, i) => ({
          index:    i,
          role:     getRole(el),
          name:     getName(el),
          altNull:  el.tagName === "IMG" && el.getAttribute("alt") === null,
          selector: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.getAttribute("data-testid") ? `[data-testid="${el.getAttribute("data-testid")}"]` : ""),
        }));
    });

    for (const el of elements) {
      await clear(page);

      if (!el.name || el.altNull) {
        await page.evaluate((selector) => {
          const node = document.querySelector(selector);
          if (node) window.__uxrayHighlight(node, "violation");
        }, el.selector);

        const announcement = el.altNull ? `image` : el.role;
        await banner(
          page,
          `❌ WCAG 1.1.1 / 4.1.2\n${el.role.toUpperCase()} has no accessible name\nScreen reader announces: "${announcement}"`,
          "violation"
        );
        await speak(page, announcement);
        await page.waitForTimeout(ms * 1.4);

        findings.push({
          id: `sr-${findings.length + 1}`, route: route.path, source: "screenReader",
          severity: "critical", wcag: ["WCAG 4.1.2", "WCAG 1.1.1"],
          title: `${el.role} has no accessible name`,
          description: `Screen reader announces only "${announcement}" with no context.`,
        });
      } else {
        await page.evaluate((selector) => {
          const node = document.querySelector(selector);
          if (node) window.__uxrayHighlight(node, "pass");
        }, el.selector);

        await banner(page, `🔊 ${el.role}: "${el.name}"`, "announce");
        await speak(page, `${el.name}`);
        await page.waitForTimeout(ms * 0.55);
      }
    }
  }

  return findings;
}

// ── Phase 4: responsive resizing ─────────────────────────────────────────────

async function liveResponsivePhase(page, config, baseUrl, ms) {
  const findings = [];
  console.log("\n  Phase 4 — responsive and dark mode");

  const viewports = [
    { name: "Mobile (375px)", width: 375, height: 812, dark: false },
    { name: "Tablet (768px)", width: 768, height: 1024, dark: false },
    { name: "Desktop (1280px)", width: 1280, height: 800, dark: false },
    { name: "Dark mode", width: 1280, height: 800, dark: true },
  ];

  for (const route of config.routes.slice(0, 2)) {
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      if (vp.dark) {
        await page.emulateMedia({ colorScheme: "dark" });
      } else {
        await page.emulateMedia({ colorScheme: "light" });
      }

      await navigate(page, `${baseUrl}${route.path}`, route, ms * 0.6);

      if (vp.dark) {
        await page.evaluate(() => {
          const overlay = document.createElement("div");
          overlay.id = "uxray-dark-overlay";
          overlay.style.cssText = [
            "position:fixed",
            "top:0",
            "left:0",
            "width:100%",
            "height:100%",
            "background:rgba(0,0,0,0.55)",
            "z-index:999990",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "font-family:-apple-system,sans-serif",
            "pointer-events:none",
            "transition:opacity 0.5s",
          ].join(";");

          const label = document.createElement("div");
          label.style.cssText = [
            "background:#1a1a2e",
            "color:#fff",
            "padding:16px 28px",
            "border-radius:12px",
            "font-size:18px",
            "font-weight:600",
            "letter-spacing:0.5px",
            "border:1px solid rgba(255,255,255,0.15)",
            "box-shadow:0 8px 32px rgba(0,0,0,0.4)",
          ].join(";");

          label.textContent = "🌙 Dark Mode Active";
          overlay.appendChild(label);
          document.body.appendChild(overlay);

          setTimeout(() => { overlay.style.opacity = "0"; }, 2500);
          setTimeout(() => { overlay.remove(); }, 3000);
        });

        // Try clicking the app's own dark mode toggle if one exists
        await page.evaluate(() => {
          const toggleSelectors = [
            "[data-testid='theme-toggle']",
            "[aria-label*='dark']",
            "[aria-label*='Dark']",
            ".theme-toggle",
            ".dark-mode-toggle",
          ];
          for (const selector of toggleSelectors) {
            const button = document.querySelector(selector);
            if (button) {
              button.click();
              break;
            }
          }
        }).catch(() => {});

        await page.waitForTimeout(ms * 1.2);
      }

      await banner(page, `📐 ${vp.name} — ${route.name}`, "focus");
      await speak(page, `Testing ${vp.name}`);
      await page.waitForTimeout(ms);

      const overflows = await page.evaluate((width) => {
        const issues = [];
        if (document.body.scrollWidth > width + 5) {
          issues.push({ el: "body", overflow: document.body.scrollWidth - width });
        }
        document.querySelectorAll("table").forEach((t) => {
          if (t.scrollWidth > width + 5) {
            const cls = t.className?.toString().trim().split(/\s+/)[0] || "";
            issues.push({ el: `table${cls ? "." + cls : ""}`, overflow: t.scrollWidth - width });
          }
        });
        return issues;
      }, vp.width);

      if (overflows.length > 0) {
        await banner(
          page,
          `❌ WCAG 1.4.10 — Content overflow at ${vp.width}px\n<${overflows[0].el}> overflows by ${overflows[0].overflow}px`,
          "violation"
        );
        await speak(page, `Content overflows at ${vp.width} pixels`);
        await page.waitForTimeout(ms * 1.5);

        findings.push({
          id: `resp-overflow-${findings.length + 1}`, route: route.path, source: "responsive",
          severity: "major", wcag: ["WCAG 1.4.10"],
          title: `Content overflow at ${vp.width}px`,
          description: `<${overflows[0].el}> overflows by ${overflows[0].overflow}px.`,
        });
      } else if (vp.width <= 768) {
        await banner(page, `✓ No overflow at ${vp.width}px`, "pass");
        await page.waitForTimeout(ms * 0.6);
      }

      if (vp.width <= 768) {
        const smallTargets = await page.evaluate((min) => {
          const els = document.querySelectorAll("button, a[href], input, [role='button']");
          const bad = [];
          els.forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && (r.width < min || r.height < min)) {
              bad.push({ w: Math.round(r.width), h: Math.round(r.height), name: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 20) });
            }
          });
          return bad.slice(0, 3);
        }, 44);

        if (smallTargets.length > 0) {
          const first = smallTargets[0];
          await banner(
            page,
            `❌ WCAG 2.5.5 — Touch targets too small\n${smallTargets.length} element(s) — e.g. "${first.name}" ${first.w}×${first.h}px (need 44px)`,
            "violation"
          );
          await speak(page, `${smallTargets.length} touch targets are too small`);
          await page.waitForTimeout(ms * 1.5);

          findings.push({
            id: `resp-touch-${findings.length + 1}`, route: route.path, source: "responsive",
            severity: "major", wcag: ["WCAG 2.5.5"],
            title: `Touch targets below 44px at ${vp.width}px`,
            description: `${smallTargets.length} element(s) too small.`,
          });
        }
      }

      if (vp.dark) {
        const contrastFails = await page.evaluate((min) => {
          const toL = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
          const lum = (r, g, b) => 0.2126 * toL(r) + 0.7152 * toL(g) + 0.0722 * toL(b);
          const parse = (s) => (s.match(/\d+/g) || []).map(Number);
          const ratio = (fg, bg) => { const [r1,g1,b1] = parse(fg), [r2,g2,b2] = parse(bg), l1=lum(r1,g1,b1), l2=lum(r2,g2,b2); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
          const fails = [];
          document.querySelectorAll("p,span,h1,h2,h3,td,label,a,button").forEach((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return;
            const s = window.getComputedStyle(el);
            if (!s.backgroundColor || s.backgroundColor === "rgba(0, 0, 0, 0)") return;
            const rt = ratio(s.color, s.backgroundColor);
            if (rt < min) fails.push({ text: (el.textContent || "").trim().slice(0, 20), ratio: Math.round(rt * 100) / 100 });
          });
          return fails.slice(0, 3);
        }, 4.5);

        if (contrastFails.length > 0) {
          await banner(
            page,
            `❌ WCAG 1.4.3 — Dark mode contrast failures\n${contrastFails.length} element(s) — e.g. "${contrastFails[0].text}" ratio=${contrastFails[0].ratio} (need 4.5)`,
            "violation"
          );
          await speak(page, `${contrastFails.length} contrast failures in dark mode`);
          await page.waitForTimeout(ms * 1.5);

          findings.push({
            id: `resp-dark-${findings.length + 1}`, route: route.path, source: "responsive",
            severity: "major", wcag: ["WCAG 1.4.3"], title: "Dark mode contrast failures",
            description: `${contrastFails.length} element(s) fail contrast. e.g. "${contrastFails[0].text}" ratio=${contrastFails[0].ratio}`,
          });
        }
      }
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(ms * 0.5);
  }

  return findings;
}

// ── Phase 5: wcag extended spot checks ───────────────────────────────────────

async function liveWcagExtendedPhase(page, config, baseUrl, ms) {
  const findings = [];
  console.log("\n  Phase 5 — WCAG extended checks");

  for (const route of config.routes) {
    await navigate(page, `${baseUrl}${route.path}`, route, ms * 0.6);
    await banner(page, `🔬 Extended WCAG checks: ${route.name}`, "info");
    await page.waitForTimeout(ms);

    const issues = await page.evaluate((minNonText) => {
      const results = [];
      const toL = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      const lum = (r, g, b) => 0.2126 * toL(r) + 0.7152 * toL(g) + 0.0722 * toL(b);
      const parse = (s) => (s.match(/\d+/g) || []).map(Number);
      const ratio = (fg, bg) => {
        const [r1,g1,b1] = parse(fg), [r2,g2,b2] = parse(bg);
        const l1 = lum(r1,g1,b1), l2 = lum(r2,g2,b2);
        return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
      };

      document.querySelectorAll("button[aria-label], a[href][aria-label], input[aria-label]").forEach((el) => {
        const ariaLabel   = (el.getAttribute("aria-label") || "").trim().toLowerCase();
        const visibleText = (el.textContent || "").trim().toLowerCase();
        if (visibleText && visibleText.length > 1 && !ariaLabel.includes(visibleText)) {
          results.push({
            type:    "label-in-name",
            element: el.tagName.toLowerCase(),
            testId:  el.getAttribute("data-testid") || "",
            visible: (el.textContent || "").trim().slice(0, 30),
            aria:    el.getAttribute("aria-label")?.slice(0, 40) || "",
          });
        }
      });

      document.querySelectorAll("input,select,textarea,button").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const s = window.getComputedStyle(el);
        const bg = window.getComputedStyle(document.body).backgroundColor;
        if (s.borderColor && s.borderColor !== "rgba(0, 0, 0, 0)" && bg) {
          const rt = ratio(s.borderColor, bg);
          if (rt < minNonText) {
            results.push({
              type:   "non-text-contrast",
              element: el.tagName.toLowerCase(),
              testId:  el.getAttribute("data-testid") || "",
              ratio:   Math.round(rt * 100) / 100,
            });
          }
        }
      });

      const actionBtns = Array.from(document.querySelectorAll("button,[role='button']"))
        .filter((b) => /save|delete|submit|create|confirm|apply/i.test(b.textContent || b.getAttribute("aria-label") || ""))
        .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const liveRegions = document.querySelectorAll("[role='status'],[role='alert'],[aria-live]");
      if (actionBtns.length > 0 && liveRegions.length === 0) {
        results.push({ type: "no-live-region", buttons: actionBtns.slice(0, 3).map((b) => (b.textContent || "").trim().slice(0, 20)) });
      }

      return results.slice(0, 8);
    }, config.thresholds?.nonTextContrast || 3.0);

    for (const issue of issues) {
      await clear(page);

      if (issue.type === "label-in-name") {
        await page.evaluate((testId) => {
          const el = document.querySelector(`[data-testid="${testId}"]`) || document.querySelector(`button[aria-label]`);
          if (el) window.__uxrayHighlight(el, "violation");
        }, issue.testId);
        await banner(
          page,
          `❌ WCAG 2.5.3 — Label in name\n"${issue.visible}" visible but aria-label is "${issue.aria}"\nVoice users saying "${issue.visible}" can't activate it`,
          "violation"
        );
        await speak(page, `${issue.aria}`);
        await page.waitForTimeout(ms * 1.5);
        findings.push({
          id: `ext-${findings.length + 1}`, route: route.path, source: "wcagExtended",
          severity: "major", wcag: ["WCAG 2.5.3"], title: "Accessible name does not contain visible label",
          description: `"${issue.visible}" visible but aria-label is "${issue.aria}".`,
        });
      }

      if (issue.type === "non-text-contrast") {
        await page.evaluate((testId) => {
          const el = document.querySelector(`[data-testid="${testId}"]`);
          if (el) window.__uxrayHighlight(el, "violation");
        }, issue.testId);
        await banner(
          page,
          `❌ WCAG 1.4.11 — Non-text contrast\n<${issue.element}> border ratio ${issue.ratio} (need 3.0)`,
          "violation"
        );
        await speak(page, `Non-text contrast failure on ${issue.element}`);
        await page.waitForTimeout(ms * 1.2);
        findings.push({
          id: `ext-ntc-${findings.length + 1}`, route: route.path, source: "wcagExtended",
          severity: "major", wcag: ["WCAG 1.4.11"], title: "Non-text contrast failure",
          description: `<${issue.element}> border ratio ${issue.ratio} (need 3.0).`,
        });
      }

      if (issue.type === "no-live-region") {
        await banner(
          page,
          `❌ WCAG 4.1.3 — No aria-live region\nPage has action buttons (${issue.buttons.join(", ")}) but no status announcements`,
          "violation"
        );
        await speak(page, `No live region for status messages`);
        await page.waitForTimeout(ms * 1.2);
        findings.push({
          id: `ext-live-${findings.length + 1}`, route: route.path, source: "wcagExtended",
          severity: "major", wcag: ["WCAG 4.1.3"], title: "No aria-live region for status messages",
          description: `Page has action buttons but no role="status" or aria-live region.`,
        });
      }
    }

    await banner(page, `✓ ${route.name} extended checks done`, "pass");
    await page.waitForTimeout(ms * 0.8);
  }

  return findings;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runLiveDemo(browser, config, paths) {
  mkdirSync(paths.screenshots, { recursive: true });

  const baseUrl = process.env.BASE_URL || config.baseUrl;
  const ms      = config.liveStepMs || 900;

  console.log("\n  Live demo — browser opening");
  console.log("  Press Ctrl+C to stop at any time\n");

  let context;
  let page;

  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page    = await context.newPage();

  if (config.auth) {
    console.log("  Auth: performing live login...");
    try {
      const loginUrl = `${baseUrl}${config.auth.loginUrl}`;

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(ms);
      await inject(page);

      await banner(page, "🔐 Logging in to Campaign UI...", "info");
      await speak(page, "Logging in");
      await page.waitForTimeout(ms);

      // Fill username visibly
      const usernameSelector = config.auth.usernameSelector || "input[name=\'username\']";
      await page.locator(usernameSelector).first().click();
      await page.waitForTimeout(300);
      await page.locator(usernameSelector).first().fill(config.auth.username || process.env.UXRAY_USER || "");
      await page.waitForTimeout(ms * 0.6);

      // Fill password visibly
      const passwordSelector = config.auth.passwordSelector || "input[type=\'password\']";
      await page.locator(passwordSelector).first().click();
      await page.waitForTimeout(300);
      await page.locator(passwordSelector).first().fill(config.auth.password || process.env.UXRAY_PASS || "");
      await page.waitForTimeout(ms * 0.6);

      await banner(page, "🔐 Submitting login form...", "info");

      // Click submit
      const submitSelector = config.auth.submitSelector || "button[type=\'submit\']";
      await page.locator(submitSelector).first().click();

      // Wait for successful navigation away from login
      if (config.auth.successUrl) {
        await page.waitForURL(`**${config.auth.successUrl.replace("**", "")}`, { timeout: 15000 });
      } else if (config.auth.waitFor) {
        await page.locator(config.auth.waitFor).waitFor({ state: "visible", timeout: 15000 });
      } else {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      }

      await page.waitForTimeout(ms);
      await inject(page);
      await banner(page, "✓ Login successful — starting audit", "pass");
      await speak(page, "Login successful. Starting accessibility audit.");
      await page.waitForTimeout(ms * 1.5);

      console.log("  Auth: login successful\n");
    } catch (error) {
      console.error(`  Auth error: ${error.message}`);
      process.exit(1);
    }
  }

  const allFindings = [];

  const axeFindings      = await liveAxePhase(page, config, baseUrl, ms);
  const keyboardFindings = await liveKeyboardPhase(page, config, baseUrl, ms);
  const srFindings       = await liveScreenReaderPhase(page, config, baseUrl, ms);
  const respFindings     = await liveResponsivePhase(page, config, baseUrl, ms);
  const extFindings      = await liveWcagExtendedPhase(page, config, baseUrl, ms);

  allFindings.push(...axeFindings, ...keyboardFindings, ...srFindings, ...respFindings, ...extFindings);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });

  const firstRoute = config.routes[0];
  await navigate(page, `${baseUrl}${firstRoute.path}`, firstRoute, ms * 0.5);

  await page.evaluate((url) => window.__uxrayBanner(`✓ Scan complete — ${url}`, 'pass'), paths.report);
  await speak(page, "Scan complete. Generating accessibility report.");
  await page.waitForTimeout(ms * 2);

  await context.close();

  return allFindings;
}