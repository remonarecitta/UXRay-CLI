/**
 * src/personas/scorer.mjs
 * UXRay — persona health scoring
 *
 * Runs 4 personas × page-level checks + optional form missions (from config).
 * All field names, routes, and selectors come from cfg — nothing hardcoded.
 */

import { join }      from "path";
import { mkdirSync } from "fs";

// ── Helpers ──────────────────────────────────────────────────────────────────

function score(checks) {
  const total  = checks.reduce((s,c) => s+c.weight, 0);
  const earned = checks.reduce((s,c) => s+(c.pass?c.weight:0), 0);
  return total === 0 ? 100 : Math.round((earned/total)*100);
}

function catScore(missions, cat) {
  const rel = missions.flatMap(m => m.checks.filter(c => c.category===cat));
  if (!rel.length) return null;
  const total  = rel.reduce((s,c)=>s+c.weight,0);
  const earned = rel.reduce((s,c)=>s+(c.pass?c.weight:0),0);
  return Math.round((earned/total)*100);
}

function check(id, label, category, weight, pass, detail="", screenshot=null) {
  return { id, label, category, weight, pass, detail, screenshot };
}

async function tryVisible(locator, ms=3000) {
  try { await locator.first().waitFor({ state:"visible", timeout:ms }); return true; }
  catch { return false; }
}

async function loadPage(page, url, route) {
  await page.goto(url, { waitUntil:"domcontentloaded", timeout:15_000 });
  if (route?.waitFor) await page.locator(route.waitFor).waitFor({ state:"visible", timeout:5_000 }).catch(()=>{});
  await page.waitForTimeout(400);
}

async function ss(page, paths, id) {
  try { const f=join(paths.screenshots,`persona-${id}.png`); await page.screenshot({path:f,fullPage:false}); return f; }
  catch { return null; }
}

// ── Screen Reader persona ────────────────────────────────────────────────────

async function runScreenReaderPersona(page, cfg, paths, baseUrl) {
  const missions = [];
  const formCfg  = cfg.missions?.createForm;
  const formRoute = cfg.routes.find(r => r.path === formCfg?.path) ?? { path: formCfg?.path ?? "/", name:"Form" };

  if (formCfg) {
    const checks = [];
    await loadPage(page, `${baseUrl}${formCfg.path}`, formRoute);

    // Landmark check
    const hasMain = await page.evaluate(() => !!document.querySelector("main,[role='main'],form"));
    checks.push(check("sr-landmark","Page has main landmark","accessibility",8,hasMain,"",""));

    // Field discoverability (from config)
    const checkableFields = (formCfg.fields||[]).filter(f => f.name !== (formCfg.unlabeledField??null));
    for (const f of checkableFields) {
      const loc = page.getByRole(f.role, { name: f.name });
      const ok  = await tryVisible(loc);
      if (!ok) {
        const s = await ss(page, paths, `sr-field-${f.testId}`);
        checks.push(check(`sr-field-${f.testId}`,`"${f.name}" discoverable by SR`,"accessibility",8,false,`getByRole('${f.role}',{name:'${f.name}'}) not found`,s));
      } else {
        checks.push(check(`sr-field-${f.testId}`,`"${f.name}" discoverable by SR`,"accessibility",8,true,"Found by role+name"));
      }
    }

    // Unlabeled field check (the demo moment — or any configured field)
    if (formCfg.unlabeledField) {
      const loc = page.getByRole("textbox", { name: formCfg.unlabeledField });
      const ok  = await tryVisible(loc);
      const s   = ok ? null : await ss(page, paths, "sr-unlabeled");
      checks.push(check("sr-unlabeled",`"${formCfg.unlabeledField}" has accessible label`,"accessibility",15,ok,
        ok ? "Label found" : `"${formCfg.unlabeledField}" has no accessible label — axe passes (placeholder), SR fails`,s));
    }

    // Submit reachable
    if (formCfg.submitText) {
      const ok = await tryVisible(page.getByRole("button", { name: new RegExp(formCfg.submitText,"i") }));
      checks.push(check("sr-submit","Submit button has accessible name","accessibility",8,ok));
    }

    missions.push({ id:"create-form-sr", title:"Create form", checks, score:score(checks) });
  }

  // Modal focus (if configured)
  const modalCfg = cfg.missions?.cancelModal;
  if (modalCfg) {
    const checks = [];
    const modalRoute = cfg.routes.find(r => r.path===modalCfg.path) ?? { path:modalCfg.path };
    await loadPage(page, `${baseUrl}${modalCfg.path}`, modalRoute);

    try {
      await page.getByRole("button", { name: new RegExp(modalCfg.triggerText,"i") }).click();
      await page.waitForTimeout(600);
      const dialogOpen = await tryVisible(page.getByRole("dialog"), 2000);
      checks.push(check("sr-modal-open","Modal opens","accessibility",5,dialogOpen));
      if (dialogOpen) {
        const focusIn = await page.evaluate(() => { const d=document.querySelector("[role='dialog']"); return d?.contains(document.activeElement)??false; });
        const s = focusIn ? null : await ss(page, paths, "sr-modal-focus");
        checks.push(check("sr-modal-focus","Focus moves into dialog","accessibility",15,focusIn,focusIn?"Focus inside dialog":"Focus stayed on trigger — SR user cannot interact with modal",s));
      }
    } catch {}

    missions.push({ id:"cancel-modal-sr", title:"Cancel modal", checks, score:score(checks) });
  }

  return { personaId:"screen-reader", personaName:"Screen Reader User", missions, categoryScores:{ accessibility:catScore(missions,"accessibility"), completion:catScore(missions,"completion") }, overallScore: missions.length ? Math.round(missions.reduce((s,m)=>s+m.score,0)/missions.length) : 100 };
}

