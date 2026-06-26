/**
 * src/checks/responsive.mjs
 * UXRay — responsiveness check layer
 *
 * Checks: overflow (1.4.10), touch targets (2.5.5), dark-mode contrast (1.4.3),
 *         text resize 200% (1.4.4), orientation (1.3.4), text spacing (1.4.12)
 */

import { join }      from "path";
import { mkdirSync } from "fs";

async function loadPage(page, url, route) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  if (route?.waitFor) await page.locator(route.waitFor).waitFor({ state:"visible", timeout:5_000 }).catch(()=>{});
  await page.waitForTimeout(400);
}

async function screenshot(page, paths, id) {
  try {
    const file = join(paths.screenshots, `resp-${id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch { return null; }
}

// ── Contrast helpers (injected into page) ────────────────────────────────────

const CONTRAST_SCRIPT = (min) => {
  const toL = c => { const s=c/255; return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4); };
  const lum = (r,g,b) => 0.2126*toL(r)+0.7152*toL(g)+0.0722*toL(b);
  const parse = s => (s.match(/\d+/g)||[]).map(Number);
  const ratio = (fg,bg) => { const [r1,g1,b1]=parse(fg),[r2,g2,b2]=parse(bg),l1=lum(r1,g1,b1),l2=lum(r2,g2,b2); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
  const issues = [];
  document.querySelectorAll("p,span,h1,h2,h3,h4,h5,h6,li,td,th,label,a,button").forEach(el => {
    const rect = el.getBoundingClientRect();
    if (!rect.width||!rect.height) return;
    const s = window.getComputedStyle(el);
    if (!s.backgroundColor||s.backgroundColor==="rgba(0, 0, 0, 0)") return;
    const r = ratio(s.color, s.backgroundColor);
    if (r < min) issues.push({ element:`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0,30)}"`, fg:s.color, bg:s.backgroundColor, ratio:Math.round(r*100)/100 });
  });
  return issues.slice(0,20);
};

