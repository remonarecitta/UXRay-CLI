#!/usr/bin/env node
/**
 * test-bedrock.js
 * Quick smoke-test to validate AWS credentials and Bedrock connectivity.
 *
 * Usage:
 *   node test-bedrock.js
 *
 * What it checks:
 *   1. .env file is loaded
 *   2. Required env vars are present
 *   3. AWS Bedrock API responds (real Claude call with a tiny prompt)
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

// ── 1. Load .env ─────────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), ".env");
const dotenvResult = loadDotenv({ path: envPath });

console.log("\n══════════════════════════════════════════════════════");
console.log("  UXRay — Bedrock Connectivity Test");
console.log("══════════════════════════════════════════════════════\n");

if (dotenvResult.error) {
  console.log("  ⚠  .env file not found — reading from shell environment only");
} else {
  console.log(`  ✓  .env loaded from: ${envPath}`);
}

// ── 2. Validate required env vars ────────────────────────────────────────────
const region    = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const keyId     = process.env.AWS_ACCESS_KEY_ID;
const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
const token     = process.env.AWS_SESSION_TOKEN;

console.log("\n  Credential check:");

let allPresent = true;

function check(label, value, required = true) {
  if (value) {
    const masked = value.slice(0, 6) + "••••••••••••" + value.slice(-4);
    console.log(`    ✓  ${label.padEnd(26)} ${masked}`);
  } else if (required) {
    console.log(`    ✗  ${label.padEnd(26)} MISSING`);
    allPresent = false;
  } else {
    console.log(`    –  ${label.padEnd(26)} not set (optional)`);
  }
}

check("AWS_REGION / DEFAULT_REGION", region);
check("AWS_ACCESS_KEY_ID",           keyId);
check("AWS_SECRET_ACCESS_KEY",       secretKey);
check("AWS_SESSION_TOKEN",           token, false);

if (!allPresent) {
  console.log("\n  ✗  Missing required credentials. Fill in your .env file and retry.\n");
  process.exit(1);
}

// ── 3. Real Bedrock call ──────────────────────────────────────────────────────
const MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

console.log(`\n  Bedrock call:`);
console.log(`    Region:  ${region}`);
console.log(`    Model:   ${MODEL_ID}`);
console.log(`    Prompt:  "Reply with the single word: pong"`);
console.log();
process.stdout.write("  Calling AWS Bedrock... ");

try {
  const client = new BedrockRuntimeClient({ region });

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
  });

  const command = new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: "application/json",
    accept:      "application/json",
    body,
  });

  const response  = await client.send(command);
  const decoded   = JSON.parse(new TextDecoder().decode(response.body));
  const replyText = decoded.content?.[0]?.text?.trim() ?? "(empty)";

  console.log("done\n");
  console.log(`  ✓  Response received:  "${replyText}"`);
  console.log("\n  ✅  AWS credentials are valid and Bedrock is reachable.");
  console.log("      You can now run:  npx uxray --bedrock\n");
  console.log("══════════════════════════════════════════════════════\n");

} catch (error) {
  console.log("failed\n");
  console.log(`  ✗  Error: ${error.name}`);
  console.log(`     ${error.message}\n`);

  // Friendly guidance per error type
  if (error.name === "ExpiredTokenException") {
    console.log("  ⚠  Your AWS session token has expired.");
    console.log("     Re-run your AWS SSO login or generate new credentials,");
    console.log("     then update AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,");
    console.log("     and AWS_SESSION_TOKEN in your .env file.\n");
  } else if (error.name === "UnrecognizedClientException") {
    console.log("  ⚠  AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is invalid.");
    console.log("     Double-check the values in your .env file.\n");
  } else if (error.name === "AccessDeniedException") {
    console.log("  ⚠  Your IAM role does not have permission to invoke this model.");
    console.log(`     Ensure 'bedrock:InvokeModel' is allowed for: ${MODEL_ID}\n`);
  } else if (error.name === "ResourceNotFoundException" || error.message?.includes("model")) {
    console.log(`  ⚠  Model not available in region '${region}'.`);
    console.log("     Claude 3.5 Sonnet v2 is available in: us-west-2, us-east-1");
    console.log("     Update AWS_REGION in your .env file.\n");
  } else if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
    console.log("  ⚠  Network error — cannot reach AWS. Check your internet connection.\n");
  }

  console.log("══════════════════════════════════════════════════════\n");
  process.exit(1);
}

