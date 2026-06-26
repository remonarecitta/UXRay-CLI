import { join } from "path";
import { mkdirSync } from "fs";

const GET_A11Y_TREE = () => {
  function getName(el) {
    const lb=el.getAttribute("aria-labelledby"); if(lb){const n=lb.split(/\s+/).map(id=>document.getElementById(id)?.textContent?.trim()).filter(Boolean);if(n.length)return{name:n.join(" "),source:"aria-labelledby"};}
    const al=el.getAttribute("aria-label"); if(al?.trim())return{name:al.trim(),source:"aria-label"};
    if(el.id){const l=document.querySelector(`label[for="${el.id}"]`);if(l)return{name:l.textContent.trim(),source:"label[for]"};}
    const pl=el.closest("label"); if(pl){const c=pl.cloneNode(true);c.querySelectorAll("input,select,textarea").forEach(e=>e.remove());const t=c.textContent.trim();if(t)return{name:t,source:"label[wrap]"};}
    const ti=el.getAttribute("title"); if(ti?.trim())return{name:ti.trim(),source:"title"};
    const ph=el.getAttribute("placeholder"); if(ph?.trim())return{name:ph.trim(),source:"placeholder"};
    const it=el.textContent?.trim(); if(it)return{name:it.slice(0,80),source:"inner-text"};
    return{name:"",source:"none"};
  }
  function getRole(el){
    const ex=el.getAttribute("role");if(ex)return ex;
    const tag=el.tagName.toLowerCase(),type=el.getAttribute("type")?.toLowerCase();
    const map={a:"link",button:"button",h1:"heading",h2:"heading",h3:"heading",h4:"heading",h5:"heading",h6:"heading",input:type==="checkbox"?"checkbox":type==="radio"?"radio":type==="submit"?"button":"textbox",select:"combobox",textarea:"textbox",img:"img",nav:"navigation",main:"main",dialog:"dialog"};
    return map[tag]||tag;
  }
  const INTERACTIVE=["textbox","combobox","button","link","checkbox","radio","slider","menuitem","tab"];
  const sel="a[href],button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,img,[aria-label],[aria-labelledby],[tabindex]";
  const seen=new Set(),tree=[];
  document.querySelectorAll(sel).forEach(el=>{
    if(seen.has(el))return;seen.add(el);
    const rect=el.getBoundingClientRect();if(!rect.width&&!rect.height)return;
    const{name,source}=getName(el),role=getRole(el),isWeak=source==="placeholder"||source==="none",isInteractive=INTERACTIVE.includes(role);
    const violation=(!name&&isInteractive)?`${role} has no accessible name`:(isWeak&&["textbox","combobox"].includes(role))?`${role} name from ${source} — axe passes but SR users hear placeholder only`:null;
    const level=el.tagName.match(/H(\d)/)?.[1];
    tree.push({tag:el.tagName.toLowerCase(),id:el.id||"",testId:el.getAttribute("data-testid")||"",role,name,source,isWeak,isInteractive,violation,level:level?parseInt(level):null,altText:el.getAttribute("alt"),href:el.getAttribute("href")||""});
  });
  return tree;
};

async function ss(page,paths,id){try{const f=join(paths.screenshots,`sr-${id}.png`);await page.screenshot({path:f,fullPage:false});return f;}catch{return null;}}

export async function runScreenReaderChecks(browser, cfg, paths) {
  const findings=[];
  const baseUrl=process.env.BASE_URL??cfg.baseUrl;
  mkdirSync(paths.screenshots,{recursive:true});
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  const page=await context.newPage();

  for(const route of cfg.routes){
    const url=`${baseUrl}${route.path}`;
    process.stdout.write(`   sr   ${route.name.padEnd(16)}`);
    let count=0;
    try{
      await page.goto(url,{waitUntil:"domcontentloaded",timeout:15000});
      if(route.waitFor)await page.locator(route.waitFor).waitFor({state:"visible",timeout:5000}).catch(()=>{});
      await page.waitForTimeout(400);
      const tree=await page.evaluate(GET_A11Y_TREE);

      const unnamed=[...new Map(tree.filter(n=>n.violation&&n.isInteractive).map(n=>[`${n.role}|${n.testId}`,n])).values()];
      for(const n of unnamed.slice(0,5)){
        const s=await ss(page,paths,`unnamed-${n.testId||n.tag}-${route.path.replace(/\//g,"-")}`);
        findings.push({id:`sr-name-${findings.length+1}`,route:route.path,source:"screenReader",severity:n.source==="none"?"critical":"major",wcag:["WCAG 4.1.2","WCAG 1.3.1"],title:`${n.role} has no accessible name`,description:n.violation,screenshot:s});count++;
      }
      if(unnamed.length>5){findings.push({id:`sr-bulk-${findings.length+1}`,route:route.path,source:"screenReader",severity:"critical",wcag:["WCAG 4.1.2"],title:`${unnamed.length-5} more unnamed interactive elements`,description:`Total ${unnamed.length} elements with no accessible name.`});count++;}

      const headings=tree.filter(n=>n.role==="heading"&&n.level);
      for(let i=1;i<headings.length;i++){
        if(headings[i].level-headings[i-1].level>1){
          const s=await ss(page,paths,`headings-${route.path.replace(/\//g,"-")}`);
          findings.push({id:`sr-heading-${findings.length+1}`,route:route.path,source:"screenReader",severity:"minor",wcag:["WCAG 1.3.1"],title:"Heading order skips a level",description:`H${headings[i-1].level} "${headings[i-1].name.slice(0,30)}" → H${headings[i].level} "${headings[i].name.slice(0,30)}"`,screenshot:s});count++;break;
        }
      }

      for(const img of tree.filter(n=>n.role==="img")){
        if(img.altText===null||img.altText===undefined){
          const s=await ss(page,paths,`img-${route.path.replace(/\//g,"-")}`);
          findings.push({id:`sr-img-${findings.length+1}`,route:route.path,source:"screenReader",severity:"critical",wcag:["WCAG 1.1.1"],title:"Image has no alt attribute",description:`<img${img.id?"#"+img.id:""}> missing alt — SR announces "image" with no context.`,screenshot:s});count++;
        }
      }

      const vague=["click here","here","read more","learn more","more","link","this","go"];
      for(const link of tree.filter(n=>n.role==="link")){
        if(vague.includes(link.name.toLowerCase().trim())){
          findings.push({id:`sr-link-${findings.length+1}`,route:route.path,source:"screenReader",severity:"minor",wcag:["WCAG 2.4.4"],title:`Vague link text: "${link.name}"`,description:`"${link.name}" gives no context. SR users browsing by links cannot tell where this goes.`});count++;
        }
      }

      console.log(`→ ${count} issue(s)`);
    }catch(err){console.log(`→ ⚠ ${err.message.split("\n")[0]}`);}
  }
  await context.close();
  return findings;
}
