import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { config as loadDotenv } from "dotenv";
import * as cheerio from "cheerio";

// Load .env file if present (local dev). Never commit .env to source control.
loadDotenv({ path: resolve(process.cwd(), ".env") });

const MODEL_ID         = "us.anthropic.claude-sonnet-4-6";
const MAX_TOKENS       = 8192;   // increased for batch responses
const MAX_SOURCE_CHARS = 8000;
const BATCH_SIZE       = 3;

// ─── File hint → source code mapping ────────────────────────────────────────

function buildFileHints(sourceRoot) {
  // File paths mapped to the actual campaign-ui codebase structure.
  // Run: find src -type f -name "*.tsx" -o -name "*.scss" | sort
  // to re-verify paths if the project structure changes.
  return [
    // ── Landmark / page structure / skip nav ──────────────────────────────
    // Layout.tsx is the app shell — wraps every page with nav, sidebar, <main>
    {
      match: (title, desc) =>
        title.includes("landmark") ||
        title.includes("page content") ||
        desc.includes("region") ||
        title.includes("skip") ||
        title.includes("bypass") ||
        title.includes("contained by"),
      file: `${sourceRoot}/Layout.tsx`,
    },

    // ── ARIA role / attribute violations ─────────────────────────────────
    // CampaignOverview renders the list/table where most ARIA role issues appear
    {
      match: (title, desc) =>
        desc.includes("aria-required-parent") ||
        desc.includes("aria-valid-attr") ||
        title.includes("ARIA role") ||
        title.includes("ARIA attribute") ||
        desc.includes("listitem") ||
        desc.includes("gridcell") ||
        desc.includes("row") ||
        title.includes("parent role"),
      file: `${sourceRoot}/pages/campaign-overview/CampaignOverview.tsx`,
    },

    // ── Campaign list table (overflow, table structure) ───────────────────
    {
      match: (title, desc) =>
        title.includes("overflow") ||
        title.includes("reflow") ||
        desc.includes("table") ||
        title.includes("scroll"),
      file: `${sourceRoot}/pages/campaign-overview/components/CampaignListView.scss`,
    },

    // ── Form labels / inputs (Create Campaign form) ───────────────────────
    {
      match: (title, desc) =>
        title.includes("form element") ||
        title.includes("label") ||
        title.includes("textarea") ||
        desc.includes("notes") ||
        desc.includes("unlabelled") ||
        desc.includes("6 node"),
      file: `${sourceRoot}/pages/create-campaign/CreateCampaign.tsx`,
    },

    // ── Touch targets / button sizing ─────────────────────────────────────
    {
      match: (title, desc) =>
        title.includes("touch target") ||
        title.includes("target size") ||
        desc.includes("44px") ||
        desc.includes("40px") ||
        desc.includes(".button"),
      file: `${sourceRoot}/pages/create-campaign/CreateCampaign.scss`,
    },

    // ── Visible label / accessible name mismatch ──────────────────────────
    // The logout button is in the sidebar — Layout.tsx wraps the sidebar
    {
      match: (title, desc) =>
        title.includes("accessible name") ||
        title.includes("visible label") ||
        desc.includes("logoutlogout") ||
        desc.includes("aria-label") ||
        title.includes("label in name"),
      file: `${sourceRoot}/Layout.tsx`,
    },

    // ── Heading order ─────────────────────────────────────────────────────
    {
      match: (title, desc) =>
        title.includes("heading") ||
        desc.includes("h1") ||
        desc.includes("h2") ||
        desc.includes("h3"),
      file: `${sourceRoot}/pages/campaign-overview/components/CampaignPageHeader.tsx`,
    },

    // ── Contrast / colour issues ──────────────────────────────────────────
    {
      match: (title, desc) =>
        title.includes("contrast") ||
        title.includes("colour") ||
        title.includes("color"),
      file: `${sourceRoot}/pages/campaign-overview/components/CampaignListView.scss`,
    },

    // ── Audience section ──────────────────────────────────────────────────
    {
      match: (title, desc) =>
        desc.includes("audience") ||
        title.includes("audience"),
      file: `${sourceRoot}/pages/create-campaign/components/Audience/Audience.tsx`,
    },

    // ── Promotion section ─────────────────────────────────────────────────
    {
      match: (title, desc) =>
        desc.includes("promotion") ||
        title.includes("promotion"),
      file: `${sourceRoot}/pages/create-campaign/components/Promotion/Promotion.tsx`,
    },
  ];
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
        return content.length > MAX_SOURCE_CHARS
          ? content.slice(0, MAX_SOURCE_CHARS) + "\n// ... (truncated)"
          : content;
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
  const fileHints   = buildFileHints(sourceRoot);

  if (finding.fix?.file) {
    const snippet = readSourceFile(finding.fix.file);
    if (snippet) return { file: finding.fix.file, snippet };
  }

  for (const hint of fileHints) {
    if (hint.match(title, description)) {
      const snippet = readSourceFile(hint.file);
      return { file: hint.file, snippet };
    }
  }

  return { file: null, snippet: null };
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
 * Build a single prompt for a batch of up to BATCH_SIZE findings.
 * Attaches sourceFile and sourceSnippet so Claude has code context.
 *
 * @param {Array} findings  Already enriched with sourceFile/sourceSnippet
 * @returns {string}
 */
function buildBatchPrompt(findings) {
  const payload = findings.map((f) => ({
    findingId:     f.id,
    route:         f.route,
    source:        f.source,
    severity:      f.severity,
    wcag:          f.wcag,
    title:         f.title,
    description:   f.description,
    screenshot:    f.screenshot   || null,
    sourceFile:    f.sourceFile   || null,
    sourceSnippet: f.sourceSnippet || null,
  }));

  return `IMPORTANT: Output ONLY a raw JSON object. Start your response with { and end with }. No preamble, no explanation, no introductory text. Any text before or after the JSON will break the parser.

You are a senior accessibility engineer reviewing WCAG 2.1 AA compliance findings for a React/TypeScript application.

You are given ${findings.length} accessibility finding(s).

For EACH finding, return one suggestion object with this exact shape:
{
  "findingId": "<same id as the input finding>",
  "explanation": "One clear sentence explaining WHY this breaks accessibility for real users.",
  "userImpact": "One sentence: which users are affected and what they experience.",
  "fix": {
    "file": "path/to/file relative to project root — use sourceFile if provided, else infer",
    "description": "One sentence describing what the fix does.",
    "before": "REQUIRED — a realistic code snippet showing the broken pattern. If sourceSnippet is available use it exactly. If sourceSnippet is null, write a typical React/TypeScript example of this specific violation — never leave this blank, never write Manual Review Required here.",
    "after": "REQUIRED — the corrected code. If sourceSnippet is available, produce a minimal diff. If sourceSnippet is null, write the correct React/TypeScript pattern. Never leave this blank."
  },
  "wcagReference": "WCAG SC number and name, e.g. WCAG 4.1.2 Name, Role, Value",
  "priority": "immediate | short-term | long-term",
  "testToVerify": "One sentence: how to verify the fix works (axe rule, SR announcement, or manual check)."
}

CRITICAL RULES:
- fix.before and fix.after must ALWAYS contain real code — never empty strings, never "Manual Review Required".
- If sourceSnippet is null: infer the most likely React/TypeScript pattern for this exact violation and write a realistic before/after. The finding title and description contain enough context.
- fix.file: use sourceFile if provided, otherwise infer the most likely file path for a React/TypeScript campaign management app.

FINDINGS:
${JSON.stringify(payload, null, 2)}

Respond with ONLY a JSON object. No markdown fences. No preamble. No explanation outside the JSON.

Required response shape:
{
  "suggestions": [
    { ...suggestion for finding 1... },
    { ...suggestion for finding 2... }
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
  // Strip markdown fences first
  let cleanJson = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  // If the model prefixed preamble text (e.g. "Here is the payload..."), extract
  // just the JSON object — find the first { and the matching last }
  const jsonStart = cleanJson.indexOf("{");
  const jsonEnd   = cleanJson.lastIndexOf("}");
  if (jsonStart > 0 && jsonEnd > jsonStart) {
    cleanJson = cleanJson.slice(jsonStart, jsonEnd + 1);
  }

  try {
    return JSON.parse(cleanJson);
  } catch {
    console.error(`  ⚠ JSON parse failed: ${cleanJson.slice(0, 120)}...`);
    return null;
  }
}

// ─── Patch hunk builder ───────────────────────────────────────────────────────

/**
 * Build a proper unified diff hunk for a suggestion.
 *
 * Strategy:
 *  1. Read the actual source file from disk.
 *  2. Search for the "before" snippet inside the file to find real line numbers.
 *  3. Emit a proper @@ -start,count +start,count @@ hunk with 3 context lines.
 *  4. If the exact snippet is not found, try to find the most distinctive
 *     single line from "before" to at least get the right area.
 *  5. If nothing matches, skip — a corrupt patch is worse than no patch.
 */
function buildPatchHunk(suggestion) {
  const fix = suggestion?.fix;
  if (!fix?.file || !fix?.before || !fix?.after) return null;
  if (fix.before.trim() === fix.after.trim()) return null;

  // Try to read the actual file
  let fileContent = null;
  try {
    const candidates = [
      resolve(fix.file),
      resolve(process.cwd(), fix.file),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        fileContent = readFileSync(candidate, "utf8");
        break;
      }
    }
  } catch {
    // file unreadable
  }

  const beforeText = fix.before.trim();
  const afterText  = fix.after.trim();
  const CONTEXT    = 3;

  if (fileContent) {
    const fileLines   = fileContent.split("\n");
    const beforeLines = beforeText.split("\n");

    // Search for the before snippet in the file (normalise whitespace for matching)
    const normalise = (s) => s.trim().replace(/\s+/g, " ");

    let matchStart = -1;

    // Try exact multi-line match first
    outer:
    for (let i = 0; i <= fileLines.length - beforeLines.length; i++) {
      for (let j = 0; j < beforeLines.length; j++) {
        if (normalise(fileLines[i + j]) !== normalise(beforeLines[j])) continue outer;
      }
      matchStart = i;
      break;
    }

    // Fall back: find most distinctive line from before snippet
    if (matchStart === -1 && beforeLines.length > 0) {
      const probe = beforeLines
        .map((l) => l.trim())
        .filter((l) => l.length > 10)
        .sort((a, b) => b.length - a.length)[0];

      if (probe) {
        const idx = fileLines.findIndex((l) => normalise(l) === normalise(probe));
        if (idx !== -1) matchStart = Math.max(0, idx - Math.floor(beforeLines.length / 2));
      }
    }

    if (matchStart !== -1) {
      const ctxStart  = Math.max(0, matchStart - CONTEXT);
      const ctxEnd    = Math.min(fileLines.length, matchStart + beforeLines.length + CONTEXT);
      const afterLines = afterText.split("\n");

      const hunkLines = [];

      // Context before
      for (let i = ctxStart; i < matchStart; i++) {
        hunkLines.push(" " + fileLines[i]);
      }
      // Removed lines
      for (let i = matchStart; i < matchStart + beforeLines.length && i < fileLines.length; i++) {
        hunkLines.push("-" + fileLines[i]);
      }
      // Added lines
      for (const line of afterLines) {
        hunkLines.push("+" + line);
      }
      // Context after
      for (let i = matchStart + beforeLines.length; i < ctxEnd; i++) {
        hunkLines.push(" " + fileLines[i]);
      }

      const oldCount = (matchStart - ctxStart) + beforeLines.length + (ctxEnd - matchStart - beforeLines.length);
      const newCount = (matchStart - ctxStart) + afterLines.length  + (ctxEnd - matchStart - beforeLines.length);
      const header   = `@@ -${ctxStart + 1},${oldCount} +${ctxStart + 1},${newCount} @@`;

      return `--- a/${fix.file}\n+++ b/${fix.file}\n${header}\n${hunkLines.join("\n")}`;
    }
  }

  // File not found or snippet not located — skip rather than emit corrupt patch
  console.log(`    ↳ skipping patch for ${fix.file} — snippet not found in file`);
  return null;
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

  console.log(`  Model:  ${MODEL_ID}`);
  console.log(`  Region: ${awsRegion}`);

  // Validate credentials and verify AWS identity via STS before any Bedrock calls
  validateAwsCredentials();
  await verifyAwsIdentity(awsRegion);

  // ── Resolve findings from either HTML or JSON input ──────────────────────
  let findings    = [];
  let inputMode   = "json";

  if (typeof findingsOutput === "string" && findingsOutput.endsWith(".html")) {
    inputMode = "html";
    console.log(`  Parsing HTML report: ${findingsOutput}`);
    findings  = parseHtmlReport(findingsOutput);
    console.log(`  HTML findings parsed: ${findings.length}`);
  } else {
    findings = findingsOutput?.findings ?? [];
    console.log(`  JSON findings loaded: ${findings.length}`);
  }

  const uniqueFindings = deduplicateFindings(findings, sourceRoot);
  console.log(`  ${findings.length} findings → ${uniqueFindings.length} unique root causes`);

  // ── Attach source snippets to every finding before batching ──────────────
  for (const finding of uniqueFindings) {
    const { file, snippet } = resolveSourceSnippet(finding, sourceRoot);
    finding.sourceFile    = file;
    finding.sourceSnippet = snippet;
  }

  if (dryRun) {
    const batchCount = Math.ceil(uniqueFindings.length / BATCH_SIZE);
    console.log(`\n  Dry run complete. ${uniqueFindings.length} findings → ${batchCount} batch(es) previewed.\n`);
    return;
  }

  // ── Split into batches ────────────────────────────────────────────────────
  const batches = [];
  for (let i = 0; i < uniqueFindings.length; i += BATCH_SIZE) {
    batches.push(uniqueFindings.slice(i, i + BATCH_SIZE));
  }

  console.log(`  Processing ${batches.length} batch(es) of up to ${BATCH_SIZE} findings each...`);

  const allSuggestions     = [];
  const patchHunks         = [];
  let   bedrockRequestCount = 0;
  let   skipCount           = 0;

  // ── Process each batch ────────────────────────────────────────────────────
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    process.stdout.write(`  Batch ${batchIndex + 1}/${batches.length} (${batch.length} finding(s))... `);

    try {
      const prompt = buildBatchPrompt(batch);
      const result = await callBedrock(prompt);
      bedrockRequestCount++;

      if (!result?.suggestions || !Array.isArray(result.suggestions)) {
        console.log("⚠ no suggestions array in response");
        skipCount += batch.length;
        continue;
      }

      for (const suggestion of result.suggestions) {
        // Back-fill sourceFile into fix.file if Claude left it empty
        if (!suggestion.fix?.file) {
          const sourceFinding = batch.find((f) => f.id === suggestion.findingId);
          if (sourceFinding?.sourceFile) {
            suggestion.fix       = suggestion.fix ?? {};
            suggestion.fix.file  = sourceFinding.sourceFile;
          }
        }

        allSuggestions.push(suggestion);

        const patchHunk = buildPatchHunk(suggestion);
        if (patchHunk) patchHunks.push(patchHunk);
      }

      console.log(`✓ ${result.suggestions.length} fix(es)`);
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
    generatedAt:      new Date().toISOString(),
    model:            MODEL_ID,
    region:           awsRegion,
    inputMode,
    totalFindings:    findings.length,
    uniqueRoots:      uniqueFindings.length,
    batchCount:       batches.length,
    bedrockRequests:  bedrockRequestCount,
    suggested:        allSuggestions.length,
    skipped:          skipCount,
    suggestions:      allSuggestions,
  };

  writeFileSync(paths.suggestions, JSON.stringify(suggestionsOutput, null, 2));
  console.log(`  suggestions.json  → ${paths.suggestions}`);

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
    ].join("\n") + "\n"; 

    writeFileSync(paths.patch, patchContent);
    console.log(`  suggestions.patch → ${paths.patch}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(56)}`);
  console.log("  BEDROCK SUMMARY");
  console.log(`${"═".repeat(56)}`);
  console.log(`  Input mode:           ${inputMode === "html" ? "HTML report" : "JSON findings"}`);
  console.log(`  HTML findings parsed: ${inputMode === "html" ? findings.length : "N/A"}`);
  console.log(`  Unique root causes:   ${uniqueFindings.length}`);
  console.log(`  Batches processed:    ${batches.length}`);
  console.log(`  Bedrock requests:     ${bedrockRequestCount}`);
  console.log(`  Fixes generated:      ${allSuggestions.length}`);
  console.log(`  Patch hunks:          ${patchHunks.length}`);
  console.log(`  Skipped:              ${skipCount}`);

  if (allSuggestions.length) {
    const byFile = {};
    for (const suggestion of allSuggestions) {
      const filePath         = suggestion.fix?.file ?? "unknown";
      byFile[filePath]       = (byFile[filePath] ?? 0) + 1;
    }

    console.log(`\n  Fixes by file:`);
    for (const [filePath, count] of Object.entries(byFile)) {
      console.log(`    ${filePath.padEnd(48)} ${count} fix(es)`);
    }
  }

  console.log(`\n  To apply fixes: git apply suggestions.patch`);
  console.log(`  To verify:      npx uxray --no-bedrock\n`);

  return suggestionsOutput;
}