export async function runResponsiveChecks(browser, cfg, paths) {
  const findings = [];
  const baseUrl  = process.env.BASE_URL ?? cfg.baseUrl;
  const minTouch = cfg.thresholds?.touchPx     ?? 44;
  const minCon   = cfg.thresholds?.contrast     ?? 4.5;
  const fontPct  = cfg.thresholds?.fontScalePct ?? 200;
  mkdirSync(paths.screenshots, { recursive: true });

  const viewports = Object.entries(cfg.viewports ?? {
    mobile:  { width:375, height:812,  darkMode:false },
    desktop: { width:1280, height:800, darkMode:false },
    dark:    { width:1280, height:800, darkMode:true },
  });

  for (const [vpName, vp] of viewports) {
    const context = await browser.newContext({
      viewport:    { width: vp.width, height: vp.height },
      colorScheme: vp.darkMode ? "dark" : "light",
    });
    const page = await context.newPage();

    for (const route of cfg.routes) {
      const url = `${baseUrl}${route.path}`;
      process.stdout.write(`   resp ${vpName.padEnd(10)} ${route.name.padEnd(12)}`);
      let count = 0;

      try {
        await loadPage(page, url, route);

        // ── Overflow (1.4.10) ─────────────────────────────────────────────
        const overflow = await page.evaluate((vw) => {
          const issues = [];
          if (document.body.scrollWidth > vw) issues.push({ el:"body", scrollWidth:document.body.scrollWidth, over:document.body.scrollWidth-vw, hint:"Page has horizontal scroll" });
          document.querySelectorAll("table").forEach(t => {
            const ws = t.parentElement ? window.getComputedStyle(t.parentElement) : null;
            if (ws && ws.overflowX!=="auto"&&ws.overflowX!=="scroll"&&t.scrollWidth>vw) {
              issues.push({ el:`table.${t.className?.toString().trim().split(/\s+/)[0]||""}`, scrollWidth:t.scrollWidth, over:t.scrollWidth-vw, hint:"Table overflows with no scroll container" });
            }
          });
          return [...new Map(issues.map(i=>[i.el,i])).values()];
        }, vp.width);

        for (const iss of overflow) {
          const ss = await screenshot(page, paths, `overflow-${vpName}-${route.path.replace(/\//g,"-")}`);
          findings.push({ id:`resp-overflow-${findings.length+1}`, route:route.path, source:"responsive", severity:"major", wcag:["WCAG 1.4.10"], title:`Content overflow at ${vp.width}px`, description:`<${iss.el}> overflows by ${iss.over}px. ${iss.hint}`, screenshot:ss });
          count++;
        }

        // ── Touch targets (2.5.5) — mobile/tablet only ────────────────────
        if (vp.width <= 768) {
          const small = await page.evaluate((min) => {
            const sel = "button,a[href],input,select,textarea,[role='button'],[role='link'],[role='menuitem'],[role='tab']";
            const issues = [];
            document.querySelectorAll(sel).forEach(el => {
              const r = el.getBoundingClientRect();
              if (r.width>0&&r.height>0&&(r.width<min||r.height<min)) {
                const label = (el.getAttribute("aria-label")||el.getAttribute("data-testid")||el.textContent||"").trim().slice(0,30);
                issues.push({ el:`${el.tagName.toLowerCase()}${el.className?" ."+el.className.toString().trim().split(/\s+/)[0]:""}`, label, w:Math.round(r.width), h:Math.round(r.height) });
              }
            });
            return issues.slice(0,20);
          }, minTouch);

          if (small.length) {
            const ss = await screenshot(page, paths, `touch-${vpName}-${route.path.replace(/\//g,"-")}`);
            findings.push({ id:`resp-touch-${findings.length+1}`, route:route.path, source:"responsive", severity:"major", wcag:["WCAG 2.5.5"], title:`Touch targets below ${minTouch}px at ${vp.width}px`, description:`${small.length} element(s) too small. e.g. <${small[0].el}> "${small[0].label}" ${small[0].w}×${small[0].h}px (need ${minTouch}px)`, screenshot:ss });
            count++;
          }
        }

        // ── Dark mode contrast (1.4.3) ────────────────────────────────────
        if (vp.darkMode) {
          const contrastIssues = await page.evaluate(CONTRAST_SCRIPT, minCon);
          if (contrastIssues.length) {
            const ss = await screenshot(page, paths, `dark-contrast-${route.path.replace(/\//g,"-")}`);
            findings.push({ id:`resp-dark-${findings.length+1}`, route:route.path, source:"responsive", severity:"major", wcag:["WCAG 1.4.3"], title:"Dark mode contrast failures", description:`${contrastIssues.length} element(s) fail contrast in dark mode. e.g. ${contrastIssues[0].element} ratio=${contrastIssues[0].ratio} (need ${minCon})`, screenshot:ss });
            count++;
          }
        }

        // ── Text resize 200% (1.4.4) — desktop only ───────────────────────
        if (!vp.darkMode && vp.width >= 1280) {
          await page.evaluate((pct) => { document.documentElement.style.fontSize = pct+"%"; }, fontPct);
          await page.waitForTimeout(300);
          const zoomOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 2);
          await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

          if (zoomOverflow) {
            const ss = await screenshot(page, paths, `zoom-${route.path.replace(/\//g,"-")}`);
            findings.push({ id:`resp-zoom-${findings.length+1}`, route:route.path, source:"responsive", severity:"major", wcag:["WCAG 1.4.4"], title:`Content overflows at ${fontPct}% text size`, description:`Horizontal overflow detected at ${fontPct}% font size — WCAG 1.4.4 requires no loss of content up to 200%.`, screenshot:ss });
            count++;
          }
        }

        // ── Text spacing override (1.4.12) — desktop only ─────────────────
        if (!vp.darkMode && vp.width >= 1280) {
          await page.addStyleTag({ content: `*{line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important;margin-bottom:0.35em!important}` });
          await page.waitForTimeout(300);
          const spacingOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 2);

          if (spacingOverflow) {
            findings.push({ id:`resp-spacing-${findings.length+1}`, route:route.path, source:"responsive", severity:"minor", wcag:["WCAG 1.4.12"], title:"Content overflows with text spacing overrides", description:"Injecting WCAG 1.4.12 text spacing values (line-height 1.5, letter-spacing 0.12em) causes horizontal overflow." });
            count++;
          }
        }

        // ── Orientation (1.3.4) — landscape check ─────────────────────────
        if (vp.width <= 768) {
          await page.setViewportSize({ width: Math.max(vp.height, 568), height: Math.min(vp.width, 320) });
          await page.waitForTimeout(300);
          const landscapeOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 2);
          await page.setViewportSize({ width: vp.width, height: vp.height });

          if (landscapeOverflow) {
            findings.push({ id:`resp-orient-${findings.length+1}`, route:route.path, source:"responsive", severity:"major", wcag:["WCAG 1.3.4"], title:"Content overflows in landscape orientation", description:`Page overflows horizontally when viewport rotated to landscape (${Math.max(vp.height,568)}×${Math.min(vp.width,320)}).` });
            count++;
          }
        }

        console.log(`→ ${count} issue(s)`);
      } catch (err) {
        console.log(`→ ⚠ ${err.message.split("\n")[0]}`);
      }
    }

    await context.close();
  }

  return findings;
}
