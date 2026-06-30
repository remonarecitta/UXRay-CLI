import { writeFileSync, readFileSync, existsSync } from "fs";


/* DESIGN TOKENS — matched to LPS Flite Service Portal
   Background:   #FFFFFF
   Sidebar:      #FAFAFA
   Field bg:     #F3F3F4
   Border:       #E5E5E7
   Accent:       #E8821F (orange — primary actions, active state)
   Accent tint:  #FBEBD9 (active nav highlight)
   Text primary: #1A1A1A
   Text 2:       #6B6B70
   Text 3:       #767676 (AA-compliant 4.5:1 on white)
   Font: system grotesque sans, bold headings
*/

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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getScoreColor(score) {
  if (score >= 85) return "#2F9E58";
  if (score >= 60) return "#E8821F";
  return "#D8444A";
}

function getScoreLabel(score) {
  if (score >= 85) return "Pass";
  if (score >= 60) return "Needs work";
  return "Fail";
}

const SEVERITY_META = {
  critical:          { color: "#CD2B31", bg: "#FBEAEA", label: "Critical" },
  major:             { color: "#9C5A11", bg: "#FBEBD9", label: "Major" },
  minor:             { color: "#6B6B70", bg: "#F3F3F4", label: "Minor" },
  "manual-required": { color: "#5B4FC4", bg: "#EFEDFB", label: "Manual" },
};

const SOURCE_LABELS = {
  axe:               "axe-core",
  keyboard:          "Keyboard",
  screenReader:      "Screen reader",
  responsive:        "Responsive",
  errors:            "Form errors",
  wcagExtended:      "WCAG extended",
  "manual-required": "Manual",
};


/* RENDERERS */

function renderScoreGauge(score, label, size = 92) {
  const color         = getScoreColor(score);
  const radius        = (size / 2) - 7;
  const circumference  = 2 * Math.PI * radius;
  const filled         = (score / 100) * circumference;
  const fontSize       = Math.round(size * 0.27);

  return `
    <div class="gauge">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#EDEDEE" stroke-width="6" />
        <circle
          cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none"
          stroke="${color}" stroke-width="6" stroke-linecap="round"
          stroke-dasharray="${filled} ${circumference - filled}"
          transform="rotate(-90 ${size / 2} ${size / 2})"
        />
        <text x="${size / 2}" y="${size / 2 + fontSize * 0.32}" text-anchor="middle"
          font-size="${fontSize}" font-weight="800" fill="${color}" font-family="'Inter',sans-serif"
        >${score}</text>
      </svg>
      <div class="gauge-label">${label}</div>
    </div>`;
}

function renderSeverityChip(severity) {
  const meta = SEVERITY_META[severity] ?? SEVERITY_META.minor;
  return `<span class="chip" style="color:${meta.color};background:${meta.bg}">${meta.label}</span>`;
}

function renderSourceChip(source) {
  return `<span class="chip chip-source">${SOURCE_LABELS[source] ?? source}</span>`;
}

function renderFixBlock(finding) {
  if (!finding.fix) return "";
  const { description, before, after, file } = finding.fix;

  return `
    <div class="fix">
      <div class="fix-head">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M13 2L4.5 14.5H11L10 22L19.5 9.5H13L13 2Z" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
        AI fix suggestion
        ${file ? `<code class="fix-file">${escapeHtml(file)}</code>` : ""}
      </div>
      ${description ? `<p class="fix-desc">${escapeHtml(description)}</p>` : ""}
      ${before && after ? `
        <div class="diff">
          <div class="diff-col diff-before">
            <span class="diff-label">− before</span>
            <pre>${escapeHtml(before)}</pre>
          </div>
          <div class="diff-col diff-after">
            <span class="diff-label">+ after</span>
            <pre>${escapeHtml(after)}</pre>
          </div>
        </div>` : ""}
    </div>`;
}

