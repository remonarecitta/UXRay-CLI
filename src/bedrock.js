import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { config as loadDotenv } from "dotenv";
import * as cheerio from "cheerio";

// Load .env file if present (local dev). Never commit .env to source control.
loadDotenv({ path: resolve(process.cwd(), ".env") });

const MODEL_ID         = "us.anthropic.claude-sonnet-4-6";
const MAX_TOKENS       = 8192;
const MAX_SOURCE_CHARS = 4000;   // expanded — JSX-aware truncation keeps full component context
const BATCH_SIZE       = 10;

// ─── Validation constants ────────────────────────────────────────────────────

const VALID_AFFECTED_USERS = new Set(["screen-reader", "keyboard", "low-vision", "voice-control", "cognitive"]);
const VALID_PRIORITY       = new Set(["Critical", "High", "Medium", "Low"]);
const VALID_COMPLEXITY     = new Set(["trivial", "low", "medium", "high"]);
const VALID_CONFIDENCE_SET = new Set(["high", "medium", "low"]);

/** Map legacy / alternate priority strings to the canonical four-level scale. */
const PRIORITY_NORMALIZER = {
  "immediate":  "Critical",
  "short-term": "High",
  "long-term":  "Medium",
  "critical":   "Critical",
  "high":       "High",
  "medium":     "Medium",
  "low":        "Low",
};

const SEVERITY_TO_PRIORITY = { critical: "High", major: "Medium", minor: "Low" };

// ─── File hint → source code mapping ────────────────────────────────────────

function buildFileHints(sourceRoot) {
  return [
    {
      match: (title, desc) => title.includes("accessible name") || desc.includes("button-name") || title.includes("icon button"),
      file:  `${sourceRoot}/components/atoms/IconButton.tsx`,
    },
    {
      match: (title, desc) => title.includes("touch target") || desc.includes("28px") || desc.includes("28×28"),
      file:  `${sourceRoot}/components/atoms/IconButton.scss`,
    },
    {
      match: (title, desc) => title.includes("alt") || desc.includes("image-alt") || desc.includes("logo"),
      file:  `${sourceRoot}/components/molecules/AppLayout.tsx`,
    },
    {
      match: (title, desc) => title.includes("contrast") && (desc.includes("badge") || desc.includes("status")),
      file:  `${sourceRoot}/components/atoms/StatusBadge.scss`,
    },
    {
      match: (title, desc) => title.includes("overflow") || title.includes("reflow") || desc.includes("table"),
      file:  `${sourceRoot}/pages/CampaignsList.scss`,
    },
    {
      match: (title, desc) => title.includes("dark") || desc.includes("dark mode") || desc.includes("placeholder"),
      file:  `${sourceRoot}/styles/_global.scss`,
    },
    {
      match: (title, desc) => title.includes("modal") || desc.includes("dialog"),
      file:  `${sourceRoot}/components/molecules/Modal.tsx`,
    },
    {
      match: (title, desc) => title.includes("label") || title.includes("textarea") || desc.includes("notes"),
      file:  `${sourceRoot}/pages/CampaignForm.tsx`,
    },
    {
      match: (title, desc) => title.includes("heading") || (title.includes("link") && desc.includes("click")),
      file:  `${sourceRoot}/pages/CampaignDetail.tsx`,
    },
  ];
}

// ─── JSX-aware source truncation ─────────────────────────────────────────────

/**
 * Truncate source content at a clean JSX/JS boundary rather than mid-expression.
 * Walks backward from maxChars to find the last line that ends a complete block.
 */
function truncateAtJsxBoundary(content, maxChars = MAX_SOURCE_CHARS) {
  if (!content || content.length <= maxChars) return content;

  const lines      = content.slice(0, maxChars).split("\n");
  const minLines   = Math.floor(lines.length * 0.6);

  // Walk backward from the cut point looking for a clean boundary line
  const BOUNDARY = /^\s*(\}|\/\>|\<\/[A-Za-z]|return\s|export\s|}\);|};|];)\s*$/;

  for (let i = lines.length - 1; i >= minLines; i--) {
    const trimmed = lines[i].trim();
    if (BOUNDARY.test(trimmed) || trimmed === "" && i > minLines) {
      return lines.slice(0, i + 1).join("\n")
        + "\n// ... (truncated — remaining context omitted to preserve JSX boundaries)";
    }
  }

  // Fallback: cut at last newline
  const lastNl = content.slice(0, maxChars).lastIndexOf("\n");
  return content.slice(0, lastNl > 0 ? lastNl : maxChars)
    + "\n// ... (truncated)";
}

