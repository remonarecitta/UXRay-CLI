import { test } from "node:test";
import assert from "node:assert/strict";

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

  merged.routes = (merged.routes ?? []).map((route) => ({
    name:         route.name ?? route.path,
    path:         route.path,
    requiresAuth: route.requiresAuth ?? false,
    waitFor:      route.waitFor ?? null,
  }));

  return merged;
}

const DEFAULTS = {
  baseUrl:    "http://localhost:3000",
  appName:    "UXRay audit",
  auth:       null,
  routes:     [{ name: "Home", path: "/" }],
  checks:     ["axe", "keyboard"],
  scoring:    { critical: 10, major: 5, minor: 2 },
  thresholds: { contrast: 4.5, touchPx: 44 },
};

test("user baseUrl overrides default", () => {
  const result = mergeConfig(DEFAULTS, { baseUrl: "http://localhost:4000" });
  assert.equal(result.baseUrl, "http://localhost:4000");
});

test("default values are preserved when not overridden", () => {
  const result = mergeConfig(DEFAULTS, { baseUrl: "http://localhost:4000" });
  assert.equal(result.appName, "UXRay audit");
});

test("nested objects are merged not replaced", () => {
  const result = mergeConfig(DEFAULTS, { thresholds: { contrast: 7.0 } });
  assert.equal(result.thresholds.contrast, 7.0);
  assert.equal(result.thresholds.touchPx, 44);
});

test("arrays are replaced not merged", () => {
  const result = mergeConfig(DEFAULTS, { checks: ["axe"] });
  assert.deepEqual(result.checks, ["axe"]);
});

test("routes get default requiresAuth and waitFor", () => {
  const result = mergeConfig(DEFAULTS, {
    routes: [{ name: "Test", path: "/test" }],
  });
  assert.equal(result.routes[0].requiresAuth, false);
  assert.equal(result.routes[0].waitFor, null);
});

test("null user values do not override defaults", () => {
  const result = mergeConfig(DEFAULTS, { auth: null });
  assert.equal(result.auth, null);
});

test("route name defaults to path if not provided", () => {
  const result = mergeConfig(DEFAULTS, {
    routes: [{ path: "/campaigns" }],
  });
  assert.equal(result.routes[0].name, "/campaigns");
});