function renderFinding(finding, index) {
  const screenshotPath = screenshotToDataUri(finding.screenshot);
  const wcagList        = (finding.wcag ?? []).join(" · ");

  return `
    <article class="finding" data-severity="${finding.severity}" data-source="${finding.source}"
      data-search="${escapeHtml((finding.title + " " + finding.description + " " + finding.route).toLowerCase())}">
      <button class="finding-toggle" type="button" aria-expanded="false" data-toggle="${index}">
        <span class="finding-row">
          ${renderSeverityChip(finding.severity)}
          ${renderSourceChip(finding.source)}
          <span class="finding-title">${escapeHtml(finding.title)}</span>
          <code class="finding-route">${escapeHtml(finding.route)}</code>
          <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </button>
      <div class="finding-body" id="finding-body-${index}">
        ${screenshotPath ? `<img class="finding-shot" src="${screenshotPath}" alt="Screenshot: ${escapeHtml(finding.title)}" loading="lazy">` : ""}
        <p class="finding-desc">${escapeHtml(finding.description)}</p>
        ${renderFixBlock(finding)}
        ${wcagList ? `<div class="finding-wcag">${escapeHtml(wcagList)}</div>` : ""}
      </div>
    </article>`;
}

function renderFindingsList(findings) {
  if (!findings.length) {
    return `<div class="empty-state">No automated findings on this run.</div>`;
  }
  return findings.map((finding, index) => renderFinding(finding, index)).join("");
}

function renderMissionRows(personaReport) {
  const rows = personaReport?.missionTable ?? [];
  if (!rows.length) return "";

  return rows.map((mission) => `
    <tr>
      <td class="mt-persona">${escapeHtml(mission.persona)}</td>
      <td class="mt-mission">${escapeHtml(mission.mission)}</td>
      <td class="mt-score">
        <div class="mt-bar"><div class="mt-bar-fill" style="width:${mission.score}%;background:${getScoreColor(mission.score)}"></div></div>
        <span style="color:${getScoreColor(mission.score)}">${mission.score}</span>
      </td>
      <td class="mt-passed">${mission.passed}/${mission.checks}</td>
      <td><span class="chip" style="color:${getScoreColor(mission.score)};background:#F3F3F4">${getScoreLabel(mission.score)}</span></td>
    </tr>`).join("");
}

function renderCategoryStrip(personaReport) {
  const categories = Object.entries(personaReport?.categoryAverages ?? {});
  if (!categories.length) return "";

  return `
    <div class="cat-strip">
      ${categories.map(([name, score]) => `
        <div class="cat-pill">
          <span class="cat-pill-score" style="color:${getScoreColor(score)}">${score}</span>
          <span class="cat-pill-label">${escapeHtml(name)}</span>
        </div>`).join("")}
    </div>`;
}

function renderPersonaSection(personaReport) {
  if (!personaReport) return "";

  return `
    <section class="panel" id="panel-personas">
      <div class="panel-head">
        <h2>User journey missions</h2>
        <span class="panel-sub">Each persona attempts a real task end to end</span>
      </div>
      ${renderCategoryStrip(personaReport)}
      <table class="mission-table">
        <thead>
          <tr><th>Persona</th><th>Mission</th><th>Score</th><th>Checks</th><th>Status</th></tr>
        </thead>
        <tbody>${renderMissionRows(personaReport)}</tbody>
      </table>
    </section>`;
}

