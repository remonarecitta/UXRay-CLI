import { AxeBuilder } from "@axe-core/playwright";

const SEVERITY_MAP = { critical:"critical", serious:"critical", moderate:"major", minor:"minor" };

function wcagTags(v) {
  const tags = (v.tags||[]).filter(t=>/^wcag\d/.test(t));
  if (tags.length) return tags.map(t=>`WCAG ${t.replace("wcag","").replace(/(\d)(\d+)/,"$1.$2")}`);
  return ["WCAG (unknown)"];
}

export async function runAxeChecks(browser, cfg, paths) {
  const findings = [];
  const context  = await browser.newContext({ viewport:{ width:1280, height:800 } });
  const page     = await context.newPage();
  const baseUrl  = process.env.BASE_URL ?? cfg.baseUrl;

  for (const route of cfg.routes) {
    const url = `${baseUrl}${route.path}`;
    process.stdout.write(`   axe  ${route.name.padEnd(16)}`);
    try {
      await page.goto(url, { waitUntil:"domcontentloaded", timeout:15000 });
      if (route.waitFor) await page.locator(route.waitFor).waitFor({ state:"visible", timeout:5000 }).catch(()=>{});
      await page.waitForTimeout(400);
      const results = await new AxeBuilder({ page }).analyze();
      for (const v of results.violations) {
        findings.push({ id:`axe-${findings.length+1}`, route:route.path, source:"axe", severity:SEVERITY_MAP[v.impact]??"minor", wcag:wcagTags(v), title:v.description, description:`[${v.id}] ${v.help} — ${v.nodes.length} node(s). ${v.helpUrl}` });
      }
      console.log(`→ ${results.violations.length} violation(s)`);
    } catch(err) { console.log(`→ ⚠ ${err.message.split("\n")[0]}`); }
  }
  await context.close();
  return findings;
}
