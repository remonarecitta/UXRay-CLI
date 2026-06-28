import { writeFileSync } from "fs";

const IMPACT_MAP = [
  { match: (f) => f.source === "axe" && f.description?.includes("button-name"),
    who: "Screen reader users", what: "cannot identify or activate these buttons — they hear only \"button\" with no context", ux: "critical task blocker" },
  { match: (f) => f.source === "axe" && f.description?.includes("color-contrast"),
    who: "Low vision users, users in bright sunlight", what: "cannot read this text — contrast ratio is below the 4.5:1 minimum", ux: "content unreadable" },
  { match: (f) => f.source === "axe" && f.description?.includes("image-alt"),
    who: "Screen reader users", what: "hear only \"image\" — they get no information about what the image shows", ux: "missing context" },
  { match: (f) => f.source === "axe" && f.description?.includes("heading-order"),
    who: "Screen reader users navigating by headings", what: "lose their place in the page — the heading structure is inconsistent", ux: "navigation broken" },
  { match: (f) => f.source === "keyboard" && f.title?.includes("trap"),
    who: "Keyboard-only users", what: "cannot escape this element — they are permanently stuck and cannot use the rest of the page", ux: "page unusable" },
  { match: (f) => f.source === "keyboard" && f.title?.includes("skip"),
    who: "Keyboard-only and screen reader users", what: "must Tab through every nav link before reaching main content on every page load", ux: "severe friction on every page" },
  { match: (f) => f.source === "keyboard" && f.title?.includes("Escape"),
    who: "Keyboard-only users", what: "cannot dismiss this modal — they are stuck inside it with no way out", ux: "modal unusable" },
  { match: (f) => f.source === "keyboard" && f.title?.includes("Focus not moved"),
    who: "Screen reader users", what: "open this modal but focus stays on the trigger — they cannot interact with the modal content at all", ux: "modal unusable for screen readers" },
  { match: (f) => f.source === "keyboard" && f.title?.includes("Focus not returned"),
    who: "Keyboard-only and screen reader users", what: "lose their place after closing the modal — focus disappears to an unpredictable location", ux: "disorienting" },
  { match: (f) => f.source === "keyboard" && f.title?.includes("visible"),
    who: "Keyboard-only users", what: "cannot tell which element is focused — they are navigating blind", ux: "navigation impossible" },
  { match: (f) => f.source === "responsive" && f.title?.includes("overflow") && f.title?.includes("375"),
    who: "Mobile users (iPhone SE, most Android phones)", what: "must scroll horizontally to read content — the page is wider than the screen", ux: "mobile experience broken" },
  { match: (f) => f.source === "responsive" && f.title?.includes("overflow") && f.title?.includes("768"),
    who: "Tablet users (iPad portrait)", what: "must scroll horizontally — content overflows the viewport", ux: "tablet experience broken" },
  { match: (f) => f.source === "responsive" && f.title?.includes("Touch targets"),
    who: "Mobile users, users with motor impairments", what: "struggle to tap these controls accurately — targets are smaller than the 44px minimum", ux: "tap errors and frustration" },
  { match: (f) => f.source === "responsive" && f.title?.includes("Dark mode"),
    who: "Users who prefer dark mode", what: "cannot read this text — contrast drops below the minimum in dark mode", ux: "content unreadable in dark mode" },
  { match: (f) => f.source === "responsive" && f.title?.includes("landscape"),
    who: "Mobile users who rotate their device", what: "see content cut off or requiring horizontal scroll in landscape", ux: "landscape mode broken" },
  { match: (f) => f.source === "responsive" && f.title?.includes("text size"),
    who: "Users who increase OS text size", what: "see content overflow or overlap at 200% font size", ux: "text resize broken" },
  { match: (f) => f.source === "screenReader" && f.title?.includes("no accessible name"),
    who: "Screen reader users", what: "cannot identify this control — the screen reader announces only the element type with no label", ux: "control unidentifiable" },
  { match: (f) => f.source === "screenReader" && f.title?.includes("alt"),
    who: "Screen reader users", what: "get no information about this image — the screen reader announces \"image\" and moves on", ux: "missing content" },
  { match: (f) => f.source === "screenReader" && f.title?.includes("Heading order"),
    who: "Screen reader users navigating by headings", what: "encounter a gap in heading levels — page structure is inconsistent", ux: "navigation structure broken" },
  { match: (f) => f.source === "screenReader" && f.title?.includes("Vague link"),
    who: "Screen reader users browsing by links list", what: "hear \"click here\" with no context — they cannot tell where the link goes", ux: "link purpose unclear" },
  { match: (f) => f.source === "wcagExtended" && f.title?.includes("Non-text contrast"),
    who: "Low vision users", what: "cannot distinguish the boundary of this input field from the page background", ux: "form fields invisible" },
  { match: (f) => f.source === "wcagExtended" && f.title?.includes("aria-live"),
    who: "Screen reader users", what: "submit or cancel an action and hear nothing — they don\'t know if it succeeded or failed", ux: "outcome invisible to screen readers" },
  { match: (f) => f.source === "wcagExtended" && f.title?.includes("Label in name"),
    who: "Voice control users (Dragon NaturallySpeaking, Voice Control)", what: "say the visible label aloud but the control doesn\'t respond — visible text and accessible name don\'t match", ux: "voice control broken" },
  { match: (f) => f.source === "wcagExtended" && f.title?.includes("placeholder"),
    who: "Screen reader users", what: "start typing and lose the label — placeholder disappears on input and is not reliably announced", ux: "field purpose lost mid-task" },
  { match: (f) => f.source === "errors" && f.title?.includes("no label"),
    who: "Screen reader users", what: "cannot identify what this field is for — no label is announced when they focus it", ux: "form field purpose unknown" },
  { match: (f) => f.source === "errors" && f.title?.includes("no error"),
    who: "All users, especially screen reader users", what: "submit the form and hear nothing — they don\'t know what went wrong or which fields to fix", ux: "form failure silent" },
  { match: (f) => f.source === "errors" && f.title?.includes("not associated"),
    who: "Screen reader users", what: "hear an error message but cannot tell which field it belongs to", ux: "error location unknown" },
];