// ── Keyboard persona ─────────────────────────────────────────────────────────

async function runKeyboardPersona(page, cfg, paths, baseUrl) {
  const missions = [];
  const formCfg  = cfg.missions?.createForm;

  if (formCfg) {
    const checks = [];
    const formRoute = cfg.routes.find(r=>r.path===formCfg.path)??{path:formCfg.path};
    await loadPage(page, `${baseUrl}${formCfg.path}`, formRoute);

    // First Tab focus
    await page.keyboard.press("Tab");
    const firstTag = await page.evaluate(()=>document.activeElement?.tagName?.toLowerCase());
    checks.push(check("kb-first-tab","First Tab hits a control","keyboard",8,["a","button","input","select","textarea"].includes(firstTag),`first: <${firstTag}>`));

    // Focus indicator
    const hasFocus = await page.evaluate(() => {
      const btn = document.querySelector("button:not([disabled])");
      if (!btn) return true;
      btn.focus();
      const s = window.getComputedStyle(btn);
      return parseFloat(s.outlineWidth)>0||(s.boxShadow&&s.boxShadow!=="none");
    });
    const s1 = hasFocus ? null : await ss(page, paths, "kb-focus");
    checks.push(check("kb-focus-visible","Buttons have visible focus ring","keyboard",15,hasFocus,hasFocus?"Visible":"No outline or box-shadow — WCAG 2.4.7",s1));

    // Submit by keyboard
    let submitted = false;
    try {
      if (formCfg.fields?.[0]) {
        const f = formCfg.fields[0];
        await page.locator(`[data-testid='${f.testId}']`).fill(f.value ?? "Test").catch(()=>{});
      }
      const btn = page.getByRole("button", { name: new RegExp(formCfg.submitText ?? "submit","i") });
      await btn.first().focus();
      await page.keyboard.press("Enter");
      if (formCfg.successUrl) await page.waitForURL(formCfg.successUrl, { timeout:4000 });
      submitted = true;
    } catch {}
    const s2 = submitted ? null : await ss(page, paths, "kb-submit");
    checks.push(check("kb-submit","Form submittable via keyboard","keyboard",15,submitted,"",s2));
    checks.push(check("kb-complete","Keyboard journey completes","completion",20,submitted));

    missions.push({ id:"create-form-kb", title:"Create form", checks, score:score(checks) });
  }

  return { personaId:"keyboard", personaName:"Keyboard User", missions, categoryScores:{ keyboard:catScore(missions,"keyboard"), completion:catScore(missions,"completion") }, overallScore: missions.length ? Math.round(missions.reduce((s,m)=>s+m.score,0)/missions.length) : 100 };
}

// ── Mobile persona ───────────────────────────────────────────────────────────

