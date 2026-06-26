/**
 * bedrock.mjs — UXRay AI fix suggestion engine
 *
 * Reads findings.json → calls Claude Sonnet 3.5 on AWS Bedrock per finding
 * → writes suggestions.json (structured fixes) + suggestions.patch (git-apply ready)
 *
 * Install:
 *   npm install @aws-sdk/client-bedrock-runtime
 *
 * AWS credentials — any of:
 *   export AWS_ACCESS_KEY_ID=...
 *   export AWS_SECRET_ACCESS_KEY=...
 *   export AWS_REGION=us-east-1
 *
 *   or use ~/.aws/credentials / IAM role / SSO
 *
 * Usage:
 *   node bedrock.mjs
 *   node bedrock.mjs --in findings.json --out suggestions.json --patch suggestions.patch
 *   node bedrock.mjs --dry-run   (prints prompts without calling Bedrock)
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const MODEL_ID   = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const MAX_TOKENS = 1024;
const DRY_RUN    = process.argv.includes("--dry-run");

const inFlagIdx    = process.argv.indexOf("--in");
const outFlagIdx   = process.argv.indexOf("--out");
const patchFlagIdx = process.argv.indexOf("--patch");

const IN_FILE    = inFlagIdx    !== -1 ? resolve(process.argv[inFlagIdx    + 1]) : resolve("findings.json");
const OUT_FILE   = outFlagIdx   !== -1 ? resolve(process.argv[outFlagIdx   + 1]) : resolve("suggestions.json");
const PATCH_FILE = patchFlagIdx !== -1 ? resolve(process.argv[patchFlagIdx + 1]) : resolve("suggestions.patch");

// ─── Bedrock client ───────────────────────────────────────────────────────────

const client = new BedrockRuntimeClient({ region: AWS_REGION });

// ─── File map — where each seeded bug lives ───────────────────────────────────
// Bedrock needs this context to generate accurate patch hunks.
// In production, this would be derived from the source map.

const FILE_MAP = {
  "button-name":    "src/components/atoms/IconButton.tsx",
  "heading-order":  "src/pages/CampaignDetail.tsx",
  "image-alt":      "src/components/molecules/AppLayout.tsx",
  "color-contrast": "src/components/atoms/StatusBadge.scss",
  "overflow":       "src/pages/CampaignsList.scss",
  "touch-target":   "src/components/atoms/IconButton.scss",
  "dark-contrast":  "src/styles/_global.scss",
  "modal-focus":    "src/components/molecules/Modal.tsx",
  "textarea-label": "src/pages/CampaignForm.tsx",
  "link-purpose":   "src/pages/CampaignDetail.tsx",
};

// ─── Source file reader ───────────────────────────────────────────────────────
// Reads actual source files from disk — works on any codebase.
// Caps at MAX_SOURCE_CHARS to keep Bedrock prompts focused.

const MAX_SOURCE_CHARS = 2000;

function readSourceFile(filePath) {
  if (!filePath) return null;
  // Try relative to project root first, then as absolute
  const candidates = [
    resolve(filePath),
    resolve(process.cwd(), filePath),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const content = readFileSync(p, "utf8");
        return content.length > MAX_SOURCE_CHARS
          ? content.slice(0, MAX_SOURCE_CHARS) + "\n// ... (truncated)"
          : content;
      }
    } catch { /* try next */ }
  }
  return null;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(finding, sourceSnippet) {
  const screenshotNote = finding.screenshot
    ? `A screenshot of the failure has been captured at: ${finding.screenshot}`
    : "";

  return `You are an expert accessibility engineer reviewing a WCAG 2.1 AA compliance finding.

FINDING:
  ID:          ${finding.id}
  Route:       ${finding.route}
  Source:      ${finding.source}
  Severity:    ${finding.severity}
  WCAG:        ${finding.wcag.join(", ")}
  Title:       ${finding.title}
  Description: ${finding.description}
${screenshotNote ? `  Screenshot:  ${screenshotNote}` : ""}

BROKEN CODE:
\`\`\`
${sourceSnippet || "Source snippet not available — infer fix from the finding description."}
\`\`\`

Your task: provide a precise, production-ready fix for this finding.

Respond with ONLY a JSON object — no preamble, no markdown fences, no explanation outside the JSON.

Required shape:
{
  "findingId": "${finding.id}",
  "wcag": ${JSON.stringify(finding.wcag)},
  "severity": "${finding.severity}",
  "explanation": "One clear sentence explaining WHY this breaks accessibility for real users.",
  "userImpact": "One sentence: which users are affected and what they experience.",
  "fix": {
    "file": "path/to/file relative to project root",
    "description": "One sentence describing what the fix does.",
    "before": "The exact broken code snippet (copy from BROKEN CODE above).",
    "after": "The fixed code snippet — minimal diff, production-ready."
  },
  "wcagReference": "WCAG SC number and name, e.g. WCAG 4.1.2 Name, Role, Value",
  "testToVerify": "One sentence: how to verify the fix works (axe rule, SR announcement, or manual check)."
}`;
}