function readSourceFile(filePath) {
  if (!filePath) return null;

  const candidates = [
    resolve(filePath),
    resolve(process.cwd(), filePath),
  ];

  for (const candidatePath of candidates) {
    try {
      if (existsSync(candidatePath)) {
        const content = readFileSync(candidatePath, "utf8");
        return truncateAtJsxBoundary(content, MAX_SOURCE_CHARS);
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

function resolveSourceSnippet(finding, sourceRoot = "src") {
  const title       = finding.title.toLowerCase();
  const description = finding.description.toLowerCase();
  const wcagStr     = (finding.wcag ?? []).join(" ").toLowerCase();
  const fileHints   = buildFileHints(sourceRoot);

  // ── Highest confidence: fix.file explicitly set ───────────────────────────
  if (finding.fix?.file) {
    const snippet = readSourceFile(finding.fix.file);
    if (snippet) return { file: finding.fix.file, snippet, confidence: "high" };
  }

  // ── Medium confidence: keyword-based file hint matches ────────────────────
  for (const hint of fileHints) {
    if (hint.match(title, description)) {
      const snippet = readSourceFile(hint.file);
      if (snippet) {
        // Upgrade to high if multiple independent signals point to same file:
        // title + description both contribute, or WCAG rule aligns
        const multiSignal =
          hint.match(title, "") && hint.match("", description) &&
          (title.length > 10 || wcagStr.length > 5);
        return { file: hint.file, snippet, confidence: multiSignal ? "high" : "medium" };
      }
      // Hint matched but file absent on disk — known file, unknown content
      return { file: hint.file, snippet: null, confidence: "low" };
    }
  }

  return { file: null, snippet: null, confidence: "none" };
}

// ─── HTML report parser ──────────────────────────────────────────────────────

/**
 * Parse a UXRay report.html and extract findings as structured objects.
 * Never passes raw HTML to Claude — only the extracted JSON findings.
 *
 * @param {string} htmlPath  Absolute or relative path to report.html
 * @returns {Array}          Array of finding objects
 */
function parseHtmlReport(htmlPath) {
  const resolvedPath = resolve(process.cwd(), htmlPath);

  if (!existsSync(resolvedPath)) {
    throw new Error(
      `HTML report not found: ${resolvedPath}\n` +
      `  Run 'npx uxray' first to generate the report, then re-run with --bedrock.`
    );
  }

  const html      = readFileSync(resolvedPath, "utf8");
  const $         = cheerio.load(html);
  const findings  = [];

  $(".finding").each((index, element) => {
    try {
      const $el = $(element);

      // severity: first badge span in the header
      const severity = $el.find(".finding-header span:first-child").text().trim().toLowerCase();

      // source: second badge span in the header
      const source = $el.find(".finding-header span:nth-child(2)").text().trim();

      // route: code tag in the header
      const route = $el.find(".finding-header code").text().trim() || "/";

      // title, description, wcag
      const title       = $el.find(".finding-title").text().trim();
      const description = $el.find(".finding-desc").text().trim();
      const wcagRaw     = $el.find(".finding-wcag").text().trim();
      const wcag        = wcagRaw
        ? wcagRaw.split("·").map((s) => s.trim()).filter(Boolean)
        : [];

      // screenshot src (relative path already in the HTML)
      const screenshot = $el.find("img").attr("src") || null;

      if (!title) {
        console.warn(`  ⚠ Skipping finding #${index + 1} — missing title`);
        return;
      }

      if (!severity) {
        console.warn(`  ⚠ Skipping finding #${index + 1} ("${title}") — missing severity`);
        return;
      }

      findings.push({
        id:          `html-${index + 1}`,
        route,
        source:      source || "html-report",
        severity,
        title,
        description,
        wcag,
        screenshot,
      });
    } catch (err) {
      console.warn(`  ⚠ Skipping finding #${index + 1} — parse error: ${err.message}`);
    }
  });

  return findings;
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicateFindings(findings, sourceRoot) {
  const seen           = new Map();
  const uniqueFindings = [];

  for (const finding of findings) {
    if (finding.source === "manual-required") continue;

    const { file } = resolveSourceSnippet(finding, sourceRoot);
    const dedupeKey = `${finding.title}::${file ?? finding.route}`;

    if (!seen.has(dedupeKey)) {
      seen.set(dedupeKey, true);
      uniqueFindings.push(finding);
    }
  }

  const severityOrder = { critical: 0, major: 1, minor: 2 };
  return uniqueFindings.sort(
    (a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)
  );
}

// ─── Batch prompt builder ────────────────────────────────────────────────────

/**
 * Build a batch prompt that drives a structured internal reasoning workflow.
 * Five high-quality few-shot examples anchor Claude's output format and
 * demonstrate the anti-hallucination behaviour for the Manual Review case.
 */
function buildBatchPrompt(findings) {
  const payload = findings.map((f) => ({
    findingId:        f.id,
    route:            f.route,
    source:           f.source,
    severity:         f.severity,
    wcag:             f.wcag,
    title:            f.title,
    description:      f.description,
    screenshot:       f.screenshot       || null,
    sourceFile:       f.sourceFile       || null,
    sourceSnippet:    f.sourceSnippet    || null,
    sourceConfidence: f.sourceConfidence || "none",
  }));

  return `You are a senior accessibility engineer performing WCAG 2.1 AA compliance review of a production React application.

══════════════════════════════════════════════════════
INTERNAL REASONING WORKFLOW — apply for EACH finding
══════════════════════════════════════════════════════

A. UNDERSTAND  — What specific accessibility barrier does this finding describe?
B. WCAG        — Which exact Success Criterion (number + full name) is violated?
C. USERS       — Which user groups are blocked from completing a specific task?
D. INSPECT     — Read the sourceSnippet carefully. Does it contain the violating element?
E. VERIFY      — Can the exact broken code fragment be pinpointed in the snippet?
                 YES → identify the minimal affected line(s) only
                 NO (or snippet absent/confidence "none") →
                   fix.description = "Manual Review Required — <why>"
                   fix.before = ""   fix.after = ""
F. MINIMIZE    — Extract ONLY the affected line(s). Never return an entire function.
G. OUTPUT      — Generate the JSON object following the schema and all rules below.

══════════════════════════════════════════════════════
RULES
══════════════════════════════════════════════════════

1. NEVER fabricate source code, file paths, or component names.
2. fix.before MUST be a verbatim fragment copied from sourceSnippet — the minimal broken line(s).
3. fix.after  MUST change only what is necessary. Preserve all surrounding code exactly.
4. fix.file   MUST equal sourceFile exactly. If sourceFile is null, use "".
5. affectedUsers: ONLY "screen-reader" | "keyboard" | "low-vision" | "voice-control" | "cognitive"
6. priority:
     Critical → element completely unusable by assistive technology
     High     → significant barrier; users struggle to complete the task
     Medium   → friction exists; workarounds are possible
     Low      → quality or consistency improvement only
7. userImpact MUST name the specific task the user cannot complete — NOT a generic statement.
8. testToVerify MUST reference: (1) the specific element, (2) expected behaviour, (3) a named tool.
9. Never omit any field. Use the defaults below rather than omitting:
     explanation, reasoning, userImpact, testToVerify → one descriptive sentence
     affectedUsers    → ["screen-reader"]
     priority         → derive from severity: critical→High, major→Medium, minor→Low
     estimatedFixComplexity → "medium"
     confidence       → "low"

══════════════════════════════════════════════════════
OUTPUT SCHEMA (one object per finding, in input order)
══════════════════════════════════════════════════════

{
  "findingId":              "<same id as input>",
  "explanation":            "<why this specific code pattern breaks WCAG — reference element + attribute>",
  "reasoning":              "<which attribute/property is absent and why adding it resolves the criterion>",
  "affectedUsers":          ["<values from the allowed list only>"],
  "userImpact":             "<task-based: who cannot do what specific action>",
  "wcagReference":          "<WCAG X.X.X Full Criterion Name>",
  "priority":               "Critical | High | Medium | Low",
  "estimatedFixComplexity": "trivial | low | medium | high",
  "confidence":             "high | medium | low",
  "fix": {
    "file":        "<exact sourceFile path, or empty string if null>",
    "description": "<one sentence describing the fix, or 'Manual Review Required — reason'>",
    "before":      "<verbatim fragment from sourceSnippet, or empty string>",
    "after":       "<minimal fixed fragment, or empty string>"
  },
  "testToVerify": "<specific element + expected behaviour + named tool>"
}


Input:
  findingId="ex-1", severity="critical", title="Ensure elements have alternative text"
  description="[image-alt] Images must have alternative text — 1 node(s)."
  sourceFile="src/components/Header.tsx", sourceConfidence="high"
  sourceSnippet contains: <img src="/logo.svg" className="logo" />

Output:
{
  "findingId": "ex-1",
  "explanation": "The <img> in Header.tsx has no alt attribute; screen readers announce the raw filename '/logo.svg' instead of the image purpose, breaking non-text content accessibility.",
  "reasoning": "Adding alt='Company logo' satisfies WCAG 1.1.1 by providing a text alternative that communicates the image function; the fix is a single attribute addition with no logic change.",
  "affectedUsers": ["screen-reader"],
  "userImpact": "Screen reader users navigating the header cannot identify the application logo, losing critical page context that sighted users see immediately.",
  "wcagReference": "WCAG 1.1.1 Non-text Content",
  "priority": "High",
  "estimatedFixComplexity": "trivial",
  "confidence": "high",
  "fix": {
    "file": "src/components/Header.tsx",
    "description": "Add descriptive alt attribute to the logo img element.",
    "before": "<img src=\"/logo.svg\" className=\"logo\" />",
    "after":  "<img src=\"/logo.svg\" className=\"logo\" alt=\"Company logo\" />"
  },
  "testToVerify": "Run axe on /dashboard and confirm image-alt rule passes; use VoiceOver on macOS to navigate the header and verify the image is announced as 'Company logo, image'."
}


Input:
  findingId="ex-2", severity="critical", title="Ensure buttons have discernible text"
  description="[button-name] Buttons must have discernible text — 18 node(s)."
  sourceFile="src/components/atoms/IconButton.tsx", sourceConfidence="high"
  sourceSnippet contains: <button onClick={onClick} className="icon-btn">{icon}</button>

Output:
{
  "findingId": "ex-2",
  "explanation": "The <button> in IconButton.tsx renders only an SVG icon with no visible text and no aria-label, making all 18 icon buttons completely opaque to screen readers and voice control.",
  "reasoning": "Adding aria-label={ariaLabel} as a required prop provides each button with a programmatic accessible name, resolving the WCAG 4.1.2 Name, Role, Value requirement; all call sites must pass a descriptive ariaLabel string.",
  "affectedUsers": ["screen-reader", "voice-control"],
  "userImpact": "Screen reader users hear only 'button' with no label for 18 interactive controls, preventing them from identifying or activating any icon-only button by its purpose.",
  "wcagReference": "WCAG 4.1.2 Name, Role, Value",
  "priority": "Critical",
  "estimatedFixComplexity": "low",
  "confidence": "high",
  "fix": {
    "file": "src/components/atoms/IconButton.tsx",
    "description": "Add required ariaLabel prop and apply it as aria-label on the button element.",
    "before": "<button onClick={onClick} className=\"icon-btn\">",
    "after":  "<button onClick={onClick} className=\"icon-btn\" aria-label={ariaLabel}>"
  },
  "testToVerify": "Run axe on /campaigns and confirm button-name reports zero violations; use NVDA on Windows to Tab through icon buttons and verify each announces its specific label."
}


Input:
  findingId="ex-3", severity="critical", title="Ensure contrast between foreground and background meets WCAG 2 AA"
  description="[color-contrast] Elements must meet minimum color contrast ratio thresholds — 3 node(s)."
  sourceFile="src/components/atoms/StatusBadge.scss", sourceConfidence="medium"
  sourceSnippet contains: .status-badge { color: #aaa; background: #fff; }

Output:
{
  "findingId": "ex-3",
  "explanation": "The .status-badge CSS rule applies color: #aaa on a white background, yielding a 2.32:1 contrast ratio — well below the 4.5:1 minimum required for normal-weight text under WCAG 2 AA.",
  "reasoning": "Changing color: #aaa to color: #767676 achieves exactly 4.5:1 contrast against #fff, satisfying WCAG 1.4.3 with the minimal colour token change while preserving the badge's muted visual style.",
  "affectedUsers": ["low-vision"],
  "userImpact": "Users with low vision or colour deficiency cannot read status badge labels at standard screen brightness, preventing them from tracking campaign statuses in the list view.",
  "wcagReference": "WCAG 1.4.3 Contrast (Minimum)",
  "priority": "High",
  "estimatedFixComplexity": "low",
  "confidence": "medium",
  "fix": {
    "file": "src/components/atoms/StatusBadge.scss",
    "description": "Replace text colour #aaa with #767676 to achieve a minimum 4.5:1 contrast ratio against white.",
    "before": "color: #aaa;",
    "after":  "color: #767676;"
  },
  "testToVerify": "Verify #767676 on #fff yields ≥4.5:1 with the WebAIM Contrast Checker; re-run axe on any page containing .status-badge elements to confirm color-contrast rule passes."
}


Input:
  findingId="ex-4", severity="critical", title="Form elements must have labels"
  description="[label] Form elements must have labels — 2 node(s)."
  sourceFile="src/pages/CampaignForm.tsx", sourceConfidence="high"
  sourceSnippet contains: <input type="text" name="title" placeholder="Campaign title" />

Output:
{
  "findingId": "ex-4",
  "explanation": "The <input> in CampaignForm.tsx uses only a placeholder as a label substitute; placeholders disappear on focus and are never announced as persistent field labels by screen readers.",
  "reasoning": "Adding aria-label='Campaign title' provides a programmatically determinable label that satisfies WCAG 1.3.1; a visible <label> with htmlFor is the preferred long-term solution to also support cognitive accessibility.",
  "affectedUsers": ["screen-reader", "cognitive"],
  "userImpact": "Screen reader users cannot identify the purpose of the campaign title field when filling out the creation form, preventing them from completing the form submission.",
  "wcagReference": "WCAG 1.3.1 Info and Relationships",
  "priority": "Critical",
  "estimatedFixComplexity": "trivial",
  "confidence": "high",
  "fix": {
    "file": "src/pages/CampaignForm.tsx",
    "description": "Add aria-label to the unlabelled input element to provide a persistent programmatic field name.",
    "before": "<input type=\"text\" name=\"title\" placeholder=\"Campaign title\" />",
    "after":  "<input type=\"text\" name=\"title\" placeholder=\"Campaign title\" aria-label=\"Campaign title\" />"
  },
  "testToVerify": "Use NVDA on /campaigns/new; Tab to the title input and verify the screen reader announces 'Campaign title, edit text'; run axe to confirm the label rule passes."
}


Input:
  findingId="ex-5", severity="critical", title="Keyboard trap detected"
  description="Focus cycled to 'Winter Welcome Back' 3+ times — keyboard users cannot exit."
  sourceFile=null, sourceSnippet=null, sourceConfidence="none"

Output:
{
  "findingId": "ex-5",
  "explanation": "A keyboard trap was detected on /campaigns — focus cycles unconditionally back to the 'Winter Welcome Back' element, blocking keyboard users from navigating to any other page content.",
  "reasoning": "Keyboard traps are typically caused by programmatic focus management (e.g., element.focus() in a useEffect without a dependency array) that continuously returns focus to the same element on every render.",
  "affectedUsers": ["keyboard"],
  "userImpact": "Keyboard-only users and switch device users become permanently trapped on the 'Winter Welcome Back' campaign card and cannot reach any subsequent interactive element on the page.",
  "wcagReference": "WCAG 2.1.2 No Keyboard Trap",
  "priority": "Critical",
  "estimatedFixComplexity": "medium",
  "confidence": "low",
  "fix": {
    "file": "",
    "description": "Manual Review Required — locate the component rendering 'Winter Welcome Back' and audit any useEffect or event handlers that call element.focus() unconditionally.",
    "before": "",
    "after":  ""
  },
  "testToVerify": "Navigate to /campaigns with keyboard only; Tab to 'Winter Welcome Back' and verify focus moves forward with Tab and backward with Shift+Tab; confirm pressing Escape closes any open overlays."
}

══════════════════════════════════════════════════════
FINDINGS TO REVIEW (${findings.length} finding(s))
══════════════════════════════════════════════════════

${JSON.stringify(payload, null, 2)}

══════════════════════════════════════════════════════
Respond with ONLY a JSON object. No markdown fences. No preamble. No trailing text.

{
  "suggestions": [
    { ...one complete object per finding, in the same order as the input array... }
  ]
}`;
}

// ─── AWS helpers ─────────────────────────────────────────────────────────────

function resolveAwsRegion() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";
}

function validateAwsCredentials() {
  const missing = [];
  if (!process.env.AWS_ACCESS_KEY_ID)     missing.push("AWS_ACCESS_KEY_ID");
  if (!process.env.AWS_SECRET_ACCESS_KEY) missing.push("AWS_SECRET_ACCESS_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing AWS credentials: ${missing.join(", ")}.\n` +
      `  Set them in a .env file or export them in your shell before running.\n` +
      `  See .env.example for the required variables.`
    );
  }
}

async function verifyAwsIdentity(region) {
  try {
    const sts      = new STSClient({ region });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    console.log(`  Identity: ${identity.Arn}`);
    return true;
  } catch (error) {
    if (error.name === "ExpiredTokenException") {
      throw new Error(
        "AWS session token has expired. Refresh your credentials in .env and re-run.\n" +
        "  Update AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN."
      );
    }
    throw new Error(`STS identity check failed (${error.name}): ${error.message}`);
  }
}

// ─── Bedrock call (low-level) ─────────────────────────────────────────────────

/**
 * Send a prompt to Claude via Bedrock and return parsed JSON.
 * Used for both single and batch prompts.
 */
async function callBedrock(prompt) {
  validateAwsCredentials();

  const requestBody = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens:        MAX_TOKENS,
    messages:          [{ role: "user", content: prompt }],
  });

  const command = new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: "application/json",
    accept:      "application/json",
    body:        requestBody,
  });

  const awsRegion     = resolveAwsRegion();
  const bedrockClient = new BedrockRuntimeClient({ region: awsRegion });
  const response      = await bedrockClient.send(command);
  const decoded       = JSON.parse(new TextDecoder().decode(response.body));
  const responseText  = decoded.content?.[0]?.text ?? "";
  const cleanJson     = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    return JSON.parse(cleanJson);
  } catch {
    console.error(`  ⚠ JSON parse failed: ${cleanJson.slice(0, 120)}...`);
    return null;
  }
}