function renderPersonaFailures(personaReport) {
  const failureMissions = (personaReport?.missionTable ?? []).filter((m) => m.failures?.length);
  if (!failureMissions.length) return "";

  const groups = failureMissions.map((mission, missionIndex) => {
    const items = (mission.failures ?? []).map((failure, failureIndex) => {
      const screenshotPath = screenshotToDataUri(failure.screenshot);
      const itemId         = `failure-${missionIndex}-${failureIndex}`;

      return `
        <div class="failure-item">
          <p class="failure-label">${escapeHtml(failure.label)}</p>
          ${failure.detail ? `<p class="finding-desc">${escapeHtml(failure.detail)}</p>` : ""}
          ${screenshotPath ? `
            <button class="failure-shot-toggle" type="button" data-shot-toggle="${itemId}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 17l-5-5-4 4-3-3-3 3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              View screenshot
            </button>
            <div class="failure-shot-wrap" id="${itemId}">
              <img class="finding-shot" src="${screenshotPath}" alt="${escapeHtml(failure.label)}" loading="lazy">
            </div>` : ""}
        </div>`;
    }).join("");

    return `
      <div class="failure-group">
        <div class="failure-group-head">
          <span class="chip chip-source">${escapeHtml(mission.persona)}</span>
          <code class="finding-route">${escapeHtml(mission.mission)}</code>
          <span class="failure-count">${mission.failures.length} failed check${mission.failures.length === 1 ? "" : "s"}</span>
        </div>
        ${items}
      </div>`;
  }).join("");

  return `
    <section class="panel" id="panel-failures">
      <div class="panel-head">
        <h2>Mission failures</h2>
        <span class="panel-sub">Where a persona could not complete the task</span>
      </div>
      <div class="failure-list">${groups}</div>
    </section>`;
}

function renderManualGaps(manualGaps) {
  if (!manualGaps.length) return "";

  const uniqueWcag = [...new Set(manualGaps.map((gap) => gap.wcag?.[0]))];

  const items = uniqueWcag.map((wcag) => {
    const gap = manualGaps.find((item) => item.wcag?.[0] === wcag);
    const description = (gap?.description ?? "").replace("[MANUAL] ", "");
    return `
      <div class="manual-row">
        <code class="finding-route">${escapeHtml(wcag)}</code>
        <span>${escapeHtml(description)}</span>
      </div>`;
  }).join("");

  return `
    <section class="panel" id="panel-manual">
      <div class="panel-head">
        <h2>Manual review required</h2>
        <span class="panel-sub">${uniqueWcag.length} WCAG criteria need human verification</span>
      </div>
      ${items}
    </section>`;
}

