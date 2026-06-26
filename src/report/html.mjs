/**
 * src/report/html.mjs
 * UXRay — HTML report generator
 * Reads findings output + persona report → writes report.html
 */

import { writeFileSync } from "fs";

const scoreColor = s => s>=85?"#639922":s>=60?"#BA7517":"#E24B4A";
const scoreBg    = s => s>=85?"#EAF3DE":s>=60?"#FAEEDA":"#FCEBEB";
const scoreLabel = s => s>=85?"Pass":s>=60?"Needs work":"Fail";

function bar(score, width=120) {
  const fill = scoreColor(score);
  const pct  = Math.round((score/100)*width);
  return `<div style="display:inline-block;vertical-align:middle;background:#F1EFE8;border-radius:4px;height:7px;width:${width}px;overflow:hidden"><div style="background:${fill};width:${pct}px;height:100%;border-radius:4px"></div></div>`;
}

function severityBadge(sev) {
  const map = { critical:["#FCEBEB","#791F1F"], major:["#FAEEDA","#633806"], minor:["#F1EFE8","#444441"], "manual-required":["#EEEDFE","#3C3489"] };
  const [bg,fg] = map[sev] ?? ["#F1EFE8","#444441"];
  return `<span style="background:${bg};color:${fg};font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500">${sev}</span>`;
}

function sourceBadge(src) {
  const map = { axe:["#E6F1FB","#0C447C"], keyboard:["#EEEDFE","#3C3489"], screenReader:["#E1F5EE","#085041"], responsive:["#FAEEDA","#633806"], errors:["#FCEBEB","#791F1F"], "manual-required":["#F1EFE8","#5F5E5A"] };
  const [bg,fg] = map[src] ?? ["#F1EFE8","#444441"];
  return `<span style="background:${bg};color:${fg};font-size:11px;padding:2px 7px;border-radius:10px">${src}</span>`;
}