function getImpact(finding) {
  return IMPACT_MAP.find((rule) => {
    try { return rule.match(finding); } catch { return false; }
  }) || null;
}


function getScoreColor(score) {
  if (score >= 85) return "#639922";
  if (score >= 60) return "#BA7517";
  return "#E24B4A";
}

function getScoreBackground(score) {
  if (score >= 85) return "#EAF3DE";
  if (score >= 60) return "#FAEEDA";
  return "#FCEBEB";
}

function getScoreLabel(score) {
  if (score >= 85) return "Pass";
  if (score >= 60) return "Needs work";
  return "Fail";
}

function renderRadialScore(score, label, size = 120) {
  const color         = getScoreColor(score);
  const radius        = (size / 2) - 10;
  const circumference = 2 * Math.PI * radius;
  const filled        = (score / 100) * circumference;
  const trackColor    = score >= 85 ? "#C6DFA6" : score >= 60 ? "#F0D4A0" : "#F5BFBF";
  const fontSize      = size === 120 ? 26 : 18;

  return `
  <div style="display:flex;flex-direction:column;align-items:center">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke="${trackColor}" stroke-width="8" transform="rotate(-90 ${size/2} ${size/2})"/>
      <circle cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke="${color}" stroke-width="8"
        stroke-dasharray="${filled} ${circumference - filled}" stroke-linecap="round"
        transform="rotate(-90 ${size/2} ${size/2})"/>
      <text x="${size/2}" y="${size/2 - 6}" text-anchor="middle" dominant-baseline="middle"
        font-size="${fontSize}" font-weight="600" fill="${color}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${score}</text>
      <text x="${size/2}" y="${size/2 + fontSize - 2}" text-anchor="middle" dominant-baseline="middle"
        font-size="11" fill="rgba(255,255,255,0.55)" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${label}</text>
    </svg>
  </div>`;
}

function renderProgressBar(score, width = 120) {
  const fillColor = getScoreColor(score);
  const fillWidth = Math.round((score / 100) * width);
  return `<div style="display:inline-block;vertical-align:middle;background:#F1EFE8;border-radius:4px;height:7px;width:${width}px;overflow:hidden"><div style="background:${fillColor};width:${fillWidth}px;height:100%;border-radius:4px"></div></div>`;
}

