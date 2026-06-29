import { writeFileSync, readFileSync, existsSync } from "fs";


/* SCORE HELPERS */

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

function screenshotToDataUri(screenshotPath) {
  if (!screenshotPath) return null;

  const normalisedPath = screenshotPath.replace(/\\/g, "/");

  try {
    if (existsSync(normalisedPath)) {
      const imageBuffer = readFileSync(normalisedPath);
      return `data:image/png;base64,${imageBuffer.toString("base64")}`;
    }
    return null;
  } catch {
    return null;
  }
}


/* HTML RENDERERS */

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
        <circle
          cx="${size / 2}" cy="${size / 2}" r="${radius}"
          fill="none" stroke="${trackColor}" stroke-width="8"
          transform="rotate(-90 ${size / 2} ${size / 2})"
        />
        <circle
          cx="${size / 2}" cy="${size / 2}" r="${radius}"
          fill="none" stroke="${color}" stroke-width="8"
          stroke-dasharray="${filled} ${circumference - filled}"
          stroke-linecap="round"
          transform="rotate(-90 ${size / 2} ${size / 2})"
        />
        <text
          x="${size / 2}" y="${size / 2 - 6}"
          text-anchor="middle" dominant-baseline="middle"
          font-size="${fontSize}" font-weight="600"
          fill="${color}" font-family="-apple-system,BlinkMacSystemFont,sans-serif"
        >${score}</text>
        <text
          x="${size / 2}" y="${size / 2 + fontSize - 2}"
          text-anchor="middle" dominant-baseline="middle"
          font-size="11" fill="rgba(255,255,255,0.55)"
          font-family="-apple-system,BlinkMacSystemFont,sans-serif"
        >${label}</text>
      </svg>
    </div>`;
}

function renderProgressBar(score, width = 120) {
  const fillColor = getScoreColor(score);
  const fillWidth = Math.round((score / 100) * width);

  return `
    <div style="display:inline-block;vertical-align:middle;background:#F1EFE8;border-radius:4px;height:7px;width:${width}px;overflow:hidden">
      <div style="background:${fillColor};width:${fillWidth}px;height:100%;border-radius:4px"></div>
    </div>`;
}

function renderSeverityBadge(severity) {
  const colorMap = {
    critical:          ["#FCEBEB", "#791F1F"],
    major:             ["#FAEEDA", "#633806"],
    minor:             ["#F1EFE8", "#444441"],
    "manual-required": ["#EEEDFE", "#3C3489"],
  };

  const [background, foreground] = colorMap[severity] ?? ["#F1EFE8", "#444441"];

  return `<span style="background:${background};color:${foreground};font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500">${severity}</span>`;
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

  const [background, foreground] = colorMap[source] ?? ["#F1EFE8", "#444441"];

  return `<span style="background:${background};color:${foreground};font-size:11px;padding:2px 7px;border-radius:10px">${source}</span>`;
}

function renderBedrockFix(finding) {
  if (!finding.fix) return "";

  return `
    <div class="finding-fix">
      <div class="finding-fix__label">⚡ AI Fix (Bedrock)</div>
      ${finding.fix.description ? `<p class="finding-fix__desc">${finding.fix.description}</p>` : ""}
      ${finding.fix.before && finding.fix.after ? `
        <div class="finding-fix__diff">
          <div class="finding-fix__diff-block finding-fix__diff-block--before">
            <span class="finding-fix__diff-label">Before</span>
            <pre>${finding.fix.before}</pre>
          </div>
          <div class="finding-fix__diff-block finding-fix__diff-block--after">
            <span class="finding-fix__diff-label">After</span>
            <pre>${finding.fix.after}</pre>
          </div>
        </div>
      ` : ""}
    </div>`;
}

function renderFinding(finding) {
  const screenshotPath = screenshotToDataUri(finding.screenshot);

  return `
    <div class="finding">
      <div class="finding-top">
        <div class="finding-badges">
          ${renderSeverityBadge(finding.severity)}
          ${renderSourceBadge(finding.source)}
        </div>
        <div class="finding-path">
          <code>${finding.route}</code>
        </div>
      </div>
      <div class="finding-title">${finding.title}</div>
      ${screenshotPath ? `
        <div class="finding-screenshot">
          <img src="${screenshotPath}" alt="Screenshot: ${finding.title}" loading="lazy">
        </div>` : ""}
      <div class="finding-desc">${finding.description}</div>
      ${renderBedrockFix(finding)}
      <div class="finding-wcag">${(finding.wcag ?? []).join(" · ")}</div>
    </div>`;
}

function renderFindingGroup(severity, findings) {
  const group = findings.filter((finding) => finding.severity === severity);

  if (!group.length) return "";

  const headerColors = {
    critical: ["#FFF0F0", "#A32D2D"],
    major:    ["#FFF8EE", "#854F0B"],
    minor:    ["#F8F8F5", "#5F5E5A"],
  };

  const [headerBackground, headerColor] = headerColors[severity];
  const findingLabel = group.length === 1 ? "finding" : "findings";

  return `
    <div class="section" style="padding:0;overflow:hidden">
      <div style="background:${headerBackground};padding:10px 20px;border-bottom:0.5px solid #E8E6DF">
        <span style="font-size:12px;font-weight:600;color:${headerColor};text-transform:uppercase;letter-spacing:0.5px">${severity}</span>
        <span style="font-size:12px;color:${headerColor};opacity:0.7;margin-left:6px">— ${group.length} ${findingLabel}</span>
      </div>
      <div style="padding:12px 20px">
        ${group.map(renderFinding).join("")}
      </div>
    </div>`;
}

function renderScoringExplainer(findings, scoringWeights) {
  const automatedFindings = findings.filter((finding) => finding.source !== "manual-required");

  const uniqueFindings = [
    ...new Map(
      automatedFindings.map((finding) => [`${finding.title}|${finding.source}`, finding])
    ).values(),
  ];

  const criticalCount = uniqueFindings.filter((finding) => finding.severity === "critical").length;
  const majorCount    = uniqueFindings.filter((finding) => finding.severity === "major").length;
  const minorCount    = uniqueFindings.filter((finding) => finding.severity === "minor").length;

  const totalDeductions =
    criticalCount * (scoringWeights?.critical ?? 10) +
    majorCount    * (scoringWeights?.major    ?? 5)  +
    minorCount    * (scoringWeights?.minor    ?? 2);

  const finalScore = Math.max(0, 100 - totalDeductions);

  return `
    <div style="background:#FAFAF8;border:0.5px solid #E8E6DF;border-radius:8px;padding:14px 16px;margin-top:16px">
      <div style="font-size:12px;font-weight:500;color:#888780;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">
        How the score is calculated
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:#FCEBEB;border-radius:6px;padding:8px 10px">
          <div style="font-size:18px;font-weight:600;color:#791F1F">${criticalCount} × 10</div>
          <div style="font-size:11px;color:#A32D2D;margin-top:2px">unique critical findings</div>
        </div>
        <div style="background:#FAEEDA;border-radius:6px;padding:8px 10px">
          <div style="font-size:18px;font-weight:600;color:#633806">${majorCount} × 5</div>
          <div style="font-size:11px;color:#854F0B;margin-top:2px">unique major findings</div>
        </div>
        <div style="background:#F1EFE8;border-radius:6px;padding:8px 10px">
          <div style="font-size:18px;font-weight:600;color:#444441">${minorCount} × 2</div>
          <div style="font-size:11px;color:#5F5E5A;margin-top:2px">unique minor findings</div>
        </div>
      </div>
      <div style="font-size:12px;color:#5F5E5A;border-top:0.5px solid #E8E6DF;padding-top:10px">
        100 − (${criticalCount}×10 + ${majorCount}×5 + ${minorCount}×2) = 100 − ${totalDeductions} =
        <strong style="color:${getScoreColor(finalScore)}">${finalScore}</strong>
        &nbsp;·&nbsp; Duplicates across routes counted once. Weights configurable via
        <code>scoring: { critical, major, minor }</code> in <code>uxray.config.js</code>
      </div>
    </div>`;
}

function renderMissionTable(personaReport) {
  if (!personaReport) return "";

  const categoryCards = Object.entries(personaReport.categoryAverages ?? {})
    .map(([category, categoryScore]) => `
      <div class="cat ${categoryScore >= 85 ? "cat-accent" : categoryScore >= 60 ? "cat-warn" : "cat-fail"}">
        <div class="cat-n" style="color:${getScoreColor(categoryScore)}">${categoryScore}</div>
        <div class="cat-l" style="color:${getScoreColor(categoryScore)}">${category}</div>
      </div>`)
    .join("");

  const missionRows = (personaReport.missionTable ?? [])
    .map((mission) => `
      <div class="mission-row">
        <span style="color:#5F5E5A;font-size:12px">${mission.persona}</span>
        <span style="font-weight:500;font-size:13px">${mission.mission}</span>
        <span style="display:flex;align-items:center;gap:6px">
          ${renderProgressBar(mission.score, 70)}
          <span style="font-size:13px;font-weight:600;color:${getScoreColor(mission.score)}">${mission.score}</span>
        </span>
        <span style="font-size:12px;color:#5F5E5A">${mission.passed}/${mission.checks}</span>
        <span>
          <span style="background:${getScoreBackground(mission.score)};color:${getScoreColor(mission.score)};font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500">
            ${getScoreLabel(mission.score)}
          </span>
        </span>
      </div>`)
    .join("");

  return `
    <h2>User journey health scores</h2>
    <div class="section">
      <div class="cat-grid">${categoryCards}</div>
      <div class="mission-header">
        <span>Persona</span>
        <span>Mission</span>
        <span>Score</span>
        <span>Passed</span>
        <span>Status</span>
      </div>
      ${missionRows}
    </div>`;
}

function renderPersonaFailures(personaReport) {
  if (!personaReport?.missionTable?.some((mission) => mission.failures?.length)) return "";

  const failureCards = (personaReport.missionTable ?? [])
    .flatMap((mission) =>
      (mission.failures ?? []).map((failure) => {
        const screenshotPath = screenshotToDataUri(failure.screenshot);

        return `
          <div class="finding">
            <div class="finding-header">
              <span style="background:#E1F5EE;color:#085041;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500">${mission.persona}</span>
              <span style="font-size:11px;color:#888780;background:#F5F4F0;padding:1px 6px;border-radius:4px">${mission.mission}</span>
              <span class="finding-title">${failure.label}</span>
            </div>
            ${failure.detail ? `<div class="finding-desc">${failure.detail}</div>` : ""}
            ${screenshotPath ? `<img src="${screenshotPath}" alt="Screenshot: ${failure.label}" loading="lazy">` : ""}
          </div>`;
      })
    )
    .join("");

  return `
    <h2>Persona failures</h2>
    <div class="section">${failureCards}</div>`;
}

function renderManualGaps(manualGaps) {
  if (!manualGaps.length) return "";

  const uniqueWcagCriteria = [...new Set(manualGaps.map((gap) => gap.wcag?.[0]))];

  const gapItems = uniqueWcagCriteria
    .map((wcag) => {
      const gap         = manualGaps.find((item) => item.wcag?.[0] === wcag);
      const description = gap?.description?.replace("[MANUAL] ", "") ?? "";

      return `
        <div class="manual-item">
          <span class="wcag-tag">${wcag}</span>
          <span>${description}</span>
        </div>`;
    })
    .join("");

  return `
    <h2>Manual review required (${uniqueWcagCriteria.length} WCAG criteria)</h2>
    <div class="section">
      <div style="font-size:13px;color:#5F5E5A;margin-bottom:14px;padding-bottom:12px;border-bottom:0.5px solid #F1EFE8">
        These criteria cannot be fully automated — human review is required to verify WCAG 2.1 AA compliance.
      </div>
      ${gapItems}
    </div>`;
}

function buildReportStyles() {
  return `
    * { box-sizing: border-box }

    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #F1EFE8;
      color: #3d3d3a;
      line-height: 1.5;
    }

    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 20px;
    }

    h2 {
      font-size: 16px;
      font-weight: 500;
      margin: 32px 0 10px;
      color: #3d3d3a;
    }

    .hero {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 24px;
      color: #fff;
    }

    .hero-title {
      font-size: 24px;
      font-weight: 600;
      margin: 0 0 4px;
      color: #fff;
    }

    .hero-sub {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.6);
      margin-bottom: 28px;
    }

    .scores-row {
      display: flex;
      align-items: center;
      gap: 32px;
      flex-wrap: wrap;
    }

    .score-divider {
      width: 1px;
      height: 80px;
      background: rgba(255, 255, 255, 0.15);
    }

    .hero-stats {
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
    }

    .hero-stat { text-align: center }

    .hero-stat-n {
      font-size: 28px;
      font-weight: 600;
      line-height: 1;
    }

    .hero-stat-l {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.55);
      margin-top: 3px;
    }

    .severity-strip {
      display: flex;
      gap: 8px;
      margin-top: 20px;
      flex-wrap: wrap;
    }

    .sev-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 5px 12px;
      font-size: 12px;
      color: #fff;
    }

    .sev-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .section {
      background: #fff;
      border: 0.5px solid #D3D1C7;
      border-radius: 10px;
      padding: 18px 20px;
      margin-bottom: 14px;
    }

    .finding {
      border: 0.5px solid #E8E6DF;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 8px;
    }

    .finding:last-child { margin-bottom: 0 }

    .finding-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }

    .finding-badges {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .finding-path code {
      font-size: 11px;
      color: #aaa89f;
      background: #F5F4F0;
      padding: 2px 7px;
      border-radius: 4px;
    }

    .finding-title {
      font-size: 14px;
      font-weight: 600;
      color: #1a2332;
      margin-bottom: 10px;
      line-height: 1.4;
    }

    .finding-screenshot {
      margin-bottom: 10px;
      border-radius: 6px;
      overflow: hidden;
      border: 0.5px solid #D3D1C7;
    }

    .finding-screenshot img {
      max-width: 100%;
      display: block;
    }

    .finding-desc {
      font-size: 12px;
      color: #5F5E5A;
      line-height: 1.5;
      margin-bottom: 8px;
    }

    .finding-fix {
      background: #F0FDF4;
      border: 0.5px solid #86EFAC;
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }

    .finding-fix__label {
      font-size: 11px;
      font-weight: 600;
      color: #166534;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-bottom: 6px;
    }

    .finding-fix__desc {
      font-size: 12px;
      color: #166534;
      margin-bottom: 8px;
      line-height: 1.4;
    }

    .finding-fix__diff {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;

      @media (max-width: 600px) {
        grid-template-columns: 1fr;
      }
    }

    .finding-fix__diff-block {
      border-radius: 4px;
      overflow: hidden;
    }

    .finding-fix__diff-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 3px 8px;
    }

    .finding-fix__diff-block--before .finding-fix__diff-label {
      background: #FCEBEB;
      color: #791F1F;
    }

    .finding-fix__diff-block--after .finding-fix__diff-label {
      background: #DCFCE7;
      color: #166534;
    }

    .finding-fix__diff-block pre {
      margin: 0;
      padding: 8px;
      font-size: 11px;
      line-height: 1.4;
      overflow-x: auto;
      background: #FAFAF8;
      color: #3d3d3a;
    }

    .finding-fix__diff-block--before pre { background: #FFF8F8 }
    .finding-fix__diff-block--after pre  { background: #F0FDF4 }

    .finding-wcag {
      font-size: 11px;
      color: #aaa89f;
    }

    .mission-row {
      display: grid;
      grid-template-columns: 130px 1fr 110px 60px 90px;
      gap: 8px;
      align-items: center;
      padding: 8px 0;
      border-bottom: 0.5px solid #F1EFE8;
      font-size: 13px;
    }

    .mission-row:last-child { border-bottom: none }

    .mission-header {
      display: grid;
      grid-template-columns: 130px 1fr 110px 60px 90px;
      gap: 8px;
      font-size: 11px;
      font-weight: 500;
      color: #888780;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding-bottom: 8px;
      border-bottom: 0.5px solid #D3D1C7;
      margin-bottom: 2px;
    }

    .cat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }

    .cat {
      border-radius: 8px;
      padding: 12px 14px;
      position: relative;
      overflow: hidden;
    }

    .cat-n { font-size: 22px; font-weight: 600 }

    .cat-l {
      font-size: 11px;
      margin-top: 2px;
      text-transform: capitalize;
      opacity: 0.75;
    }

    .cat-accent { background: linear-gradient(135deg, #EAF3DE, #D4EDAB) }
    .cat-warn   { background: linear-gradient(135deg, #FAEEDA, #F5D49A) }
    .cat-fail   { background: linear-gradient(135deg, #FCEBEB, #F5BFBF) }

    .manual-item {
      padding: 7px 0;
      border-bottom: 0.5px solid #F1EFE8;
      font-size: 12px;
      color: #5F5E5A;
      display: flex;
      gap: 10px;
      align-items: baseline;
    }

    .manual-item:last-child { border-bottom: none }

    .wcag-tag {
      font-size: 11px;
      font-weight: 500;
      color: #3C3489;
      background: #EEEDFE;
      padding: 2px 7px;
      border-radius: 8px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    footer {
      text-align: center;
      font-size: 12px;
      color: #888780;
      margin-top: 40px;
      padding: 20px 0 28px;
      border-top: 0.5px solid #D3D1C7;
    }
  `;
}


/* MAIN EXPORT */

export async function generateHtmlReport(findingsOutput, personaReport, paths) {
  const automatedFindings = (findingsOutput.findings ?? []).filter(
    (finding) => finding.source !== "manual-required"
  );
  const manualGaps     = (findingsOutput.findings ?? []).filter(
    (finding) => finding.source === "manual-required"
  );
  const auditScore     = findingsOutput.auditScore ?? 100;
  const personaScore   = personaReport?.overallScore ?? null;
  const scoringWeights = { critical: 10, major: 5, minor: 2 };
  const durationSeconds = findingsOutput.durationMs
    ? Math.round(findingsOutput.durationMs / 1000)
    : null;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UXRay — ${findingsOutput.appName ?? "Accessibility Report"}</title>
  <style>${buildReportStyles()}</style>
</head>
<body>
  <div class="container">

    <div class="hero">
      <div class="hero-title">UXRay — ${findingsOutput.appName ?? "Accessibility Report"}</div>
      <div class="hero-sub">
        ${new Date(findingsOutput.generatedAt).toLocaleString()}
        &nbsp;·&nbsp;
        <code style="background:rgba(255,255,255,0.1);padding:1px 6px;border-radius:4px;font-size:12px">
          ${findingsOutput.target}
        </code>
        &nbsp;·&nbsp; WCAG 2.1 AA &nbsp;·&nbsp; ~80% automated coverage
        ${durationSeconds ? `&nbsp;·&nbsp; ${durationSeconds}s` : ""}
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
            <div class="hero-stat-n" style="color:#F5BFBF">
              ${automatedFindings.filter((f) => f.severity === "critical").length}
            </div>
            <div class="hero-stat-l">critical</div>
          </div>
          <div class="hero-stat">
            <div class="hero-stat-n" style="color:#F5D49A">
              ${automatedFindings.filter((f) => f.severity === "major").length}
            </div>
            <div class="hero-stat-l">major</div>
          </div>
          <div class="hero-stat">
            <div class="hero-stat-n" style="color:rgba(255,255,255,0.7)">
              ${automatedFindings.filter((f) => f.severity === "minor").length}
            </div>
            <div class="hero-stat-l">minor</div>
          </div>
          <div class="hero-stat">
            <div class="hero-stat-n" style="color:rgba(255,255,255,0.5)">${manualGaps.length}</div>
            <div class="hero-stat-l">manual gaps</div>
          </div>
        </div>
      </div>

      <div class="severity-strip">
        <div class="sev-pill">
          <div class="sev-dot" style="background:#F5BFBF"></div>
          Critical — blocked for screen readers, keyboard, assistive tech
        </div>
        <div class="sev-pill">
          <div class="sev-dot" style="background:#F5D49A"></div>
          Major — real barriers with WCAG citation
        </div>
        <div class="sev-pill">
          <div class="sev-dot" style="background:rgba(255,255,255,0.4)"></div>
          Minor — usability issues, lower impact
        </div>
      </div>
    </div>

    ${renderScoringExplainer(findingsOutput.findings ?? [], scoringWeights)}

    ${renderMissionTable(personaReport)}

    <h2>Findings (${automatedFindings.length})</h2>
    ${["critical", "major", "minor"].map((severity) => renderFindingGroup(severity, automatedFindings)).join("")}

    ${renderPersonaFailures(personaReport)}

    ${renderManualGaps(manualGaps)}

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