export async function generateHtmlReport(findingsOutput, personaReport, paths) {
  const findings   = (findingsOutput.findings ?? []).filter(f => f.source !== "manual-required");
  const manualGaps = (findingsOutput.findings ?? []).filter(f => f.source === "manual-required");
  const auditScore = findingsOutput.auditScore ?? 100;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UXRay — ${findingsOutput.appName ?? "Accessibility Report"}</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#F1EFE8;color:#3d3d3a;line-height:1.5}
.container{max-width:960px;margin:0 auto;padding:32px 20px}
h1{font-size:22px;font-weight:500;margin:0 0 4px}
h2{font-size:16px;font-weight:500;margin:28px 0 10px}
.meta{font-size:13px;color:#888780;margin-bottom:24px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:24px}
.stat{background:#fff;border:0.5px solid #D3D1C7;border-radius:8px;padding:12px 14px;text-align:center}
.stat-n{font-size:26px;font-weight:500}
.stat-l{font-size:11px;color:#888780;margin-top:2px}
.section{background:#fff;border:0.5px solid #D3D1C7;border-radius:10px;padding:18px 20px;margin-bottom:14px}
.finding{border:0.5px solid #E8E6DF;border-radius:8px;padding:10px 14px;margin-bottom:6px}
.finding-header{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.finding-title{font-size:13px;font-weight:500;color:#3d3d3a;flex:1}
.finding-desc{font-size:12px;color:#5F5E5A;line-height:1.5}
.finding-wcag{font-size:11px;color:#888780;margin-top:3px}
.finding img{max-width:100%;border-radius:6px;border:0.5px solid #D3D1C7;margin-top:8px;display:block}
.mission-row{display:grid;grid-template-columns:120px 1fr 100px 60px 80px;gap:8px;align-items:center;padding:8px 0;border-bottom:0.5px solid #F1EFE8;font-size:13px}
.mission-row:last-child{border-bottom:none}
.mission-header{display:grid;grid-template-columns:120px 1fr 100px 60px 80px;gap:8px;font-size:11px;font-weight:500;color:#888780;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:6px;border-bottom:0.5px solid #D3D1C7;margin-bottom:2px}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.cat{background:#F1EFE8;border-radius:6px;padding:10px 12px}
.cat-n{font-size:20px;font-weight:500}
.cat-l{font-size:11px;color:#5F5E5A;text-transform:capitalize}
.manual-item{padding:6px 0;border-bottom:0.5px solid #F1EFE8;font-size:12px;color:#5F5E5A}
.manual-item:last-child{border-bottom:none}
footer{text-align:center;font-size:12px;color:#888780;margin-top:32px;padding-bottom:24px}
</style>
</head>
<body>
<div class="container">

<h1>UXRay — ${findingsOutput.appName ?? "Accessibility Report"}</h1>
<div class="meta">
  ${new Date(findingsOutput.generatedAt).toLocaleString()} &nbsp;·&nbsp;
  <code>${findingsOutput.target}</code> &nbsp;·&nbsp;
  WCAG 2.1 AA &nbsp;·&nbsp; ~78% automated coverage
  ${findingsOutput.durationMs ? `&nbsp;·&nbsp; ${Math.round(findingsOutput.durationMs/1000)}s` : ""}
</div>

<div class="stat-grid">
  <div class="stat"><div class="stat-n" style="color:${scoreColor(auditScore)}">${auditScore}</div><div class="stat-l">audit score</div></div>
  ${personaReport ? `<div class="stat"><div class="stat-n" style="color:${scoreColor(personaReport.overallScore)}">${personaReport.overallScore}</div><div class="stat-l">persona score</div></div>` : ""}
  <div class="stat"><div class="stat-n">${findings.length}</div><div class="stat-l">findings</div></div>
  <div class="stat"><div class="stat-n" style="color:#E24B4A">${findings.filter(f=>f.severity==="critical").length}</div><div class="stat-l">critical</div></div>
  <div class="stat"><div class="stat-n" style="color:#BA7517">${findings.filter(f=>f.severity==="major").length}</div><div class="stat-l">major</div></div>
</div>

${personaReport ? `
<h2>User journey health scores</h2>
<div class="section">
  <div class="cat-grid" style="margin-bottom:16px">
    ${Object.entries(personaReport.categoryAverages ?? {}).map(([cat,sc]) => `
      <div class="cat">
        <div class="cat-n" style="color:${scoreColor(sc)}">${sc}</div>
        <div class="cat-l">${cat}</div>
      </div>`).join("")}
  </div>
  <div class="mission-header"><span>Persona</span><span>Mission</span><span>Score</span><span>Passed</span><span>Status</span></div>
  ${(personaReport.missionTable ?? []).map(m => `
    <div class="mission-row">
      <span style="color:#5F5E5A;font-size:12px">${m.persona}</span>
      <span style="font-weight:500">${m.mission}</span>
      <span>${bar(m.score,80)} <span style="font-size:13px;font-weight:500;color:${scoreColor(m.score)};margin-left:6px">${m.score}</span></span>
      <span style="font-size:12px;color:#5F5E5A">${m.passed}/${m.checks}</span>
      <span><span style="background:${scoreBg(m.score)};color:${scoreColor(m.score)};font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500">${scoreLabel(m.score)}</span></span>
    </div>`).join("")}
</div>` : ""}

<h2>Findings (${findings.length})</h2>
${["critical","major","minor"].map(sev => {
  const group = findings.filter(f => f.severity === sev);
  if (!group.length) return "";
  return `
<div class="section">
  <div style="font-size:12px;font-weight:500;color:#888780;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">${sev} — ${group.length}</div>
  ${group.map(f => `
  <div class="finding">
    <div class="finding-header">
      ${severityBadge(f.severity)}
      ${sourceBadge(f.source)}
      <span class="finding-title">${f.title}</span>
      <code style="font-size:11px;color:#888780">${f.route}</code>
    </div>
    <div class="finding-desc">${f.description}</div>
    <div class="finding-wcag">${(f.wcag??[]).join(" · ")}</div>
    ${f.screenshot ? `<img src="${f.screenshot}" alt="Screenshot: ${f.title}" loading="lazy">` : ""}
  </div>`).join("")}
</div>`;
}).join("")}

${personaReport?.missionTable?.some(m => m.failures?.length) ? `
<h2>Persona failures</h2>
<div class="section">
  ${(personaReport.missionTable ?? []).flatMap(m => (m.failures??[]).map(f => `
  <div class="finding">
    <div class="finding-header">
      <span style="background:#FAEEDA;color:#633806;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500">${m.persona}</span>
      <span style="font-size:11px;color:#888780">${m.mission}</span>
      <span class="finding-title">${f.label}</span>
    </div>
    ${f.detail ? `<div class="finding-desc">${f.detail}</div>` : ""}
    ${f.screenshot ? `<img src="${f.screenshot}" alt="Screenshot: ${f.label}" loading="lazy">` : ""}
  </div>`)).join("")}
</div>` : ""}

${manualGaps.length ? `
<h2>Manual review required (${new Set(manualGaps.map(g=>g.wcag?.[0])).size} WCAG SCs)</h2>
<div class="section">
  <p style="font-size:13px;color:#5F5E5A;margin:0 0 12px">These criteria cannot be automated — human review required to verify compliance.</p>
  ${[...new Set(manualGaps.map(g=>g.wcag?.[0]))].map(wcag => {
    const g = manualGaps.find(m=>m.wcag?.[0]===wcag);
    return `<div class="manual-item"><strong style="color:#3d3d3a">${wcag}</strong> — ${g?.description?.replace("[MANUAL] ","")??""}</div>`;
  }).join("")}
</div>` : ""}

<footer>
  UXRay &nbsp;·&nbsp; WCAG 2.1 AA &nbsp;·&nbsp;
  axe-core + keyboard (CDP) + virtual SR + responsiveness + personas &nbsp;·&nbsp;
  ~78% automated AA coverage
</footer>

</div>
</body>
</html>`;

  writeFileSync(paths.report, html);
}
