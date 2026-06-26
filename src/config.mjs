import { existsSync } from "fs";
import { resolve, join } from "path";

export const DEFAULTS = {
  baseUrl: "http://localhost:3000",
  appName: "UXRay audit",
  sourceRoot: "src",
  auth: null,
  routes: [{ name: "Home", path: "/" }],
  viewports: {
    mobile:  { width: 375,  height: 812,  darkMode: false },
    tablet:  { width: 768,  height: 1024, darkMode: false },
    desktop: { width: 1280, height: 800,  darkMode: false },
    dark:    { width: 1280, height: 800,  darkMode: true  },
  },
  thresholds: {
  contrast:        4.5,
  touchPx:         44,
  fontScalePct:    200,
  maxTabs:         60,
  nonTextContrast: 3.0,   // ← new: WCAG 1.4.11
},
  checks: ["axe", "keyboard", "screenReader", "responsive", "errors", "wcagExtended"],
  personas: { screenReader: true, keyboard: true, mobile: true, senior: true },
  missions: {},
  output: { dir: ".uxray", findings: "findings.json", report: "report.html", reportJson: "report.json", patch: "suggestions.patch", suggestions: "suggestions.json", screenshots: "screenshots" },
  scoring: { critical: 10, major: 5, minor: 2 },
};

export async function loadConfig(cwd = process.cwd()) {
  const configPath = join(cwd, "uxray.config.js");
  let userConfig = {};
  if (existsSync(configPath)) {
    try { const mod = await import(resolve(configPath)); userConfig = mod.default ?? mod; console.log(`  Config: ${configPath}`); }
    catch (err) { throw new Error(`Failed to load uxray.config.js: ${err.message}`); }
  } else { console.log(`  Config: none found — using defaults (run: npx uxray init)`); }
  return mergeConfig(DEFAULTS, userConfig);
}

function mergeConfig(defaults, user) {
  const merged = { ...defaults };
  for (const [key, val] of Object.entries(user)) {
    if (val === null || val === undefined) continue;
    if (typeof val === "object" && !Array.isArray(val) && typeof defaults[key] === "object" && !Array.isArray(defaults[key]) && defaults[key] !== null) {
      merged[key] = { ...defaults[key], ...val };
    } else { merged[key] = val; }
  }
  if (process.env.BASE_URL) merged.baseUrl = process.env.BASE_URL;
  if (Array.isArray(merged.viewports)) { const vps = {}; for (const vp of merged.viewports) vps[vp.name.toLowerCase()] = vp; merged.viewports = vps; }
  merged.routes = (merged.routes ?? []).map((r) => ({ name: r.name ?? r.path, path: r.path, requiresAuth: r.requiresAuth ?? false, waitFor: r.waitFor ?? null }));
  return merged;
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg.baseUrl) errors.push("baseUrl is required");
  if (!cfg.routes?.length) errors.push("routes must have at least one entry");
  for (const route of cfg.routes ?? []) {
    if (!route.path) errors.push(`Route "${route.name}" is missing a path`);
    if (route.requiresAuth && !cfg.auth) errors.push(`Route "${route.path}" requiresAuth=true but no auth config provided`);
  }
  if (cfg.auth) {
    if (!cfg.auth.loginUrl) errors.push("auth.loginUrl is required when auth is configured");
    if (!cfg.auth.username && !process.env.UXRAY_USER) errors.push("auth.username or UXRAY_USER env var is required");
    if (!cfg.auth.password && !process.env.UXRAY_PASS) errors.push("auth.password or UXRAY_PASS env var is required");
  }
  if (errors.length) throw new Error(`uxray.config.js validation failed:\n${errors.map((e) => `  • ${e}`).join("\n")}`);
}

export function resolveOutputPaths(cfg, cwd = process.cwd()) {
  const dir = resolve(cwd, cfg.output.dir);
  return { dir, findings: join(dir, cfg.output.findings), report: join(dir, cfg.output.report), reportJson: join(dir, cfg.output.reportJson), patch: join(dir, cfg.output.patch), suggestions: join(dir, cfg.output.suggestions), screenshots: join(dir, cfg.output.screenshots) };
}
