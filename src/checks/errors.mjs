import { join } from "path";
import { mkdirSync } from "fs";

async function ss(page,paths,id){try{const f=join(paths.screenshots,`err-${id}.png`);await page.screenshot({path:f,fullPage:false});return f;}catch{return null;}}

export async function runErrorChecks(browser, cfg, paths) {
  const findings=[];
  const baseUrl=process.env.BASE_URL??cfg.baseUrl;
  mkdirSync(paths.screenshots,{recursive:true});
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  const page=await context.newPage();

  for(const route of cfg.routes){
    const url=`${baseUrl}${route.path}`;
    process.stdout.write(`   err  ${route.name.padEnd(16)}`);
    let count=0;
    try{
      await page.goto(url,{waitUntil:"domcontentloaded",timeout:15000});
      if(route.waitFor)await page.locator(route.waitFor).waitFor({state:"visible",timeout:5000}).catch(()=>{});
      await page.waitForTimeout(400);
      const hasForm=await page.evaluate(()=>!!document.querySelector("form"));
      if(!hasForm){console.log(`→ no form`);continue;}

      const unlabeled=await page.evaluate(()=>{
        const issues=[];
        document.querySelectorAll("input[required],select[required],textarea[required]").forEach(el=>{
          const has=!!document.querySelector(`label[for="${el.id}"]`)||!!el.getAttribute("aria-label")||!!el.getAttribute("aria-labelledby")||!!el.closest("label");
          if(!has)issues.push({el:`${el.tagName.toLowerCase()}${el.id?"#"+el.id:""}`,type:el.getAttribute("type")||el.tagName.toLowerCase(),placeholder:el.getAttribute("placeholder")||""});
        });
        return issues;
      });
      for(const iss of unlabeled){
        const s=await ss(page,paths,`unlabeled-${route.path.replace(/\//g,"-")}`);
        findings.push({id:`err-label-${findings.length+1}`,route:route.path,source:"errors",severity:"critical",wcag:["WCAG 3.3.2","WCAG 1.3.1","WCAG 4.1.2"],title:"Required field has no label",description:`<${iss.el}> type="${iss.type}" is required but has no label. Placeholder "${iss.placeholder}" is not a substitute.`,screenshot:s});count++;
      }

      const prevUrl=page.url();
      await page.evaluate(()=>{const f=document.querySelector("form");const b=f?.querySelector("button[type='submit'],input[type='submit']");if(b)b.click();});
      await page.waitForTimeout(1000);
      if(page.url()!==prevUrl){console.log(`→ ${count} issue(s)`);continue;}

      const errs=await page.evaluate(()=>{
        const alerts=document.querySelectorAll("[role='alert'],[aria-live='assertive'],[aria-live='polite'],.error,[class*='error'],[class*='invalid']");
        const required=document.querySelectorAll("input[required],select[required],textarea[required]");
        const unassoc=[];
        alerts.forEach(el=>{if(!el.id)return;if(!document.querySelector(`[aria-describedby~="${el.id}"]`))unassoc.push(el.textContent.trim().slice(0,60));});
        return{alertCount:alerts.length,requiredCount:required.length,unassociated:unassoc,noErrors:alerts.length===0&&required.length>0};
      });
      if(errs.noErrors){const s=await ss(page,paths,`no-errors-${route.path.replace(/\//g,"-")}`);findings.push({id:`err-no-msg-${findings.length+1}`,route:route.path,source:"errors",severity:"major",wcag:["WCAG 3.3.1"],title:"Form shows no error messages on empty submit",description:`Form has ${errs.requiredCount} required field(s) but no error appeared after submitting empty.`,screenshot:s});count++;}
      for(const msg of errs.unassociated){findings.push({id:`err-assoc-${findings.length+1}`,route:route.path,source:"errors",severity:"minor",wcag:["WCAG 3.3.1"],title:"Error message not associated with input",description:`Error "${msg}" not referenced by any input's aria-describedby.`});count++;}

      console.log(`→ ${count} issue(s)`);
    }catch(err){console.log(`→ ⚠ ${err.message.split("\n")[0]}`);}
  }
  await context.close();
  return findings;
}