function renderSeverityBadge(severity) {
  const colorMap = {
    critical:          ["#FCEBEB", "#791F1F"],
    major:             ["#FAEEDA", "#633806"],
    minor:             ["#F1EFE8", "#444441"],
    "manual-required": ["#EEEDFE", "#3C3489"],
  };
  const [bg, fg] = colorMap[severity] ?? ["#F1EFE8", "#444441"];
  return `<span style="background:${bg};color:${fg};font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500">${severity}</span>`;
}

function renderSourceBadge(source) {
  const colorMap = {
    axe:               ["#E6F1FB", "#0C447C"],
    keyboard:          ["#EEEDFE", "#3C3489"],
    screenReader:      ["#E1F5EE", "#085041"],
    responsive:        ["#FAEEDA", "#633806"],
    errors:            ["#FCEBEB", "#791F1F"],
    wcagExtended:      ["#F5EDF8", "#5C2D7A"],
    "manual-required": ["#F1EFE8", "#5F5E5A"],
  };
  const [bg, fg] = colorMap[source] ?? ["#F1EFE8", "#444441"];
  return `<span style="background:${bg};color:${fg};font-size:11px;padding:2px 7px;border-radius:10px">${source}</span>`;
}

function renderScoringExplainer(findings, scoringWeights) {
  const automated  = findings.filter((f) => f.source !== "manual-required");
  const criticals  = automated.filter((f) => f.severity === "critical").length;
  const majors     = automated.filter((f) => f.severity === "major").length;
  const minors     = automated.filter((f) => f.severity === "minor").length;
  const deductions = criticals * (scoringWeights?.critical || 10) + majors * (scoringWeights?.major || 5) + minors * (scoringWeights?.minor || 2);

  return `
  <div style="background:#FAFAF8;border:0.5px solid #E8E6DF;border-radius:8px;padding:14px 16px;margin-top:16px">
    <div style="font-size:12px;font-weight:500;color:#888780;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">How the score is calculated</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
      <div style="background:#FCEBEB;border-radius:6px;padding:8px 10px">
        <div style="font-size:18px;font-weight:600;color:#791F1F">${criticals} × 10</div>
        <div style="font-size:11px;color:#A32D2D;margin-top:2px">critical findings</div>
      </div>
      <div style="background:#FAEEDA;border-radius:6px;padding:8px 10px">
        <div style="font-size:18px;font-weight:600;color:#633806">${majors} × 5</div>
        <div style="font-size:11px;color:#854F0B;margin-top:2px">major findings</div>
      </div>
      <div style="background:#F1EFE8;border-radius:6px;padding:8px 10px">
        <div style="font-size:18px;font-weight:600;color:#444441">${minors} × 2</div>
        <div style="font-size:11px;color:#5F5E5A;margin-top:2px">minor findings</div>
      </div>
    </div>
    <div style="font-size:12px;color:#5F5E5A;border-top:0.5px solid #E8E6DF;padding-top:10px">
      100 − (${criticals}×10 + ${majors}×5 + ${minors}×2) = 100 − ${deductions} = <strong style="color:${getScoreColor(Math.max(0, 100 - deductions))}">${Math.max(0, 100 - deductions)}</strong>
      &nbsp;·&nbsp; Weights are configurable in <code>uxray.config.js</code> via <code>scoring: { critical, major, minor }</code>
    </div>
  </div>`;
}

function toRelativeScreenshotPath(absolutePath, reportDir) {
  if (!absolutePath) return null;
  const screenshotsDir = absolutePath.includes("/screenshots/")
    ? absolutePath.substring(absolutePath.indexOf("/screenshots/") + 1)
    : absolutePath.split("/").slice(-2).join("/");
  return screenshotsDir;
}