async function runMobilePersona(browser, cfg, paths, baseUrl) {
  const vp = cfg.viewports?.mobile ?? { width:375, height:812 };
  const context = await browser.newContext({ viewport:{ width:vp.width, height:vp.height }, userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
  const page = await context.newPage();
  const missions = [];
  const minTouch = cfg.thresholds?.touchPx ?? 44;

  for (const route of cfg.routes.slice(0,2)) {
    const checks = [];
    await loadPage(page, `${baseUrl}${route.path}`, route);

    const overflow = await page.evaluate(()=>document.body.scrollWidth>window.innerWidth);
    const s1 = overflow ? await ss(page,paths,`mob-overflow-${route.path.replace(/\//g,"-")}`) : null;
    checks.push(check("mob-overflow",`No overflow at ${vp.width}px`,"responsiveness",20,!overflow,overflow?`scrollWidth exceeds ${vp.width}px`:"No overflow",s1));

    const small = await page.evaluate((min)=>{
      const bad=[];
      document.querySelectorAll("button,a[href],input,[role='button']").forEach(el=>{
        const r=el.getBoundingClientRect();
        if(r.width>0&&r.height>0&&(r.width<min||r.height<min)) bad.push({el:el.tagName.toLowerCase(),w:Math.round(r.width),h:Math.round(r.height)});
      });
      return bad.slice(0,5);
    }, minTouch);
    const s2 = small.length ? await ss(page,paths,`mob-touch-${route.path.replace(/\//g,"-")}`) : null;
    checks.push(check("mob-touch",`Touch targets ≥${minTouch}px`,"responsiveness",20,small.length===0,small.length?`${small.length} small: <${small[0].el}> ${small[0].w}×${small[0].h}px`:`All ≥${minTouch}px`,s2));

    let complete = false;
    const formCfg = cfg.missions?.createForm;
    if (formCfg && route.path === formCfg.path) {
      try {
        for (const f of (formCfg.fields||[]).slice(0,4)) {
          await page.locator(`[data-testid='${f.testId}']`).fill(f.value??"Test").catch(()=>{});
        }
        await page.getByRole("button",{name:new RegExp(formCfg.submitText??"submit","i")}).first().click();
        if (formCfg.successUrl) await page.waitForURL(formCfg.successUrl,{timeout:4000});
        complete = true;
      } catch {}
      checks.push(check("mob-complete","Mobile journey completes","completion",20,complete));
    }

    missions.push({ id:`browse-${route.path.replace(/\//g,"-")}`, title:route.name, checks, score:score(checks) });
  }

  await context.close();
  return { personaId:"mobile", personaName:"Mobile User", missions, categoryScores:{ responsiveness:catScore(missions,"responsiveness"), completion:catScore(missions,"completion") }, overallScore: missions.length ? Math.round(missions.reduce((s,m)=>s+m.score,0)/missions.length) : 100 };
}

// ── Senior persona ───────────────────────────────────────────────────────────

async function runSeniorPersona(page, cfg, paths, baseUrl) {
  const missions = [];
  const minCon   = cfg.thresholds?.contrast ?? 4.5;

  for (const route of cfg.routes.slice(0,2)) {
    const checks = [];
    await loadPage(page, `${baseUrl}${route.path}`, route);

    // Contrast
    const contrastFails = await page.evaluate((min)=>{
      const toL=c=>{const s=c/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4)};
      const lum=(r,g,b)=>0.2126*toL(r)+0.7152*toL(g)+0.0722*toL(b);
      const parse=s=>(s.match(/\d+/g)||[]).map(Number);
      const ratio=(fg,bg)=>{const[r1,g1,b1]=parse(fg),[r2,g2,b2]=parse(bg),l1=lum(r1,g1,b1),l2=lum(r2,g2,b2);return(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)};
      const fails=[];
      document.querySelectorAll("p,span,h1,h2,h3,td,th,label,a,button").forEach(el=>{
        const rect=el.getBoundingClientRect();
        if(!rect.width||!rect.height) return;
        const s=window.getComputedStyle(el);
        if(!s.backgroundColor||s.backgroundColor==="rgba(0, 0, 0, 0)") return;
        const r=ratio(s.color,s.backgroundColor);
        if(r<min) fails.push({el:el.tagName.toLowerCase(),cls:el.className?.toString().slice(0,30),ratio:Math.round(r*100)/100});
      });
      return fails.slice(0,5);
    }, minCon);
    const s1 = contrastFails.length ? await ss(page,paths,`sen-contrast-${route.path.replace(/\//g,"-")}`) : null;
    checks.push(check("sen-contrast","Text meets 4.5:1 contrast","accessibility",20,contrastFails.length===0,contrastFails.length?`${contrastFails.length} fail — e.g. .${contrastFails[0]?.cls} ratio=${contrastFails[0]?.ratio}`:"All pass",s1));

    // Image alt
    const noAlt = await page.evaluate(()=>Array.from(document.querySelectorAll("img")).filter(i=>!i.getAttribute("alt")&&!i.getAttribute("aria-label")).length);
    const s2 = noAlt ? await ss(page,paths,`sen-alt-${route.path.replace(/\//g,"-")}`) : null;
    checks.push(check("sen-img-alt","All images have alt text","accessibility",10,noAlt===0,noAlt?`${noAlt} image(s) missing alt`:"All have alt",s2));

    // Text size ≥14px
    const smallText = await page.evaluate(()=>{
      let n=0;
      document.querySelectorAll("p,td,li,span,label").forEach(el=>{
        const r=el.getBoundingClientRect();
        if(r.width>0&&r.height>0&&parseFloat(window.getComputedStyle(el).fontSize)<14) n++;
      });
      return n;
    });
    checks.push(check("sen-font-size","Body text ≥14px","accessibility",10,smallText===0,smallText?`${smallText} element(s) below 14px`:"All text ≥14px"));

    // Zoom reflow
    await page.evaluate(()=>{document.documentElement.style.fontSize="200%"});
    await page.waitForTimeout(300);
    const zoomOverflow = await page.evaluate(()=>document.body.scrollWidth>window.innerWidth+2);
    await page.evaluate(()=>{document.documentElement.style.fontSize=""});
    const s3 = zoomOverflow ? await ss(page,paths,`sen-zoom-${route.path.replace(/\//g,"-")}`) : null;
    checks.push(check("sen-zoom","Content reflows at 200% zoom","responsiveness",15,!zoomOverflow,zoomOverflow?"Content overflows at 200% font size":"Reflows cleanly",s3));

    missions.push({ id:`senior-${route.path.replace(/\//g,"-")}`, title:route.name, checks, score:score(checks) });
  }

  return { personaId:"senior", personaName:"Senior User", missions, categoryScores:{ accessibility:catScore(missions,"accessibility"), responsiveness:catScore(missions,"responsiveness") }, overallScore: missions.length ? Math.round(missions.reduce((s,m)=>s+m.score,0)/missions.length) : 100 };
}

// ── Run all personas ─────────────────────────────────────────────────────────

export async function runPersonas(browser, cfg, paths) {
  mkdirSync(paths.screenshots, { recursive:true });
  const baseUrl = process.env.BASE_URL ?? cfg.baseUrl;

  const enabledPersonas = cfg.personas ?? { screenReader:true, keyboard:true, mobile:true, senior:true };

  const ctx1    = await browser.newContext({ viewport:{ width:1280, height:800 } });
  const page1   = await ctx1.newPage();
  const results = [];

  if (enabledPersonas.screenReader?.enabled ?? enabledPersonas.screenReader) {
    process.stdout.write("   persona: screen reader...");
    try { results.push(await runScreenReaderPersona(page1, cfg, paths, baseUrl)); console.log(" done"); }
    catch(e) { console.log(` ⚠ ${e.message.split("\n")[0]}`); }
  }
  if (enabledPersonas.keyboard?.enabled ?? enabledPersonas.keyboard) {
    process.stdout.write("   persona: keyboard...");
    try { results.push(await runKeyboardPersona(page1, cfg, paths, baseUrl)); console.log(" done"); }
    catch(e) { console.log(` ⚠ ${e.message.split("\n")[0]}`); }
  }
  await ctx1.close();

  if (enabledPersonas.mobile?.enabled ?? enabledPersonas.mobile) {
    process.stdout.write("   persona: mobile...");
    try { results.push(await runMobilePersona(browser, cfg, paths, baseUrl)); console.log(" done"); }
    catch(e) { console.log(` ⚠ ${e.message.split("\n")[0]}`); }
  }

  const ctx2  = await browser.newContext({ viewport:{ width:1280, height:800 } });
  const page2 = await ctx2.newPage();
  if (enabledPersonas.senior?.enabled ?? enabledPersonas.senior) {
    process.stdout.write("   persona: senior...");
    try { results.push(await runSeniorPersona(page2, cfg, paths, baseUrl)); console.log(" done"); }
    catch(e) { console.log(` ⚠ ${e.message.split("\n")[0]}`); }
  }
  await ctx2.close();

  const allMissions = results.flatMap(p => p.missions);
  const overall = results.length ? Math.round(results.reduce((s,p)=>s+p.overallScore,0)/results.length) : 100;

  const catMap = {};
  for (const p of results) {
    for (const [cat, sc] of Object.entries(p.categoryScores)) {
      if (sc !== null) { catMap[cat] = catMap[cat] ?? []; catMap[cat].push(sc); }
    }
  }
  const categoryAverages = {};
  for (const [cat, scores] of Object.entries(catMap)) categoryAverages[cat] = Math.round(scores.reduce((a,b)=>a+b,0)/scores.length);

  const missionTable = allMissions.map(m => {
    const persona = results.find(p => p.missions.includes(m));
    return { persona:persona?.personaName??"", mission:m.title, score:m.score, checks:m.checks.length, passed:m.checks.filter(c=>c.pass).length, failed:m.checks.filter(c=>!c.pass).length, failures:m.checks.filter(c=>!c.pass).map(c=>({id:c.id,label:c.label,detail:c.detail,screenshot:c.screenshot})) };
  });

  return { generatedAt:new Date().toISOString(), target:baseUrl, overallScore:overall, categoryAverages, personas:results, missionTable };
}