// ─── Bedrock invocation ───────────────────────────────────────────────────────

async function callBedrock(prompt) {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });

  const command = new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: "application/json",
    accept:      "application/json",
    body,
  });

  const response = await client.send(command);
  const decoded  = JSON.parse(new TextDecoder().decode(response.body));
  const text     = decoded.content?.[0]?.text ?? "";

  // Strip any accidental markdown fences
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    console.error(`  ⚠ JSON parse failed for response: ${clean.slice(0, 120)}...`);
    return null;
  }
}

// ─── Patch builder ────────────────────────────────────────────────────────────

function buildPatchHunk(suggestion) {
  const fix = suggestion?.fix;
  if (!fix?.file || !fix?.before || !fix?.after) return null;
  if (fix.before === fix.after) return null;

  const beforeLines = fix.before.split("\n").map((l) => `- ${l}`).join("\n");
  const afterLines  = fix.after.split("\n").map((l) => `+ ${l}`).join("\n");

  const beforeCount = fix.before.split("\n").length;
  const afterCount  = fix.after.split("\n").length;

  return `--- a/${fix.file}
+++ b/${fix.file}
@@ -1,${beforeCount} +1,${afterCount} @@
${beforeLines}
${afterLines}`;
}

// ─── Source snippet resolver ──────────────────────────────────────────────────
// Maps finding keywords → likely file path, then reads the actual file from disk.
// Works on any codebase — no hardcoded snippets.

// FILE_HINTS maps WCAG violation keywords → likely source file paths.
// Paths are relative to project root. sourceRoot is read from uxray.config.js
// (defaults to "src"). Override per-repo with config.sourceRoot.
// For repos with a different structure, extend this list in uxray.config.js
// via config.fileHints: [{ keywords: ["my-component"], file: "path/to/it.tsx" }]

function buildFileHints(sourceRoot) {
  return [
    { match: (t, d) => t.includes("accessible name") || d.includes("button-name") || t.includes("icon button"),
      file: `${sourceRoot}/components/atoms/IconButton.tsx` },
    { match: (t, d) => t.includes("touch target") || d.includes("28px") || d.includes("28×28"),
      file: `${sourceRoot}/components/atoms/IconButton.scss` },
    { match: (t, d) => t.includes("alt") || d.includes("image-alt") || d.includes("logo"),
      file: `${sourceRoot}/components/molecules/AppLayout.tsx` },
    { match: (t, d) => t.includes("contrast") && (d.includes("badge") || d.includes("status")),
      file: `${sourceRoot}/components/atoms/StatusBadge.scss` },
    { match: (t, d) => t.includes("overflow") || t.includes("reflow") || d.includes("table"),
      file: `${sourceRoot}/pages/CampaignsList.scss` },
    { match: (t, d) => t.includes("dark") || d.includes("dark mode") || d.includes("placeholder"),
      file: `${sourceRoot}/styles/_global.scss` },
    { match: (t, d) => t.includes("modal") || d.includes("dialog"),
      file: `${sourceRoot}/components/molecules/Modal.tsx` },
    { match: (t, d) => t.includes("label") || t.includes("textarea") || d.includes("notes"),
      file: `${sourceRoot}/pages/CampaignForm.tsx` },
    { match: (t, d) => t.includes("heading") || (t.includes("link") && d.includes("click")),
      file: `${sourceRoot}/pages/CampaignDetail.tsx` },
  ];
}

function resolveSnippet(finding, sourceRoot = "src") {
  const title = finding.title.toLowerCase();
  const desc  = finding.description.toLowerCase();
  const hints = buildFileHints(sourceRoot);

  // 1. Explicit file path on the finding (most reliable)
  if (finding.fix?.file) {
    const snippet = readSourceFile(finding.fix.file);
    if (snippet) return { file: finding.fix.file, snippet };
  }

  // 2. Keyword heuristic → read actual file from disk
  for (const hint of hints) {
    if (hint.match(title, desc)) {
      const snippet = readSourceFile(hint.file);
      return { file: hint.file, snippet };
    }
  }

  return { file: null, snippet: null };
}

// ─── Deduplication ───────────────────────────────────────────────────────────
// Multiple findings often point to the same root cause (e.g. 18 icon buttons).
// We deduplicate by title + file before calling Bedrock so we don't burn tokens.

