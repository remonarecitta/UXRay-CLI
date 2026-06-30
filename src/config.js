import { existsSync } from "fs";
import { resolve, join } from "path";

export const DEFAULTS = {
  baseUrl:    "http://localhost:3000",
  appName:    "UXRay audit",
  sourceRoot: "src",
  auth:       null,

  routes: [
    { name: "Home", path: "/" },
  ],

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
    nonTextContrast: 3.0,
  },

  checks: ["axe", "keyboard", "screenReader", "responsive", "errors", "wcagExtended", "ibm", "semantic", "cognitive", "screenReaderReplay", "playwright"],

  personas: {
    screenReader: true,
    keyboard:     true,
    mobile:       true,
    senior:       true,
  },

  missions: {},

  output: {
    dir:         ".uxray",
    findings:    "findings.json",
    report:      "report.html",
    patch:       "suggestions.patch",
    suggestions: "suggestions.json",
    screenshots: "screenshots",
  },

  scoring: {
    critical: 10,
    major:    5,
    minor:    2,
  },
};

export async function loadConfig(cwd = process.cwd()) {
  const configPath = join(cwd, "uxray.config.js");
  let userConfig = {};

  if (existsSync(configPath)) {
    try {
      const resolvedPath = resolve(configPath);

      // On Windows, Node ESM loader requires file:// URLs for absolute paths
      const importPath = process.platform === "win32"
        ? new URL(`file:///${resolvedPath.replace(/\\/g, "/")}`).href
        : resolvedPath;

      const module = await import(importPath);
      userConfig = module.default ?? module;
    } catch (error) {
      throw new Error(`Failed to load uxray.config.js: ${error.message}`);
    }
  }

  return mergeConfig(DEFAULTS, userConfig);
}

function mergeConfig(defaults, userConfig) {
  const merged = { ...defaults };

  for (const [key, value] of Object.entries(userConfig)) {
    if (value === null || value === undefined) continue;

    const defaultValue = defaults[key];
    const isPlainObject =
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof defaultValue === "object" &&
      !Array.isArray(defaultValue) &&
      defaultValue !== null;

    if (isPlainObject) {
      merged[key] = { ...defaultValue, ...value };
    } else {
      merged[key] = value;
    }
  }

  if (process.env.BASE_URL) {
    merged.baseUrl = process.env.BASE_URL;
  }

  if (Array.isArray(merged.viewports)) {
    const viewportMap = {};
    for (const viewport of merged.viewports) {
      viewportMap[viewport.name.toLowerCase()] = viewport;
    }
    merged.viewports = viewportMap;
  }

  merged.routes = (merged.routes ?? []).map((route) => ({
    name:         route.name ?? route.path,
    path:         route.path,
    requiresAuth: route.requiresAuth ?? false,
    waitFor:      route.waitFor ?? null,
  }));

  return merged;
}

export function validateConfig(config) {
  const errors = [];

  if (!config.baseUrl) {
    errors.push("baseUrl is required");
  }

  if (!config.routes?.length) {
    errors.push("routes must have at least one entry");
  }

  for (const route of config.routes ?? []) {
    if (!route.path) {
      errors.push(`Route "${route.name}" is missing a path`);
    }
    if (route.requiresAuth && !config.auth) {
      errors.push(`Route "${route.path}" has requiresAuth=true but no auth config provided`);
    }
  }

  if (config.auth) {
    if (!config.auth.loginUrl) {
      errors.push("auth.loginUrl is required when auth is configured");
    }
    if (!config.auth.username && !process.env.UXRAY_USER) {
      errors.push("auth.username or UXRAY_USER env var is required");
    }
    if (!config.auth.password && !process.env.UXRAY_PASS) {
      errors.push("auth.password or UXRAY_PASS env var is required");
    }
  }

  if (errors.length) {
    throw new Error(
      `uxray.config.js validation failed:\n${errors.map((error) => `  • ${error}`).join("\n")}`
    );
  }
}

export function resolveOutputPaths(config, cwd = process.cwd()) {
  const outputDir = resolve(cwd, config.output.dir);

  // Normalise to forward slashes so screenshot paths work in HTML on Windows
  const normalise = (p) => p.replace(/\\/g, "/");

  return {
    dir:         normalise(outputDir),
    findings:    normalise(join(outputDir, config.output.findings)),
    report:      normalise(join(outputDir, config.output.report)),
    patch:       normalise(join(outputDir, config.output.patch)),
    suggestions: normalise(join(outputDir, config.output.suggestions)),
    screenshots: normalise(join(outputDir, config.output.screenshots)),
  };
}