function buildStyles() {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

    :root {
      --bg:         #FFFFFF;
      --sidebar:    #FAFAFA;
      --field-bg:   #F3F3F4;
      --border:     #E5E5E7;
      --accent:     #E8821F;
      --accent-text:#B26112;
      --accent-tint:#FBEBD9;
      --text:       #1A1A1A;
      --text-2:     #6B6B70;
      --text-3:     #767676;
      --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box }

    html { scroll-behavior: smooth }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }

    a { color: var(--accent-text) }

    code, .mono { font-family: var(--mono) }

    .shell {
      display: grid;
      grid-template-columns: 280px 1fr;
      min-height: 100vh;
    }

    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr }
      .sidebar { position: static; height: auto }
    }

    /* ── Sidebar ────────────────────────────────────────────────── */

    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      background: var(--sidebar);
      border-right: 1px solid var(--border);
      padding: 26px 20px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 9px;
    }

    .brand-mark {
      width: 28px; height: 28px;
      border-radius: 7px;
      background: var(--accent);
      display: flex; align-items: center; justify-content: center;
      color: #FFFFFF;
      flex-shrink: 0;
    }

    .brand-name {
      font-weight: 800;
      font-size: 18px;
      letter-spacing: -0.01em;
      color: var(--text);
    }

    .meta-block { font-size: 12px; color: var(--text-2) }
    .meta-block strong { color: var(--text); font-weight: 600 }
    .meta-row { display: flex; justify-content: space-between; padding: 3px 0 }

    .gauges {
      display: flex;
      justify-content: space-around;
      padding: 14px 0;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }

    .gauge { display: flex; flex-direction: column; align-items: center; gap: 6px }
    .gauge-label { font-size: 10.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600 }

    .stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .stat {
      background: #FFFFFF;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
    }

    .stat-n { font-size: 20px; font-weight: 800; line-height: 1 }
    .stat-l { font-size: 10.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; font-weight: 600 }

    .filter-block { display: flex; flex-direction: column; gap: 10px }
    .filter-title { font-size: 10.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700 }

    .search-input {
      width: 100%;
      background: var(--field-bg);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px 11px;
      color: var(--text);
      font-size: 12.5px;
      font-family: var(--sans);
    }

    .search-input::placeholder { color: var(--text-3) }
    .search-input:focus { outline: none; border-color: var(--accent); background: #FFFFFF }

    .filter-pills { display: flex; flex-wrap: wrap; gap: 6px }

    .filter-pill {
      font-size: 11.5px;
      font-weight: 500;
      padding: 5px 11px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: #FFFFFF;
      color: var(--text-2);
      cursor: pointer;
      transition: border-color 0.12s, color 0.12s, background 0.12s;
      font-family: var(--sans);
    }

    .filter-pill:hover { border-color: var(--accent) }
    .filter-pill[aria-pressed="true"] { background: var(--accent-tint); border-color: var(--accent); color: #9C5A11; font-weight: 700 }

    .sidebar-footer { margin-top: auto; font-size: 11px; color: var(--text-3); line-height: 1.6 }

    /* ── Main ───────────────────────────────────────────────────── */

    .main { padding: 28px 36px 80px; max-width: 1000px }

    .top-bar {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 22px;
      flex-wrap: wrap;
      gap: 8px;
    }

    .top-bar h1 {
      font-size: 26px;
      font-weight: 800;
      margin: 0;
      letter-spacing: -0.01em;
      color: var(--text);
    }

    .top-bar-sub { font-size: 12.5px; color: var(--text-2) }

    .severity-legend { display: flex; gap: 14px; margin-bottom: 24px; flex-wrap: wrap }

    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2) }
    .legend-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0 }

    .panel {
      background: #FFFFFF;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px 22px;
      margin-bottom: 18px;
    }

    .panel-head { margin-bottom: 16px }
    .panel-head h2 { font-size: 16px; font-weight: 800; margin: 0 0 2px; color: var(--text) }
    .panel-sub { font-size: 12px; color: var(--text-3) }

    /* ── Chips ──────────────────────────────────────────────────── */

    .chip {
      display: inline-flex;
      align-items: center;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 3px 8px;
      border-radius: 5px;
      flex-shrink: 0;
    }

    .chip-source { background: var(--field-bg); color: var(--text-2); text-transform: none; font-weight: 500 }

    /* ── Findings list ──────────────────────────────────────────── */

    .finding {
      border: 1px solid var(--border);
      border-radius: 9px;
      margin-bottom: 7px;
      background: #FFFFFF;
      overflow: hidden;
      transition: border-color 0.12s;
    }

    .finding:hover { border-color: var(--accent) }
    .finding.is-hidden { display: none }

    .finding-toggle {
      width: 100%;
      background: none;
      border: none;
      padding: 12px 16px;
      cursor: pointer;
      text-align: left;
      font-family: inherit;
      color: inherit;
    }

    .finding-row { display: flex; align-items: center; gap: 9px }

    .finding-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .finding-route {
      font-size: 11px;
      color: var(--text-2);
      background: var(--field-bg);
      padding: 2px 7px;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .chevron { color: var(--text-3); flex-shrink: 0; transition: transform 0.15s }
    .finding-toggle[aria-expanded="true"] .chevron { transform: rotate(180deg) }

    .finding-body {
      display: none;
      padding: 0 16px 16px;
      border-top: 1px solid var(--border);
      padding-top: 14px;
    }

    .finding-body.is-open { display: block }

    .finding-shot {
      max-width: 100%;
      border-radius: 7px;
      border: 1px solid var(--border);
      display: block;
      margin-bottom: 12px;
    }

    .finding-desc { font-size: 12.5px; color: var(--text-2); margin: 0 0 10px }
    .finding-wcag { font-size: 11px; color: var(--text-3); margin-top: 10px; font-family: var(--mono) }

    /* ── AI fix block ───────────────────────────────────────────── */

    .fix {
      background: var(--accent-tint);
      border: 1px solid #F0BC7E;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 10px;
    }

    .fix-head {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      font-weight: 700;
      color: #9C5A11;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }

    .fix-file { margin-left: auto; font-size: 10.5px; color: var(--text-2); text-transform: none; letter-spacing: 0; background: #FFFFFF; padding: 2px 6px; border-radius: 4px }

    .fix-desc { font-size: 12.5px; color: #7A4A0F; margin: 0 0 10px }

    .diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px }

    @media (max-width: 600px) { .diff { grid-template-columns: 1fr } }

    .diff-col { border-radius: 6px; overflow: hidden; border: 1px solid var(--border) }

    .diff-label { display: block; font-size: 10px; font-weight: 700; padding: 4px 9px; text-transform: uppercase; letter-spacing: 0.04em }

    .diff-before .diff-label { background: #FBEAEA; color: #CD2B31 }
    .diff-after  .diff-label { background: #E7F5EB; color: #2F9E58 }

    .diff-col pre {
      margin: 0;
      padding: 9px;
      font-size: 11px;
      line-height: 1.5;
      overflow-x: auto;
      background: #FFFFFF;
      color: var(--text-2);
      font-family: var(--mono);
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ── Mission table ──────────────────────────────────────────── */

    .cat-strip { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px }

    .cat-pill {
      background: var(--field-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 14px;
      min-width: 92px;
    }

    .cat-pill-score { display: block; font-size: 19px; font-weight: 800 }
    .cat-pill-label { font-size: 10.5px; color: var(--text-3); text-transform: capitalize; font-weight: 500 }

    .mission-table { width: 100%; border-collapse: collapse; font-size: 12.5px }

    .mission-table th {
      text-align: left;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-3);
      font-weight: 700;
      padding: 0 10px 8px;
      border-bottom: 1px solid var(--border);
    }

    .mission-table td { padding: 9px 10px; border-bottom: 1px solid var(--border) }
    .mission-table tr:last-child td { border-bottom: none }

    .mt-persona { color: var(--text-2) }
    .mt-mission { font-weight: 600 }

    .mt-score { display: flex; align-items: center; gap: 8px; white-space: nowrap }
    .mt-bar { width: 60px; height: 5px; border-radius: 3px; background: var(--field-bg); overflow: hidden }
    .mt-bar-fill { height: 100% }
    .mt-passed { color: var(--text-2) }

    /* ── Failures grid ──────────────────────────────────────────── */

    .failure-list { display: flex; flex-direction: column; gap: 14px }

    .failure-group {
      border: 1px solid var(--border);
      border-radius: 9px;
      overflow: hidden;
    }

    .failure-group-head {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 11px 14px;
      background: var(--sidebar);
      border-bottom: 1px solid var(--border);
    }

    .failure-count { margin-left: auto; font-size: 11px; color: var(--text-3); font-weight: 600; white-space: nowrap }

    .failure-item { padding: 12px 14px; border-bottom: 1px solid var(--border) }
    .failure-item:last-child { border-bottom: none }

    .failure-label { font-size: 13px; font-weight: 600; margin: 0 0 5px; color: var(--text) }

    .failure-shot-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--accent-text);
      background: none;
      border: none;
      padding: 0;
      margin-top: 6px;
      cursor: pointer;
      font-family: var(--sans);
    }

    .failure-shot-toggle:hover { text-decoration: underline }

    .failure-shot-wrap { display: none; margin-top: 10px }
    .failure-shot-wrap.is-open { display: block }

    /* ── Manual review ──────────────────────────────────────────── */

    .manual-row {
      display: flex;
      gap: 14px;
      align-items: baseline;
      padding: 9px 0;
      border-bottom: 1px solid var(--border);
      font-size: 12.5px;
      color: var(--text-2);
    }

    .manual-row:last-child { border-bottom: none }

    .empty-state { text-align: center; padding: 40px 0; color: var(--text-3); font-size: 13px }

    /* ── Footer ─────────────────────────────────────────────────── */

    .page-footer {
      text-align: center;
      font-size: 11.5px;
      color: var(--text-3);
      padding: 24px 0 10px;
    }
  `;
}

function buildScript() {
  return `
    (function () {
      const findings = Array.from(document.querySelectorAll('.finding'));
      const toggles   = Array.from(document.querySelectorAll('.finding-toggle'));
      const search    = document.getElementById('search-input');
      const pills     = Array.from(document.querySelectorAll('.filter-pill'));

      toggles.forEach((btn) => {
        btn.addEventListener('click', () => {
          const expanded = btn.getAttribute('aria-expanded') === 'true';
          btn.setAttribute('aria-expanded', String(!expanded));
          const body = document.getElementById('finding-body-' + btn.dataset.toggle);
          if (body) body.classList.toggle('is-open', !expanded);
        });
      });

      const shotToggles = Array.from(document.querySelectorAll('[data-shot-toggle]'));
      shotToggles.forEach((btn) => {
        btn.addEventListener('click', () => {
          const wrap = document.getElementById(btn.dataset.shotToggle);
          if (!wrap) return;
          const open = wrap.classList.toggle('is-open');
          btn.lastChild.textContent = open ? ' Hide screenshot' : ' View screenshot';
        });
      });

      const state = { severity: 'all', source: 'all', query: '' };

      function applyFilters() {
        findings.forEach((el) => {
          const matchesSeverity = state.severity === 'all' || el.dataset.severity === state.severity;
          const matchesSource   = state.source   === 'all' || el.dataset.source   === state.source;
          const matchesQuery    = !state.query || el.dataset.search.includes(state.query);
          el.classList.toggle('is-hidden', !(matchesSeverity && matchesSource && matchesQuery));
        });
      }

      if (search) {
        search.addEventListener('input', (e) => {
          state.query = e.target.value.trim().toLowerCase();
          applyFilters();
        });
      }

      pills.forEach((pill) => {
        pill.addEventListener('click', () => {
          const group = pill.dataset.group;
          const value = pill.dataset.value;
          pills.filter((p) => p.dataset.group === group).forEach((p) => p.setAttribute('aria-pressed', 'false'));
          pill.setAttribute('aria-pressed', 'true');
          state[group] = value;
          applyFilters();
        });
      });
    })();
  `;
}


/* MAIN EXPORT */

export async function generateHtmlReport(findingsOutput, personaReport, paths) {
  const automatedFindings = (findingsOutput.findings ?? []).filter((f) => f.source !== "manual-required");
  const manualGaps         = (findingsOutput.findings ?? []).filter((f) => f.source === "manual-required");
  const auditScore         = findingsOutput.auditScore ?? 100;
  const personaScore       = personaReport?.overallScore ?? null;
  const durationSeconds    = findingsOutput.durationMs ? Math.round(findingsOutput.durationMs / 1000) : null;

  const criticalCount = automatedFindings.filter((f) => f.severity === "critical").length;
  const majorCount    = automatedFindings.filter((f) => f.severity === "major").length;
  const minorCount    = automatedFindings.filter((f) => f.severity === "minor").length;

  const sortedFindings = [...automatedFindings].sort((a, b) => {
    const order = { critical: 0, major: 1, minor: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  });

  const sourcesUsed = [...new Set(automatedFindings.map((f) => f.source))];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UXRay — ${escapeHtml(findingsOutput.appName ?? "Accessibility Report")}</title>
<style>${buildStyles()}</style>
</head>
<body>
<div class="shell">

  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.5">
          <circle cx="11" cy="11" r="7" stroke-linecap="round"/>
          <path d="M21 21l-4.3-4.3" stroke-linecap="round"/>
        </svg>
      </div>
      <span class="brand-name">UXRay</span>
    </div>

    <div class="meta-block">
      <div class="meta-row"><span>App</span><strong>${escapeHtml(findingsOutput.appName ?? "—")}</strong></div>
      <div class="meta-row"><span>Target</span><strong class="mono">${escapeHtml(findingsOutput.target ?? "—")}</strong></div>
      <div class="meta-row"><span>Standard</span><strong>WCAG 2.1 AA</strong></div>
      <div class="meta-row"><span>Coverage</span><strong>~80% automated</strong></div>
      ${durationSeconds ? `<div class="meta-row"><span>Duration</span><strong>${durationSeconds}s</strong></div>` : ""}
      <div class="meta-row"><span>Generated</span><strong>${new Date(findingsOutput.generatedAt).toLocaleString()}</strong></div>
    </div>

    <div class="gauges">
      ${renderScoreGauge(auditScore, "Audit score")}
      ${personaScore != null ? renderScoreGauge(personaScore, "Persona score") : ""}
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="stat-n" style="color:#D8444A">${criticalCount}</div><div class="stat-l">Critical</div></div>
      <div class="stat"><div class="stat-n" style="color:#E8821F">${majorCount}</div><div class="stat-l">Major</div></div>
      <div class="stat"><div class="stat-n" style="color:#6B6B70">${minorCount}</div><div class="stat-l">Minor</div></div>
      <div class="stat"><div class="stat-n" style="color:#767676">${manualGaps.length}</div><div class="stat-l">Manual</div></div>
    </div>

    <div class="filter-block">
      <span class="filter-title">Search</span>
      <input id="search-input" class="search-input" type="text" placeholder="Filter findings…" />
    </div>

    <div class="filter-block">
      <span class="filter-title">Severity</span>
      <div class="filter-pills">
        <button class="filter-pill" type="button" data-group="severity" data-value="all" aria-pressed="true">All</button>
        <button class="filter-pill" type="button" data-group="severity" data-value="critical" aria-pressed="false">Critical</button>
        <button class="filter-pill" type="button" data-group="severity" data-value="major" aria-pressed="false">Major</button>
        <button class="filter-pill" type="button" data-group="severity" data-value="minor" aria-pressed="false">Minor</button>
      </div>
    </div>

    <div class="filter-block">
      <span class="filter-title">Source</span>
      <div class="filter-pills">
        <button class="filter-pill" type="button" data-group="source" data-value="all" aria-pressed="true">All</button>
        ${sourcesUsed.map((src) => `<button class="filter-pill" type="button" data-group="source" data-value="${src}" aria-pressed="false">${SOURCE_LABELS[src] ?? src}</button>`).join("")}
      </div>
    </div>

    <div class="sidebar-footer">
      axe-core · keyboard (CDP) · virtual screen reader<br>
      responsive · personas · Bedrock fixes
    </div>
  </aside>

  <main class="main">

    <div class="top-bar">
      <h1>${escapeHtml(findingsOutput.appName ?? "Accessibility Report")}</h1>
      <span class="top-bar-sub">${automatedFindings.length} findings · ${manualGaps.length} manual gaps</span>
    </div>

    <div class="severity-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#D8444A"></span>Critical — blocked for assistive tech</span>
      <span class="legend-item"><span class="legend-dot" style="background:#E8821F"></span>Major — real barrier, WCAG cited</span>
      <span class="legend-item"><span class="legend-dot" style="background:#9B9B9F"></span>Minor — usability, lower impact</span>
    </div>

    ${renderPersonaSection(personaReport)}

    <section class="panel" id="panel-findings">
      <div class="panel-head">
        <h2>Findings</h2>
        <span class="panel-sub">Sorted by severity — click any row to expand</span>
      </div>
      ${renderFindingsList(sortedFindings)}
    </section>

    ${renderPersonaFailures(personaReport)}

    ${renderManualGaps(manualGaps)}

    <div class="page-footer">UXRay · WCAG 2.1 AA automated accessibility and responsiveness audit</div>

  </main>
</div>

<script>${buildScript()}</script>
</body>
</html>`;

  writeFileSync(paths.report, html);
}