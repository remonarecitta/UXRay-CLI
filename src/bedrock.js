import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const MODEL_ID        = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const MAX_TOKENS      = 1024;
const MAX_SOURCE_CHARS = 2000;

function buildFileHints(sourceRoot) {
  return [
    {
      match: (title, description) => title.includes("accessible name") || description.includes("button-name") || title.includes("icon button"),
      file:  `${sourceRoot}/components/atoms/IconButton.tsx`,
    },
    {
      match: (title, description) => title.includes("touch target") || description.includes("28px") || description.includes("28×28"),
      file:  `${sourceRoot}/components/atoms/IconButton.scss`,
    },
    {
      match: (title, description) => title.includes("alt") || description.includes("image-alt") || description.includes("logo"),
      file:  `${sourceRoot}/components/molecules/AppLayout.tsx`,
    },
    {
      match: (title, description) => title.includes("contrast") && (description.includes("badge") || description.includes("status")),
      file:  `${sourceRoot}/components/atoms/StatusBadge.scss`,
    },
    {
      match: (title, description) => title.includes("overflow") || title.includes("reflow") || description.includes("table"),
      file:  `${sourceRoot}/pages/CampaignsList.scss`,
    },
    {
      match: (title, description) => title.includes("dark") || description.includes("dark mode") || description.includes("placeholder"),
      file:  `${sourceRoot}/styles/_global.scss`,
    },
    {
      match: (title, description) => title.includes("modal") || description.includes("dialog"),
      file:  `${sourceRoot}/components/molecules/Modal.tsx`,
    },
    {
      match: (title, description) => title.includes("label") || title.includes("textarea") || description.includes("notes"),
      file:  `${sourceRoot}/pages/CampaignForm.tsx`,
    },
    {
      match: (title, description) => title.includes("heading") || (title.includes("link") && description.includes("click")),
      file:  `${sourceRoot}/pages/CampaignDetail.tsx`,
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

async function callBedrock(prompt) {
  const requestBody = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });

  const command = new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: "application/json",
    accept:      "application/json",
    body:        requestBody,
  });

  const awsRegion    = process.env.AWS_REGION || "us-east-1";
  const bedrockClient = new BedrockRuntimeClient({ region: awsRegion });
  const response     = await bedrockClient.send(command);
  const decoded      = JSON.parse(new TextDecoder().decode(response.body));
  const responseText = decoded.content?.[0]?.text ?? "";
  const cleanJson    = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    return JSON.parse(cleanJson);
  } catch {
    console.error(`  ⚠ JSON parse failed for response: ${cleanJson.slice(0, 120)}...`);
    return null;
  }
}

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

export async function runBedrock(findingsOutput, config, paths) {
  const sourceRoot = config.sourceRoot || "src";
  const findings   = findingsOutput.findings ?? [];
  const awsRegion  = process.env.AWS_REGION || "us-east-1";
  const dryRun     = process.argv.includes("--dry-run");

  console.log(`  Model:  ${MODEL_ID}`);
  console.log(`  Region: ${awsRegion}`);

  const uniqueFindings = deduplicateFindings(findings, sourceRoot);
  console.log(`  ${findings.length} findings → ${uniqueFindings.length} unique root causes`);

  const suggestions = [];
  const patchHunks  = [];
  let successCount  = 0;
  let skipCount     = 0;

  for (const finding of uniqueFindings) {
    const { file, snippet } = resolveSourceSnippet(finding, sourceRoot);
    const label = `[${finding.severity.toUpperCase()}] ${finding.title}`;

    process.stdout.write(`  ${label.slice(0, 60).padEnd(62)}`);

    if (dryRun) {
      console.log("→ skipped (dry-run)");
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

      if (!suggestion.fix?.file && file) {
        suggestion.fix       = suggestion.fix ?? {};
        suggestion.fix.file  = file;
      }

      suggestions.push(suggestion);

      const patchHunk = buildPatchHunk(suggestion);
      if (patchHunk) patchHunks.push(patchHunk);

      console.log(`→ ✓ ${suggestion.fix?.file ?? "no file"}`);
      successCount++;
    } catch (error) {
      console.log(`→ ✗ ${error.message.slice(0, 60)}`);
      skipCount++;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (dryRun) {
    console.log(`\n  Dry run complete. ${uniqueFindings.length} prompts previewed.\n`);
    return;
  }

  const suggestionsOutput = {
    generatedAt:   new Date().toISOString(),
    model:         MODEL_ID,
    region:        awsRegion,
    totalFindings: findings.length,
    uniqueRoots:   uniqueFindings.length,
    suggested:     successCount,
    skipped:       skipCount,
    suggestions,
  };

  writeFileSync(paths.suggestions || outputFile, JSON.stringify(suggestionsOutput, null, 2));

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

    writeFileSync(paths.patch || patchFile, patchContent);
    console.log(`  suggestions.patch → ${paths.patch || patchFile}`);
  }

  console.log(`\n${"═".repeat(56)}`);
  console.log("  BEDROCK SUMMARY");
  console.log(`${"═".repeat(56)}`);
  console.log(`  Findings processed:  ${uniqueFindings.length}`);
  console.log(`  Fixes generated:     ${successCount}`);
  console.log(`  Patch hunks:         ${patchHunks.length}`);
  console.log(`  Skipped:             ${skipCount}`);

  if (suggestions.length) {
    const byFile = {};
    for (const suggestion of suggestions) {
      const filePath = suggestion.fix?.file ?? "unknown";
      byFile[filePath] = (byFile[filePath] ?? 0) + 1;
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