export async function generateHtmlReport(findingsOutput, personaReport, paths) {
  const automatedFindings = (findingsOutput.findings ?? []).filter((f) => f.source !== "manual-required");
  const manualGaps        = (findingsOutput.findings ?? []).filter((f) => f.source === "manual-required");
  const auditScore        = findingsOutput.auditScore ?? 100;
  const personaScore      = personaReport?.overallScore ?? null;
  const scoringWeights    = { critical: 10, major: 5, minor: 2 };

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
h2{font-size:16px;font-weight:500;margin:32px 0 10px;color:#3d3d3a}
.meta{font-size:13px;color:#888780;margin-bottom:28px}
.hero{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);border-radius:16px;padding:32px;margin-bottom:24px;color:#fff}
.hero-title{font-size:24px;font-weight:600;margin:0 0 4px;color:#fff}
.hero-sub{font-size:13px;color:rgba(255,255,255,0.6);margin-bottom:28px}
.scores-row{display:flex;align-items:center;gap:32px;flex-wrap:wrap}
.score-divider{width:1px;height:80px;background:rgba(255,255,255,0.15)}
.hero-stats{display:flex;gap:24px;flex-wrap:wrap}
.hero-stat{text-align:center}
.hero-stat-n{font-size:28px;font-weight:600;line-height:1}
.hero-stat-l{font-size:11px;color:rgba(255,255,255,0.55);margin-top:3px}
.severity-strip{display:flex;gap:8px;margin-top:20px;flex-wrap:wrap}
.sev-pill{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.1);border-radius:20px;padding:5px 12px;font-size:12px;color:#fff}
.sev-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.section{background:#fff;border:0.5px solid #D3D1C7;border-radius:10px;padding:18px 20px;margin-bottom:14px}
.section-title{font-size:12px;font-weight:500;color:#888780;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px}
.finding{border:0.5px solid #E8E6DF;border-radius:8px;padding:10px 14px;margin-bottom:6px}
.finding:last-child{margin-bottom:0}
.finding-header{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.finding-title{font-size:13px;font-weight:500;color:#3d3d3a;flex:1;min-width:0}
.finding-desc{font-size:12px;color:#5F5E5A;line-height:1.5}
.finding-wcag{font-size:11px;color:#aaa89f;margin-top:3px}
.finding img{max-width:100%;border-radius:6px;border:0.5px solid #D3D1C7;margin-top:8px;display:block}
.mission-row{display:grid;grid-template-columns:130px 1fr 110px 60px 90px;gap:8px;align-items:center;padding:8px 0;border-bottom:0.5px solid #F1EFE8;font-size:13px}
.mission-row:last-child{border-bottom:none}
.mission-header{display:grid;grid-template-columns:130px 1fr 110px 60px 90px;gap:8px;font-size:11px;font-weight:500;color:#888780;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:8px;border-bottom:0.5px solid #D3D1C7;margin-bottom:2px}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:16px}
.cat{border-radius:8px;padding:12px 14px;position:relative;overflow:hidden}
.cat-n{font-size:22px;font-weight:600}
.cat-l{font-size:11px;margin-top:2px;text-transform:capitalize;opacity:0.75}
.cat-accent{background:linear-gradient(135deg,#EAF3DE,#D4EDAB)}
.cat-warn{background:linear-gradient(135deg,#FAEEDA,#F5D49A)}
.cat-fail{background:linear-gradient(135deg,#FCEBEB,#F5BFBF)}
.manual-item{padding:7px 0;border-bottom:0.5px solid #F1EFE8;font-size:12px;color:#5F5E5A;display:flex;gap:10px;align-items:baseline}
.manual-item:last-child{border-bottom:none}
.wcag-tag{font-size:11px;font-weight:500;color:#3C3489;background:#EEEDFE;padding:2px 7px;border-radius:8px;white-space:nowrap;flex-shrink:0}
footer{text-align:center;font-size:12px;color:#888780;margin-top:40px;padding-bottom:28px;border-top:0.5px solid #D3D1C7;padding-top:20px}
</style>
</head>
<body>
<div class="container">

<div class="hero">
  <div class="hero-title">UXRay — ${findingsOutput.appName ?? "Accessibility Report"}</div>
  <div class="hero-sub">
    ${new Date(findingsOutput.generatedAt).toLocaleString()}
    &nbsp;·&nbsp; <code style="background:rgba(255,255,255,0.1);padding:1px 6px;border-radius:4px;font-size:12px">${findingsOutput.target}</code>
    &nbsp;·&nbsp; WCAG 2.1 AA &nbsp;·&nbsp; ~80% automated coverage
    ${findingsOutput.durationMs ? `&nbsp;·&nbsp; ${Math.round(findingsOutput.durationMs / 1000)}s` : ""}
  </div>

  <div class="scores-row">
    ${renderRadialScore(auditScore, "audit score", 120)}
    ${personaScore != null ? `<div class="score-divider"></div>${renderRadialScore(personaScore, "persona score", 120)}` : ""}
    <div class="score-divider"></div>
    <div class="hero-stats">
      <div class="hero-stat">
        <div class="hero-stat-n">${automatedFindings.length}</div>
        <div class="hero-stat-l">findings</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-n" style="color:#F5BFBF">${automatedFindings.filter((f) => f.severity === "critical").length}</div>
        <div class="hero-stat-l">critical</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-n" style="color:#F5D49A">${automatedFindings.filter((f) => f.severity === "major").length}</div>
        <div class="hero-stat-l">major</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-n" style="color:rgba(255,255,255,0.7)">${automatedFindings.filter((f) => f.severity === "minor").length}</div>
        <div class="hero-stat-l">minor</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-n" style="color:rgba(255,255,255,0.5)">${manualGaps.length}</div>
        <div class="hero-stat-l">manual gaps</div>
      </div>
    </div>
  </div>

  <div class="severity-strip">
    <div class="sev-pill"><div class="sev-dot" style="background:#F5BFBF"></div>Critical — blocked for screen readers, keyboard, assistive tech</div>
    <div class="sev-pill"><div class="sev-dot" style="background:#F5D49A"></div>Major — real barriers with WCAG citation</div>
    <div class="sev-pill"><div class="sev-dot" style="background:rgba(255,255,255,0.4)"></div>Minor — usability issues, lower impact</div>
  </div>
</div>

${renderScoringExplainer(findingsOutput.findings ?? [], scoringWeights)}

${personaReport ? `
<h2>User journey health scores</h2>
<div class="section">
  <div class="cat-grid">
    ${Object.entries(personaReport.categoryAverages ?? {}).map(([category, categoryScore]) => `
    <div class="cat ${categoryScore >= 85 ? "cat-accent" : categoryScore >= 60 ? "cat-warn" : "cat-fail"}">
      <div class="cat-n" style="color:${getScoreColor(categoryScore)}">${categoryScore}</div>
      <div class="cat-l" style="color:${getScoreColor(categoryScore)}">${category}</div>
    </div>`).join("")}
  </div>
  <div class="mission-header">
    <span>Persona</span><span>Mission</span><span>Score</span><span>Passed</span><span>Status</span>
  </div>
  ${(personaReport.missionTable ?? []).map((mission) => `
  <div class="mission-row">
    <span style="color:#5F5E5A;font-size:12px">${mission.persona}</span>
    <span style="font-weight:500;font-size:13px">${mission.mission}</span>
    <span style="display:flex;align-items:center;gap:6px">
      ${renderProgressBar(mission.score, 70)}
      <span style="font-size:13px;font-weight:600;color:${getScoreColor(mission.score)}">${mission.score}</span>
    </span>
    <span style="font-size:12px;color:#5F5E5A">${mission.passed}/${mission.checks}</span>
    <span><span style="background:${getScoreBackground(mission.score)};color:${getScoreColor(mission.score)};font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500">${getScoreLabel(mission.score)}</span></span>
  </div>`).join("")}
</div>` : ""}

<h2>Findings (${automatedFindings.length})</h2>
${["critical", "major", "minor"].map((severity) => {
  const group = automatedFindings.filter((f) => f.severity === severity);
  if (!group.length) return "";
  const headerColors = { critical: ["#FFF0F0", "#A32D2D"], major: ["#FFF8EE", "#854F0B"], minor: ["#F8F8F5", "#5F5E5A"] };
  const [headerBg, headerColor] = headerColors[severity];
  return `
<div class="section" style="padding:0;overflow:hidden">
  <div style="background:${headerBg};padding:10px 20px;border-bottom:0.5px solid #E8E6DF">
    <span style="font-size:12px;font-weight:600;color:${headerColor};text-transform:uppercase;letter-spacing:0.5px">${severity}</span>
    <span style="font-size:12px;color:${headerColor};opacity:0.7;margin-left:6px">— ${group.length} finding${group.length !== 1 ? "s" : ""}</span>
  </div>
  <div style="padding:12px 20px">
  ${group.map((finding) => `
  <div class="finding">
    <div class="finding-header">
      ${renderSeverityBadge(finding.severity)}
      ${renderSourceBadge(finding.source)}
      <span class="finding-title">${finding.title}</span>
      <code style="font-size:11px;color:#aaa89f;background:#F5F4F0;padding:1px 6px;border-radius:4px">${finding.route}</code>
    </div>
    <div class="finding-desc">${finding.description}</div>
    ${(() => {
      const impact = getImpact(finding);
      if (!impact) return "";
      return `<div style="margin-top:8px;padding:8px 10px;background:#F5F4F0;border-radius:6px;border-left:3px solid #D3D1C7">
        <div style="font-size:11px;font-weight:600;color:#5F5E5A;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px">Impact</div>
        <div style="font-size:12px;color:#3d3d3a;margin-bottom:3px"><strong style="color:#791F1F">Who:</strong> ${impact.who}</div>
        <div style="font-size:12px;color:#3d3d3a;margin-bottom:3px"><strong style="color:#633806">What breaks:</strong> ${impact.what}</div>
        <div style="font-size:12px;color:#3d3d3a"><strong style="color:#444441">UX effect:</strong> <span style="background:#F1EFE8;padding:1px 6px;border-radius:4px;font-size:11px">${impact.ux}</span></div>
      </div>`;
    })()}
    <div class="finding-wcag">${(finding.wcag ?? []).join(" · ")}</div>
    ${finding.screenshot ? `<img src="${toRelativeScreenshotPath(finding.screenshot, paths.dir)}" alt="Screenshot: ${finding.title}" loading="lazy">` : ""}
  </div>`).join("")}
  </div>
</div>`;
}).join("")}

${personaReport?.missionTable?.some((mission) => mission.failures?.length) ? `
<h2>Persona failures</h2>
<div class="section">
  ${(personaReport.missionTable ?? []).flatMap((mission) =>
    (mission.failures ?? []).map((failure) => `
    <div class="finding">
      <div class="finding-header">
        <span style="background:#E1F5EE;color:#085041;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500">${mission.persona}</span>
        <span style="font-size:11px;color:#888780;background:#F5F4F0;padding:1px 6px;border-radius:4px">${mission.mission}</span>
        <span class="finding-title">${failure.label}</span>
      </div>
      ${failure.detail ? `<div class="finding-desc">${failure.detail}</div>` : ""}
      ${failure.screenshot ? `<img src="${toRelativeScreenshotPath(failure.screenshot, paths.dir)}" alt="Screenshot: ${failure.label}" loading="lazy">` : ""}
    </div>`)
  ).join("")}
</div>` : ""}

${manualGaps.length ? `
<h2>Manual review required (${new Set(manualGaps.map((gap) => gap.wcag?.[0])).size} WCAG criteria)</h2>
<div class="section">
  <div style="font-size:13px;color:#5F5E5A;margin-bottom:14px;padding-bottom:12px;border-bottom:0.5px solid #F1EFE8">
    These criteria cannot be fully automated — human review is required to verify compliance with WCAG 2.1 AA.
  </div>
  ${[...new Set(manualGaps.map((gap) => gap.wcag?.[0]))].map((wcag) => {
    const gap = manualGaps.find((item) => item.wcag?.[0] === wcag);
    return `<div class="manual-item">
      <span class="wcag-tag">${wcag}</span>
      <span>${gap?.description?.replace("[MANUAL] ", "") ?? ""}</span>
    </div>`;
  }).join("")}
</div>` : ""}

<footer>
  UXRay &nbsp;·&nbsp; WCAG 2.1 AA &nbsp;·&nbsp;
  axe-core + keyboard (CDP) + virtual SR + responsiveness + personas &nbsp;·&nbsp;
  ~80% automated AA coverage
</footer>

</div>
</body>
</html>`;

  writeFileSync(paths.report, html);
}