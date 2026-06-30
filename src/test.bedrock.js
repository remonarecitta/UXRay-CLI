#!/usr/bin/env node
/**
 * test-bedrock.js
 * Smoke-test to validate AWS credentials, STS identity, and Bedrock connectivity.
 *
 * Usage:
 *   node test-bedrock.js
 *
 * Steps:
 *   1. Load .env file
 *   2. Validate required env vars are present
 *   3. STS GetCallerIdentity — proves credentials are valid (free, no extra permissions)
 *   4. AWS Bedrock API call  — proves model access is enabled
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

// Credentials loaded via Node 22 --env-file flag (no dotenv needed)
console.log("\n══════════════════════════════════════════════════════");
console.log("  UXRay — AWS Credentials & Bedrock Test");
console.log("══════════════════════════════════════════════════════\n");
console.log("  ✓  Credentials loaded via --env-file=.env");

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

// ── 3. STS GetCallerIdentity ──────────────────────────────────────────────────
// This call is FREE and works with any valid credentials — no extra permissions needed.
// If this passes → credentials are valid.
// If this fails  → credentials are wrong/expired, no point trying Bedrock.
console.log("\n  Step 3 — STS identity check (validates credentials):");
process.stdout.write("  Calling STS GetCallerIdentity... ");

let stsOk = false;

try {
  const sts      = new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));

  console.log("done\n");
  console.log(`    ✓  Account:   ${identity.Account}`);
  console.log(`    ✓  UserId:    ${identity.UserId}`);
  console.log(`    ✓  ARN:       ${identity.Arn}`);
  console.log("\n  ✅  Credentials are valid — STS confirmed your identity.");
  stsOk = true;

} catch (error) {
  console.log("failed\n");
  console.log(`  ✗  STS Error: ${error.name}`);
  console.log(`     ${error.message}\n`);

  if (error.name === "ExpiredTokenException") {
    console.log("  ⚠  Your AWS session token has EXPIRED.");
    console.log("     Re-run your AWS SSO login or generate new credentials,");
    console.log("     then update AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,");
    console.log("     and AWS_SESSION_TOKEN in your .env file.\n");
  } else if (error.name === "InvalidClientTokenId" || error.name === "UnrecognizedClientException") {
    console.log("  ⚠  AWS_ACCESS_KEY_ID is invalid or does not exist.");
    console.log("     Double-check the value in your .env file.\n");
  } else if (error.name === "SignatureDoesNotMatch") {
    console.log("  ⚠  AWS_SECRET_ACCESS_KEY does not match the Access Key ID.");
    console.log("     Double-check both values in your .env file.\n");
  } else if (error.code === "ECONNRESET" || error.message?.includes("ECONNRESET")) {
    console.log("  ⚠  Network error connecting to AWS STS.");
    console.log("     Check your internet connection or corporate proxy/VPN.\n");
  }

  console.log("  ✗  Credentials are invalid. Fix them before testing Bedrock.\n");
  console.log("══════════════════════════════════════════════════════\n");
  process.exit(1);
}

// ── 4. Bedrock call ───────────────────────────────────────────────────────────
const MODEL_ID = "us.anthropic.claude-sonnet-4-6";

console.log(`\n  Step 4 — Bedrock connectivity test:`);
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
  console.log("\n  ✅  Bedrock is reachable and the model responded.");
  console.log("      You can now run:  npx uxray --bedrock\n");

} catch (error) {
  console.log("failed\n");
  console.log(`  ✗  Bedrock Error: ${error.name}`);
  console.log(`     ${error.message}\n`);

  console.log("  ℹ  STS passed (credentials are valid) but Bedrock failed.");
  console.log("     This means the credentials work, but Bedrock model access is the issue.\n");

  if (error.name === "AccessDeniedException") {
    console.log("  ⚠  Your IAM role does not have permission to invoke this model.");
    console.log(`     Ensure 'bedrock:InvokeModel' is allowed for: ${MODEL_ID}`);
    console.log("     Ask your AWS admin to grant Bedrock invoke permissions.\n");
  } else if (error.name === "ResourceNotFoundException" || error.message?.includes("model")) {
    console.log(`  ⚠  Model '${MODEL_ID}' is not available in region '${region}'.`);
    console.log("     Claude 3.5 Sonnet v2 requires model access to be enabled:");
    console.log(`     → https://console.aws.amazon.com/bedrock/home?region=${region}#/modelaccess`);
    console.log("     → Click 'Modify model access' → enable 'Claude 3.5 Sonnet'\n");
  } else if (
    error.code === "ECONNRESET" || error.message?.includes("ECONNRESET") ||
    error.message?.includes("canceled") || error.message?.includes("stream")
  ) {
    console.log("  ⚠  Network connection reset — model access is likely not enabled.");
    console.log(`     → https://console.aws.amazon.com/bedrock/home?region=${region}#/modelaccess`);
    console.log("     → Click 'Modify model access' → enable 'Claude 3.5 Sonnet'\n");
  } else if (error.name === "ExpiredTokenException") {
    console.log("  ⚠  Session token expired between STS and Bedrock calls.");
    console.log("     Refresh your credentials in .env and re-run.\n");
  }
}

console.log("══════════════════════════════════════════════════════\n");