function deduplicateFindings(findings) {
  const seen   = new Map();
  const unique = [];

  for (const f of findings) {
    if (f.source === "manual-required") continue; // skip manual gaps
    const { file } = resolveSnippet(f, "src");
    const key = `${f.title}::${file ?? f.route}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      unique.push(f);
    }
  }

  // Sort by severity: critical first
  const order = { critical: 0, major: 1, minor: 2 };
  return unique.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log("\nUXRay — Bedrock AI fix suggestion engine");
  console.log(`Model:  ${MODEL_ID}`);
  console.log(`Region: ${AWS_REGION}`);
  if (DRY_RUN) console.log("Mode:   DRY RUN (no Bedrock calls)\n");
  else         console.log("Mode:   LIVE\n");

  // Load config for sourceRoot
  const bedrockCfg = await loadBedrockConfig();
  const sourceRoot = bedrockCfg.sourceRoot ?? "src";

  // Load findings.json
  if (!existsSync(IN_FILE)) {
    console.error(`❌ ${IN_FILE} not found. Run node runner.mjs first.`);
    process.exit(1);
  }

  const input    = JSON.parse(readFileSync(IN_FILE, "utf8"));
  const findings = input.findings ?? [];

  console.log(`Loaded ${findings.length} findings from ${IN_FILE}`);

  const unique = deduplicateFindings(findings);
  console.log(`Deduplicated to ${unique.length} unique root causes\n`);

  // Process each unique finding
  const suggestions = [];
  const patchHunks  = [];
  let   successCount = 0;
  let   skipCount    = 0;

  for (const finding of unique) {
    const { file, snippet } = resolveSnippet(finding, sourceRoot);
    const label = `[${finding.severity.toUpperCase()}] ${finding.title}`;

    process.stdout.write(`  ${label.slice(0, 60).padEnd(62)}`);

    if (DRY_RUN) {
      console.log("→ skipped (dry-run)");
      const prompt = buildPrompt(finding, snippet);
      console.log(`\n  Prompt preview (${prompt.length} chars):\n  ${prompt.slice(0, 200)}...\n`);
      skipCount++;
      continue;
    }

    try {
      const prompt     = buildPrompt(finding, snippet);
      const suggestion = await callBedrock(prompt);

      if (!suggestion) {
        console.log("→ ⚠ parse error");
        skipCount++;
        continue;
      }

      // Ensure file is set
      if (!suggestion.fix?.file && file) {
        suggestion.fix = suggestion.fix ?? {};
        suggestion.fix.file = file;
      }

      suggestions.push(suggestion);

      // Build patch hunk
      const hunk = buildPatchHunk(suggestion);
      if (hunk) patchHunks.push(hunk);

      console.log(`→ ✓ ${suggestion.fix?.file ?? "no file"}`);
      successCount++;
    } catch (err) {
      console.log(`→ ✗ ${err.message.slice(0, 60)}`);
      skipCount++;
    }

    // Small delay to avoid throttling
    await new Promise((r) => setTimeout(r, 300));
  }

  if (DRY_RUN) {
    console.log(`\nDry run complete. ${unique.length} prompts previewed.\n`);
    return;
  }

  // ── Write suggestions.json ─────────────────────────────────────────────────

  const output = {
    generatedAt:   new Date().toISOString(),
    model:         MODEL_ID,
    region:        AWS_REGION,
    findingsInput: IN_FILE,
    totalFindings: findings.length,
    uniqueRoots:   unique.length,
    suggested:     successCount,
    skipped:       skipCount,
    suggestions,
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n  suggestions.json → ${OUT_FILE}`);

  // ── Write suggestions.patch ────────────────────────────────────────────────

  if (patchHunks.length > 0) {
    const patchContent = [
      `# UXRay suggestions.patch`,
      `# Generated: ${new Date().toISOString()}`,
      `# Model: ${MODEL_ID}`,
      `# Apply with: git apply suggestions.patch`,
      `# Fixes ${patchHunks.length} of ${successCount} findings`,
      "",
      ...patchHunks,
    ].join("\n");

    writeFileSync(PATCH_FILE, patchContent);
    console.log(`  suggestions.patch → ${PATCH_FILE}`);
  } else {
    console.log("  ⚠ No patch hunks generated (before/after may be identical)");
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(56)}`);
  console.log("  BEDROCK SUMMARY");
  console.log(`${"═".repeat(56)}`);
  console.log(`  Findings processed:  ${unique.length}`);
  console.log(`  Fixes generated:     ${successCount}`);
  console.log(`  Patch hunks:         ${patchHunks.length}`);
  console.log(`  Skipped:             ${skipCount}`);

  if (suggestions.length) {
    console.log(`\n  Fixes by file:`);
    const byFile = {};
    for (const s of suggestions) {
      const f = s.fix?.file ?? "unknown";
      byFile[f] = (byFile[f] ?? 0) + 1;
    }
    for (const [file, count] of Object.entries(byFile)) {
      console.log(`    ${file.padEnd(48)} ${count} fix(es)`);
    }
  }

  console.log(`\n  To apply fixes:`);
  console.log(`    git apply ${PATCH_FILE}`);
  console.log(`\n  To verify:`);
  console.log(`    node runner.mjs`);
  console.log(`    (score should rise from ~36 to ~88)\n`);
})();
