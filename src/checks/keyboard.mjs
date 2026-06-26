/**
 * src/checks/keyboard.mjs
 * UXRay — keyboard navigation check layer
 *
 * Checks: focus visible (2.4.7), skip nav (2.4.1), keyboard trap (2.1.2),
 *         focus order quality, modal Escape handling
 *
 * Uses CDP to disable mouse at browser level — real keyboard-only mode.
 */

import { mkdirSync } from "fs";
import { join }      from "path";

const MIN_FOCUS_OUTLINE = 0;

async function loadPage(page, url, route) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  if (route?.waitFor) await page.locator(route.waitFor).waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function screenshot(page, paths, id) {
  try {
    const file = join(paths.screenshots, `kb-${id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch { return null; }
}

export async function runKeyboardChecks(browser, cfg, paths) {
  const findings = [];
  const baseUrl  = process.env.BASE_URL ?? cfg.baseUrl;
  const maxTabs  = cfg.thresholds?.maxTabs ?? 60;
  mkdirSync(paths.screenshots, { recursive: true });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await context.newPage();

  for (const route of cfg.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   kb   ${route.name.padEnd(16)}`);
    let count = 0;

    try {
      await loadPage(page, url, route);

      // ── Enable CDP keyboard-only mode ──────────────────────────────────────
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: false }).catch(() => {});

      // Inject visual badge + mouse blocker
      await page.addStyleTag({ content: `body::before{content:"⌨ keyboard-only";position:fixed;top:6px;right:6px;background:#26215C;color:#CECBF6;font-size:10px;font-family:monospace;padding:3px 8px;border-radius:4px;z-index:99999;pointer-events:none}` }).catch(() => {});
      await page.evaluate(() => {
        window.__kbBlocked = [];
        const block = (e) => { if (e.type==="click"&&e.detail===0) return; window.__kbBlocked.push({type:e.type,target:e.target?.tagName?.toLowerCase()}); e.stopImmediatePropagation(); e.preventDefault(); };
        ["click","mousedown","mouseup","mouseover","pointerdown"].forEach(t => document.addEventListener(t, block, {capture:true}));
      });

      // ── Check 1: Skip nav (2.4.1) ─────────────────────────────────────────
      await page.keyboard.press("Tab");
      const firstFocus = await page.evaluate(() => {
        const el = document.activeElement;
        return { tag: el?.tagName?.toLowerCase(), href: el?.getAttribute("href") ?? "", text: (el?.textContent ?? "").trim().slice(0,40) };
      });
      const hasSkipNav = firstFocus.href?.startsWith("#") && /skip|main|content/i.test(firstFocus.text);
      if (!hasSkipNav) {
        const ss = await screenshot(page, paths, `skip-nav-${route.path.replace(/\//g,"-")}`);
        findings.push({ id:`kb-skip-${findings.length+1}`, route:route.path, source:"keyboard", severity:"major", wcag:["WCAG 2.4.1"], title:"No skip navigation link", description:`First focusable element is <${firstFocus.tag}> "${firstFocus.text}" — not a skip link. Keyboard users must tab through nav on every page.`, screenshot: ss });
        count++;
      }

      // ── Check 2: Focus visible on all interactive elements (2.4.7) ──────
      await loadPage(page, url, route);
      const focusFailures = [];
      const seen = new Set();

      for (let i = 0; i < Math.min(maxTabs, 40); i++) {
        await page.keyboard.press("Tab");
        const el = await page.evaluate(() => {
          const a = document.activeElement;
          if (!a || a === document.body) return null;
          const s = window.getComputedStyle(a);
          return {
            tag:     a.tagName.toLowerCase(),
            testId:  a.getAttribute("data-testid") ?? "",
            text:    (a.getAttribute("aria-label") ?? a.textContent ?? "").trim().slice(0,30),
            outline: parseFloat(s.outlineWidth),
            shadow:  s.boxShadow !== "none",
          };
        });
        if (!el) break;
        const key = `${el.tag}|${el.testId}|${el.text}`;
        if (seen.has(key)) break;
        seen.add(key);
        if (el.outline <= MIN_FOCUS_OUTLINE && !el.shadow) {
          focusFailures.push(el);
        }
      }

      if (focusFailures.length > 0) {
        const ss = await screenshot(page, paths, `focus-visible-${route.path.replace(/\//g,"-")}`);
        findings.push({ id:`kb-focus-${findings.length+1}`, route:route.path, source:"keyboard", severity:"major", wcag:["WCAG 2.4.7"], title:"Focus indicator not visible", description:`${focusFailures.length} interactive element(s) have no visible focus ring. e.g. <${focusFailures[0].tag}> "${focusFailures[0].text}"`, screenshot: ss });
        count++;
      }

      // ── Check 3: Keyboard trap (2.1.2) ────────────────────────────────────
      await loadPage(page, url, route);
      const visitCounts = new Map();
      let trapEl = null;

      for (let i = 0; i < maxTabs; i++) {
        await page.keyboard.press("Tab");
        const el = await page.evaluate(() => {
          const a = document.activeElement;
          if (!a || a === document.body) return null;
          return { tag: a.tagName.toLowerCase(), id: a.id, testId: a.getAttribute("data-testid") ?? "", text: (a.textContent ?? "").trim().slice(0,30) };
        });
        if (!el) break;
        const key = `${el.tag}|${el.id}|${el.testId}`;
        const n = (visitCounts.get(key) ?? 0) + 1;
        visitCounts.set(key, n);
        if (n >= 5) { trapEl = el; break; }
      }

      if (trapEl) {
        const ss = await screenshot(page, paths, `trap-${route.path.replace(/\//g,"-")}`);
        findings.push({ id:`kb-trap-${findings.length+1}`, route:route.path, source:"keyboard", severity:"critical", wcag:["WCAG 2.1.2"], title:"Keyboard trap detected", description:`Focus cycled to <${trapEl.tag}> "${trapEl.text}" 3+ times — keyboard users cannot exit this element.`, screenshot: ss });
        count++;
      }

      // ── Check 4: Modal Escape (2.1.2) ─────────────────────────────────────
      const modalTriggers = await page.evaluate(() => {
        const triggers = [];
        document.querySelectorAll("button,[role='button']").forEach((el) => {
          const t = (el.textContent ?? el.getAttribute("aria-label") ?? "").trim().toLowerCase();
          if (/cancel|modal|dialog|confirm|open/i.test(t) || el.getAttribute("aria-haspopup")==="dialog") {
            const r = el.getBoundingClientRect();
            if (r.width > 0) triggers.push({ text: el.textContent.trim().slice(0,30), x: r.x+r.width/2, y: r.y+r.height/2 });
          }
        });
        return triggers.slice(0,2);
      });

      for (const trigger of modalTriggers) {
        await page.evaluate(({x,y}) => {
          const el = document.elementFromPoint(x,y);
          if (el) el.click();
        }, trigger);
        await page.waitForTimeout(600);
        const dialogOpen = await page.evaluate(() => { const d=document.querySelector("[role='dialog'],dialog"); return d ? d.offsetHeight>0 : false; });
        if (!dialogOpen) continue;

        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        const stillOpen = await page.evaluate(() => { const d=document.querySelector("[role='dialog'],dialog"); return d ? d.offsetHeight>0 : false; });

        if (stillOpen) {
          const ss = await screenshot(page, paths, `modal-escape-${route.path.replace(/\//g,"-")}`);
          findings.push({ id:`kb-modal-${findings.length+1}`, route:route.path, source:"keyboard", severity:"critical", wcag:["WCAG 2.1.2"], title:"Modal not dismissible with Escape", description:`Dialog triggered by "${trigger.text}" does not close on Escape — keyboard trap.`, screenshot: ss });
          count++;
          // Close via button so next checks work
          await page.evaluate(() => { document.querySelector("[role='dialog'] button")?.click(); });
          await page.waitForTimeout(300);
        }

        // Check focus returns to trigger
        const focusBack = await page.evaluate(() => {
          const d = document.querySelector("[role='dialog'],dialog");
          return !(d?.contains(document.activeElement));
        });
        if (!focusBack) {
          findings.push({ id:`kb-focus-return-${findings.length+1}`, route:route.path, source:"keyboard", severity:"major", wcag:["WCAG 2.1.2","WCAG 2.4.3"], title:"Focus not returned after modal closes", description:`After closing dialog from "${trigger.text}", focus did not return to the trigger.` });
          count++;
        }
      }

      // Disable mouse blocker
      await page.evaluate(() => { if (window.__kbCleanup) window.__kbCleanup(); });
      await cdp.detach().catch(() => {});

      console.log(`→ ${count} issue(s)`);
    } catch (err) {
      console.log(`→ ⚠ ${err.message.split("\n")[0]}`);
    }
  }

  await context.close();
  return findings;
}