// ─── Patch hunk builder ───────────────────────────────────────────────────────

function buildPatchHunk(suggestion) {
  const fix = suggestion?.fix;
  if (!fix?.file || !fix?.before || !fix?.after) return null;
  if (fix.before === fix.after) return null;

  const beforeLines = fix.before.split("\n").map((line) => `- ${line}`).join("\n");
  const afterLines  = fix.after.split("\n").map((line) => `+ ${line}`).join("\n");
  const beforeCount = fix.before.split("\n").length;
  const afterCount  = fix.after.split("\n").length;

  return `--- a/${fix.file}
+++ b/${fix.file}
@@ -1,${beforeCount} +1,${afterCount} @@
${beforeLines}
${afterLines}`;
}

// ─── Response validation & normalization ──────────────────────────────────────

/**
 * Validate and normalize a raw suggestion from Claude.
 * Fills missing or invalid fields with sensible defaults and logs per-field warnings.
 * Never throws — always returns a complete, well-formed suggestion object.
 *
 * @param {object} raw           Raw suggestion object returned by Claude
 * @param {object} sourceFinding The original finding (used for severity-based fallbacks)
 * @returns {object}             Normalized suggestion with every required field present
 */
function validateAndNormalizeSuggestion(raw, sourceFinding) {
  const warnings = [];
  const s        = structuredClone ? structuredClone(raw) : JSON.parse(JSON.stringify(raw));

  // ── fix object ────────────────────────────────────────────────────────────
  if (!s.fix || typeof s.fix !== "object") {
    s.fix = { file: "", description: "Manual Review Required", before: "", after: "" };
    warnings.push("fix object missing — initialized with defaults");
  }

  // ── findingId ─────────────────────────────────────────────────────────────
  if (!s.findingId) {
    s.findingId = sourceFinding?.id ?? "unknown";
    warnings.push("findingId missing — backfilled from source finding");
  }

  // ── priority — normalize legacy and invalid values ────────────────────────
  if (!VALID_PRIORITY.has(s.priority)) {
    const mapped = PRIORITY_NORMALIZER[String(s.priority ?? "").toLowerCase()];
    if (mapped) {
      s.priority = mapped;
    } else {
      s.priority = SEVERITY_TO_PRIORITY[sourceFinding?.severity ?? ""] ?? "Medium";
      warnings.push(`priority '${raw.priority ?? "(missing)"}' not valid — derived '${s.priority}' from severity`);
    }
  }

  // ── affectedUsers — filter to allowed values ──────────────────────────────
  if (!Array.isArray(s.affectedUsers) || s.affectedUsers.length === 0) {
    s.affectedUsers = ["screen-reader"];
    warnings.push("affectedUsers missing or empty — defaulted to ['screen-reader']");
  } else {
    const filtered = s.affectedUsers.filter((u) => VALID_AFFECTED_USERS.has(u));
    if (filtered.length === 0) {
      s.affectedUsers = ["screen-reader"];
      warnings.push(`affectedUsers '${JSON.stringify(raw.affectedUsers)}' contained no valid values — defaulted`);
    } else {
      s.affectedUsers = filtered;
    }
  }

  // ── estimatedFixComplexity ────────────────────────────────────────────────
  if (!VALID_COMPLEXITY.has(s.estimatedFixComplexity)) {
    warnings.push(`estimatedFixComplexity '${raw.estimatedFixComplexity ?? "(missing)"}' invalid — defaulted to 'medium'`);
    s.estimatedFixComplexity = "medium";
  }

  // ── confidence ───────────────────────────────────────────────────────────
  if (!VALID_CONFIDENCE_SET.has(s.confidence)) {
    warnings.push(`confidence '${raw.confidence ?? "(missing)"}' invalid — defaulted to 'low'`);
    s.confidence = "low";
  }

  // ── required string fields ────────────────────────────────────────────────
  const STRING_DEFAULTS = {
    explanation:
      "Review the finding description — source snippet was unavailable for automated analysis.",
    reasoning:
      "Source snippet absent; manual code inspection is required to identify the root cause.",
    userImpact:
      "Users relying on assistive technology may encounter barriers when interacting with this element.",
    wcagReference:
      "Refer to WCAG 2.1 for the applicable Success Criterion.",
    testToVerify:
      "Test manually with a screen reader (NVDA or VoiceOver) and keyboard-only navigation to verify the fix.",
  };

  for (const [field, defaultVal] of Object.entries(STRING_DEFAULTS)) {
    if (!s[field] || typeof s[field] !== "string" || s[field].trim() === "") {
      s[field] = defaultVal;
      warnings.push(`${field} missing or empty — populated with default`);
    }
  }

  // ── fix sub-fields ────────────────────────────────────────────────────────
  if (typeof s.fix.file !== "string") {
    s.fix.file = sourceFinding?.sourceFile ?? "";
  }
  if (!s.fix.description || typeof s.fix.description !== "string") {
    s.fix.description = "Manual Review Required";
    warnings.push("fix.description missing — set to 'Manual Review Required'");
  }
  if (typeof s.fix.before !== "string") s.fix.before = "";
  if (typeof s.fix.after  !== "string") s.fix.after  = "";

  // ── emit warnings ─────────────────────────────────────────────────────────
  if (warnings.length > 0) {
    const id = s.findingId ?? "unknown";
    for (const w of warnings) {
      console.warn(`    ⚠ [${id}] ${w}`);
    }
  }

  return s;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Run Bedrock fix suggestions.
 *
 * Accepts EITHER:
 *   - findingsOutput as an object  { findings: [...] }   (JSON mode)
 *   - findingsOutput as a string   "path/to/report.html" (HTML mode)
 *
 * @param {object|string} findingsOutput
 * @param {object}        config   UXRay config object
 * @param {object}        paths    Resolved output paths
 * @returns {object}      suggestionsOutput
 */
export async function runBedrock(findingsOutput, config, paths) {
  const sourceRoot = config.sourceRoot || "src";
  const awsRegion  = resolveAwsRegion();
  const dryRun     = process.argv.includes("--dry-run");

  console.log(`  ✔ Model:  ${MODEL_ID}`);
  console.log(`  ✔ Region: ${awsRegion}`);

  // Validate credentials and verify AWS identity via STS before any Bedrock calls
  validateAwsCredentials();
  await verifyAwsIdentity(awsRegion);

  // ── Resolve findings from either HTML or JSON input ──────────────────────
  let findings    = [];
  let inputMode   = "json";

  if (typeof findingsOutput === "string" && findingsOutput.endsWith(".html")) {
    inputMode = "html";
    process.stdout.write(`  Parsing HTML report: ${findingsOutput} ... `);
    findings  = parseHtmlReport(findingsOutput);
    console.log(`✔ ${findings.length} finding(s) parsed`);
  } else {
    findings = findingsOutput?.findings ?? [];
    console.log(`  ✔ JSON findings loaded: ${findings.length}`);
  }

  const uniqueFindings = deduplicateFindings(findings, sourceRoot);
  console.log(`  ✔ Deduplicated: ${findings.length} → ${uniqueFindings.length} unique root causes`);

  // ── Attach source snippets to every finding before batching ──────────────
  const confidenceCounts = { high: 0, medium: 0, low: 0, none: 0 };

  for (const finding of uniqueFindings) {
    const { file, snippet, confidence } = resolveSourceSnippet(finding, sourceRoot);
    finding.sourceFile        = file;
    finding.sourceSnippet     = snippet;
    finding.sourceConfidence  = confidence;
    confidenceCounts[confidence] = (confidenceCounts[confidence] ?? 0) + 1;
  }

  console.log(
    `  ✔ Source resolved: ` +
    `high(${confidenceCounts.high}) · ` +
    `medium(${confidenceCounts.medium}) · ` +
    `low(${confidenceCounts.low}) · ` +
    `none(${confidenceCounts.none})`
  );

  if (dryRun) {
    const batchCount = Math.ceil(uniqueFindings.length / BATCH_SIZE);
    console.log(`\n  ✔ Dry run complete.`);
    console.log(`    Findings: ${uniqueFindings.length} → ${batchCount} batch(es)`);
    console.log(`    Source confidence: high(${confidenceCounts.high}) · medium(${confidenceCounts.medium}) · low(${confidenceCounts.low}) · none(${confidenceCounts.none})\n`);
    return;
  }

  // ── Split into batches ────────────────────────────────────────────────────
  const batches = [];
  for (let i = 0; i < uniqueFindings.length; i += BATCH_SIZE) {
    batches.push(uniqueFindings.slice(i, i + BATCH_SIZE));
  }

  console.log(`  ✔ Batching: ${uniqueFindings.length} finding(s) → ${batches.length} batch(es) of up to ${BATCH_SIZE}`);

  const allSuggestions     = [];
  const patchHunks         = [];
  let   bedrockRequestCount = 0;
  let   skipCount           = 0;
  let   manualReviewCount   = 0;

  // ── Process each batch ────────────────────────────────────────────────────
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    process.stdout.write(`  ✔ Claude request: batch ${batchIndex + 1}/${batches.length} (${batch.length} finding(s)) ... `);

    try {
      const prompt = buildBatchPrompt(batch);
      const result = await callBedrock(prompt);
      bedrockRequestCount++;

      if (!result?.suggestions || !Array.isArray(result.suggestions)) {
        console.log("⚠ no suggestions array in response");
        skipCount += batch.length;
        continue;
      }

      console.log(`✔ ${result.suggestions.length} recommendation(s) received`);

      for (const rawSuggestion of result.suggestions) {
        const sourceFinding = batch.find((f) => f.id === rawSuggestion.findingId);

        // Back-fill fix.file from source resolution when Claude left it empty
        if (!rawSuggestion.fix?.file && sourceFinding?.sourceFile) {
          rawSuggestion.fix      = rawSuggestion.fix ?? {};
          rawSuggestion.fix.file = sourceFinding.sourceFile;
        }

        // Enforce anti-hallucination: wipe before/after when there is no real snippet
        if (!sourceFinding?.sourceSnippet || sourceFinding.sourceConfidence === "none") {
          rawSuggestion.fix              = rawSuggestion.fix ?? {};
          rawSuggestion.fix.before       = "";
          rawSuggestion.fix.after        = "";
          rawSuggestion.fix.description  =
            rawSuggestion.fix.description?.includes("Manual Review")
              ? rawSuggestion.fix.description
              : "Manual Review Required — no source snippet available";
        }

        // Validate, normalize, and fill any missing fields
        const suggestion = validateAndNormalizeSuggestion(rawSuggestion, sourceFinding);

        if (suggestion.fix?.description?.includes("Manual Review Required")) {
          manualReviewCount++;
        }

        allSuggestions.push(suggestion);

        const patchHunk = buildPatchHunk(suggestion);
        if (patchHunk) patchHunks.push(patchHunk);
      }

    } catch (error) {
      console.log(`✗ ${error.message.slice(0, 70)}`);
      skipCount += batch.length;
      // Continue processing remaining batches even if one fails
    }

    // Rate-limit delay between batches (skip after the last batch)
    if (batchIndex < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // ── Write suggestions.json ────────────────────────────────────────────────
  const suggestionsOutput = {
    generatedAt:        new Date().toISOString(),
    model:              MODEL_ID,
    region:             awsRegion,
    inputMode,
    totalFindings:      findings.length,
    uniqueRoots:        uniqueFindings.length,
    batchCount:         batches.length,
    bedrockRequests:    bedrockRequestCount,
    suggested:          allSuggestions.length,
    manualReview:       manualReviewCount,
    skipped:            skipCount,
    sourceConfidence:   confidenceCounts,
    suggestions:        allSuggestions,
  };

  writeFileSync(paths.suggestions, JSON.stringify(suggestionsOutput, null, 2));
  console.log(`  ✔ Recommendations generated: ${allSuggestions.length} (${manualReviewCount} Manual Review Required)`);
  console.log(`  ✔ suggestions.json  → ${paths.suggestions}`);

  // ── Write suggestions.patch ───────────────────────────────────────────────
  if (patchHunks.length > 0) {
    const patchContent = [
      `# UXRay suggestions.patch`,
      `# Generated: ${new Date().toISOString()}`,
      `# Model: ${MODEL_ID}`,
      `# Apply with: git apply suggestions.patch`,
      `# Fixes ${patchHunks.length} of ${allSuggestions.length} findings`,
      "",
      ...patchHunks,
    ].join("\n");

    writeFileSync(paths.patch, patchContent);
    console.log(`  ✔ suggestions.patch → ${paths.patch}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(56)}`);
  console.log("  BEDROCK SUMMARY");
  console.log(`${"═".repeat(56)}`);
  console.log(`  Input mode:               ${inputMode === "html" ? "HTML report" : "JSON findings"}`);
  console.log(`  Findings parsed:          ${findings.length}`);
  console.log(`  Unique root causes:       ${uniqueFindings.length}`);
  console.log(`  Source confidence:`);
  console.log(`    high:                   ${confidenceCounts.high}`);
  console.log(`    medium:                 ${confidenceCounts.medium}`);
  console.log(`    low:                    ${confidenceCounts.low}`);
  console.log(`    none:                   ${confidenceCounts.none}`);
  console.log(`  Batches processed:        ${batches.length}`);
  console.log(`  Bedrock requests:         ${bedrockRequestCount}`);
  console.log(`  Recommendations:          ${allSuggestions.length}`);
  console.log(`  ├─ with real code fix:    ${allSuggestions.length - manualReviewCount}`);
  console.log(`  └─ Manual Review Req'd:  ${manualReviewCount}`);
  console.log(`  Patch hunks generated:    ${patchHunks.length}`);
  console.log(`  Skipped (errors):         ${skipCount}`);

  if (allSuggestions.length) {
    const byFile = {};
    for (const suggestion of allSuggestions) {
      const filePath   = suggestion.fix?.file || "unknown (Manual Review Required)";
      byFile[filePath] = (byFile[filePath] ?? 0) + 1;
    }

    console.log(`\n  Recommendations by file:`);
    for (const [filePath, count] of Object.entries(byFile)) {
      console.log(`    ${filePath.slice(0, 50).padEnd(52)} ${count}`);
    }
  }

  if (patchHunks.length > 0) {
    console.log(`\n  To apply fixes: git apply suggestions.patch`);
  }
  console.log(`  To re-audit:    npx uxray --no-bedrock\n`);

  return suggestionsOutput;
}
