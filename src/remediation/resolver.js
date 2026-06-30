/**
 * src/remediation/resolver.js
 *
 * Multi-tier source file resolution for accessibility findings.
 * Determines which source file is responsible for a given finding
 * so that Phase 2 (AST editor) knows exactly where to apply the fix.
 *
 * Tier order (fastest/most-precise first):
 *   1  Route -> Component map   config.remediation.routeComponents     instant
 *   2  DOM selector -> Babel    finding.domSelector (axe only)         high precision
 *   3  Babel AST violation      axe rule -> JSX pattern search         medium precision
 *   4  Keyword content search   axe rule -> file content patterns      low precision
 *   5  CSS class search         contrast/color findings -> SCSS/CSS    medium precision
 *   6  Legacy file hints        existing bedrock.js keyword matching   low precision (fallback)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, join, extname } from "path";
import * as babelParser from "@babel/parser";

// ---- Source context budgets -------------------------------------------------

const SOURCE_CHAR_BUDGET = {
  ".tsx":  6000,
  ".jsx":  6000,
  ".ts":   4000,
  ".js":   4000,
  ".scss": 3000,
  ".css":  3000,
};
const DEFAULT_BUDGET = 2000;

export function getSourceBudget(filePath) {
  return SOURCE_CHAR_BUDGET[extname(filePath).toLowerCase()] ?? DEFAULT_BUDGET;
}

// ---- Confidence ordering ---------------------------------------------------

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

function meetsThreshold(confidence, threshold) {
  return (CONFIDENCE_RANK[confidence] ?? 0) >= (CONFIDENCE_RANK[threshold] ?? 0);
}

// ---- File extensions --------------------------------------------------------

const ALL_EXTENSIONS   = new Set([".tsx", ".jsx", ".ts", ".js", ".scss", ".css"]);
const REACT_EXTENSIONS = new Set([".tsx", ".jsx"]);
const STYLE_EXTENSIONS = new Set([".scss", ".css"]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".uxray",
  "__tests__", "coverage", ".next", ".nuxt", "out",
]);

// ---- File walker ------------------------------------------------------------

export function walkSourceFiles(dir, extensions = ALL_EXTENSIONS, maxDepth = 8, _depth = 0) {
  const results = [];
  if (_depth > maxDepth) return results;

  let entries;
  try { entries = readdirSync(dir); } catch { return results; }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    if (stat.isDirectory()) {
      results.push(...walkSourceFiles(fullPath, extensions, maxDepth, _depth + 1));
    } else if (extensions.has(extname(entry).toLowerCase())) {
      results.push(fullPath);
    }
  }

  return results;
}

// ---- File reading -----------------------------------------------------------

function readFileSafe(filePath) {
  try { return readFileSync(filePath, "utf8"); } catch { return null; }
}

function readFileWithBudget(filePath) {
  const content = readFileSafe(filePath);
  if (!content) return null;
  const budget = getSourceBudget(filePath);
  return content.length > budget
    ? content.slice(0, budget) + "\n// ... (truncated for context budget)"
    : content;
}

// ---- DOM selector parser ----------------------------------------------------

export function parseDomSelector(selector) {
  if (!selector || typeof selector !== "string") return null;

  const ids          = [];
  const classes      = [];
  const dataTestIds  = [];
  const elementTypes = [];

  for (const m of selector.matchAll(/#([\w-]+)/g))           ids.push(m[1]);
  for (const m of selector.matchAll(/\.([\w-]+)/g))          classes.push(m[1]);
  for (const m of selector.matchAll(/\[data-testid=["']?([\w-]+)["']?\]/g))
    dataTestIds.push(m[1]);

  const PSEUDO_WORDS = new Set(["not","nth","first","last","only","has","is","where","and","or"]);
  for (const m of selector.matchAll(/(?:^|[\s>+~,(])([a-z][a-z0-9]*)/g)) {
    const tag = m[1];
    if (!PSEUDO_WORDS.has(tag)) elementTypes.push(tag);
  }

  return { ids, classes, dataTestIds, elementTypes };
}

// ---- Axe rule ID extraction -------------------------------------------------

export function extractAxeRuleId(description) {
  const m = String(description ?? "").match(/^\[([a-z0-9-]+)\]/);
  return m ? m[1] : null;
}

// ---- Axe rule -> content patterns ------------------------------------------

const AXE_RULE_CONTENT_PATTERNS = {
  "button-name":            { patterns: ["<button", "<Button"],                       ext: REACT_EXTENSIONS },
  "image-alt":              { patterns: ["<img",    "<Image"],                        ext: REACT_EXTENSIONS },
  "link-name":              { patterns: ["<a ",     "<a\n",   "<Link"],               ext: REACT_EXTENSIONS },
  "label":                  { patterns: ["<input",  "<Input", "<select","<textarea"], ext: REACT_EXTENSIONS },
  "select-name":            { patterns: ["<select", "<Select"],                       ext: REACT_EXTENSIONS },
  "heading-order":          { patterns: ["<h1","<h2","<h3","<h4"],                   ext: REACT_EXTENSIONS },
  "landmark-one-main":      { patterns: ["<main",   "<Main"],                         ext: REACT_EXTENSIONS },
  "frame-title":            { patterns: ["<iframe", "<frame"],                        ext: REACT_EXTENSIONS },
  "html-has-lang":          { patterns: ["lang="],                                    ext: REACT_EXTENSIONS },
  "document-title":         { patterns: ["<title",  "<Title",  "document.title"],    ext: REACT_EXTENSIONS },
  "tabindex":               { patterns: ["tabIndex","tabindex"],                      ext: REACT_EXTENSIONS },
  "aria-required-attr":     { patterns: ["role=",   "aria-"],                         ext: REACT_EXTENSIONS },
  "color-contrast":         { patterns: [],                                           ext: STYLE_EXTENSIONS },
  "color-contrast-enhanced":{ patterns: [],                                           ext: STYLE_EXTENSIONS },
};

// ---- Babel AST helpers -----------------------------------------------------

function parseBabel(content) {
  try {
    return babelParser.parse(content, {
      sourceType:    "module",
      errorRecovery: true,
      plugins:       ["jsx", "typescript", "decorators-legacy", "classProperties"],
    });
  } catch {
    return null;
  }
}

function walkAst(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type && visitor[node.type]) visitor[node.type](node);

  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c === "object" && c.type) walkAst(c, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walkAst(child, visitor);
    }
  }
}

function astMatchesDomSelector(content, { ids, classes, dataTestIds, elementTypes }) {
  const ast = parseBabel(content);
  if (!ast) return false;

  let matched = false;

  walkAst(ast, {
    JSXOpeningElement(node) {
      if (matched) return;

      const tagName = (node.name?.name ?? node.name?.property?.name ?? "").toLowerCase();
      const attrs   = node.attributes ?? [];

      if (elementTypes?.length && !elementTypes.includes(tagName)) return;

      for (const attr of attrs) {
        if (attr.type !== "JSXAttribute") continue;
        const attrName  = String(attr.name?.name ?? "");
        const attrValue = String(
          attr.value?.value ??
          attr.value?.expression?.value ??
          attr.value?.expression?.quasis?.[0]?.value?.cooked ??
          ""
        );

        if (ids?.length && attrName === "id" && ids.includes(attrValue)) {
          matched = true; return;
        }
        if (classes?.length && (attrName === "className" || attrName === "class")) {
          if (classes.some((c) => attrValue.split(/\s+/).includes(c))) {
            matched = true; return;
          }
        }
        if (dataTestIds?.length && attrName === "data-testid" && dataTestIds.includes(attrValue)) {
          matched = true; return;
        }
      }
    },
  });

  return matched;
}

// ---- Babel AST violation checkers ------------------------------------------

const AST_VIOLATION_CHECKERS = {
  "button-name"(content) {
    const ast = parseBabel(content);
    if (!ast) return false;
    let found = false;
    walkAst(ast, {
      JSXOpeningElement(node) {
        if (found) return;
        if ((node.name?.name ?? "").toLowerCase() !== "button") return;
        const hasLabel = (node.attributes ?? []).some(
          (a) => a.type === "JSXAttribute" &&
                 (a.name?.name === "aria-label" || a.name?.name === "aria-labelledby")
        );
        if (!hasLabel) found = true;
      },
    });
    return found;
  },

  "image-alt"(content) {
    const ast = parseBabel(content);
    if (!ast) return false;
    let found = false;
    walkAst(ast, {
      JSXOpeningElement(node) {
        if (found) return;
        if ((node.name?.name ?? "").toLowerCase() !== "img") return;
        const hasAlt = (node.attributes ?? []).some(
          (a) => a.type === "JSXAttribute" && a.name?.name === "alt"
        );
        if (!hasAlt) found = true;
      },
    });
    return found;
  },

  "link-name"(content) {
    const ast = parseBabel(content);
    if (!ast) return false;
    let found = false;
    walkAst(ast, {
      JSXOpeningElement(node) {
        if (found) return;
        if ((node.name?.name ?? "").toLowerCase() !== "a") return;
        const hasLabel = (node.attributes ?? []).some(
          (a) => a.type === "JSXAttribute" &&
                 (a.name?.name === "aria-label" || a.name?.name === "aria-labelledby")
        );
        if (!hasLabel && !node.selfClosing) found = true;
      },
    });
    return found;
  },

  "label"(content) {
    const ast = parseBabel(content);
    if (!ast) return false;
    let found = false;
    walkAst(ast, {
      JSXOpeningElement(node) {
        if (found) return;
        const tag = (node.name?.name ?? "").toLowerCase();
        if (!["input","select","textarea"].includes(tag)) return;
        const hasLabel = (node.attributes ?? []).some(
          (a) => a.type === "JSXAttribute" &&
                 ["aria-label","aria-labelledby","id"].includes(a.name?.name ?? "")
        );
        if (!hasLabel) found = true;
      },
    });
    return found;
  },
};

// ---- Tier implementations --------------------------------------------------

function tier1RouteMap(finding, config) {
  const routeMap = config.remediation?.routeComponents;
  if (!routeMap || Object.keys(routeMap).length === 0) return null;

  const direct = routeMap[finding.route];
  if (direct) {
    const abs = resolve(process.cwd(), direct);
    if (existsSync(abs)) return { file: abs, confidence: "medium", matchedBy: "route-map" };
  }

  for (const [pattern, filePath] of Object.entries(routeMap)) {
    const re = new RegExp("^" + pattern.replace(/:[\w]+/g, "[^/]+") + "$");
    if (re.test(finding.route)) {
      const abs = resolve(process.cwd(), filePath);
      if (existsSync(abs)) return { file: abs, confidence: "medium", matchedBy: "route-map" };
    }
  }

  return null;
}

function tier2DomSelector(finding, sourceRoot) {
  if (!finding.domSelector) return null;

  const parsed = parseDomSelector(finding.domSelector);
  if (!parsed) return null;

  if (!parsed.ids.length && !parsed.classes.length &&
      !parsed.dataTestIds.length && !parsed.elementTypes.length) return null;

  const highSpec = parsed.ids.length > 0 || parsed.dataTestIds.length > 0;

  for (const filePath of walkSourceFiles(sourceRoot, REACT_EXTENSIONS)) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    if (astMatchesDomSelector(content, parsed)) {
      return {
        file:       filePath,
        confidence: highSpec ? "high" : "medium",
        matchedBy:  "dom-selector",
      };
    }
  }

  return null;
}

function tier3AstViolation(finding, sourceRoot) {
  const ruleId  = extractAxeRuleId(finding.description);
  const checker = ruleId ? AST_VIOLATION_CHECKERS[ruleId] : null;
  if (!checker) return null;

  for (const filePath of walkSourceFiles(sourceRoot, REACT_EXTENSIONS)) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    try {
      if (checker(content)) {
        return { file: filePath, confidence: "medium", matchedBy: "ast-search" };
      }
    } catch {
      // skip
    }
  }

  return null;
}

function tier4KeywordSearch(finding, sourceRoot) {
  const ruleId  = extractAxeRuleId(finding.description);
  const pattern = ruleId ? AXE_RULE_CONTENT_PATTERNS[ruleId] : null;
  if (!pattern) return null;

  const files = walkSourceFiles(sourceRoot, pattern.ext);

  if (pattern.patterns.length === 0) {
    return files.length > 0
      ? { file: files[0], confidence: "low", matchedBy: "keyword-grep" }
      : null;
  }

  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    if (pattern.patterns.some((p) => content.includes(p))) {
      return { file: filePath, confidence: "low", matchedBy: "keyword-grep" };
    }
  }

  return null;
}

function tier5CssSearch(finding, sourceRoot) {
  const parsed  = parseDomSelector(finding.domSelector);
  const classes = parsed?.classes ?? [];

  const isColorFinding =
    finding.title?.toLowerCase().includes("contrast") ||
    extractAxeRuleId(finding.description)?.startsWith("color-contrast") === true;

  if (!isColorFinding && classes.length === 0) return null;

  for (const filePath of walkSourceFiles(sourceRoot, STYLE_EXTENSIONS)) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    if (classes.some((c) => content.includes(`.${c}`) || content.includes(`&.${c}`))) {
      return { file: filePath, confidence: "medium", matchedBy: "css-search" };
    }
  }

  if (isColorFinding) {
    const styles = walkSourceFiles(sourceRoot, STYLE_EXTENSIONS);
    if (styles.length > 0) return { file: styles[0], confidence: "low", matchedBy: "css-search" };
  }

  return null;
}

function tier6FileHints(finding, sourceRootRelative) {
  const title = String(finding.title ?? "").toLowerCase();
  const desc  = String(finding.description ?? "").toLowerCase();

  const hints = [
    { file: `${sourceRootRelative}/components/atoms/IconButton.tsx`,
      match: () => title.includes("accessible name") || desc.includes("button-name") || title.includes("icon button") },
    { file: `${sourceRootRelative}/components/atoms/IconButton.scss`,
      match: () => title.includes("touch target") || desc.includes("28px") || desc.includes("28x28") },
    { file: `${sourceRootRelative}/components/molecules/AppLayout.tsx`,
      match: () => title.includes("alt") || desc.includes("image-alt") || desc.includes("logo") },
    { file: `${sourceRootRelative}/components/atoms/StatusBadge.scss`,
      match: () => title.includes("contrast") && (desc.includes("badge") || desc.includes("status")) },
    { file: `${sourceRootRelative}/pages/CampaignsList.scss`,
      match: () => title.includes("overflow") || title.includes("reflow") || desc.includes("table") },
    { file: `${sourceRootRelative}/styles/_global.scss`,
      match: () => title.includes("dark") || desc.includes("dark mode") || desc.includes("placeholder") },
    { file: `${sourceRootRelative}/components/molecules/Modal.tsx`,
      match: () => title.includes("modal") || desc.includes("dialog") },
    { file: `${sourceRootRelative}/pages/CampaignForm.tsx`,
      match: () => title.includes("label") || title.includes("textarea") || desc.includes("notes") },
    { file: `${sourceRootRelative}/pages/CampaignDetail.tsx`,
      match: () => title.includes("heading") || (title.includes("link") && desc.includes("click")) },
  ];

  for (const hint of hints) {
    if (hint.match()) {
      const abs = resolve(process.cwd(), hint.file);
      if (existsSync(abs)) return { file: abs, confidence: "low", matchedBy: "file-hints" };
    }
  }

  return null;
}

// ---- Main export -----------------------------------------------------------

/**
 * Resolve the source file responsible for a given accessibility finding.
 *
 * @param {object} finding  - Finding object (id, title, description, route, domSelector)
 * @param {object} config   - UXRay config (sourceRoot, remediation)
 * @returns {Promise<ResolutionResult>}
 */
export async function resolveSourceFile(finding, config) {
  const sourceRootRelative = config.sourceRoot || "src";
  const sourceRoot         = resolve(process.cwd(), sourceRootRelative);
  const threshold          = config.remediation?.sourceResolutionConfidenceThreshold ?? "medium";

  if (!existsSync(sourceRoot)) {
    return {
      file: null, confidence: "low", matchedBy: "none",
      snippet: null, snippetFull: null, snippetRange: null,
      domSelector: finding.domSelector ?? null,
      meetsThreshold: false,
      error: `sourceRoot not found: ${sourceRoot}`,
    };
  }

  const tiers = [
    () => tier1RouteMap(finding, config),
    () => tier2DomSelector(finding, sourceRoot),
    () => tier3AstViolation(finding, sourceRoot),
    () => tier4KeywordSearch(finding, sourceRoot),
    () => tier5CssSearch(finding, sourceRoot),
    () => tier6FileHints(finding, sourceRootRelative),
  ];

  let result = null;

  for (const tier of tiers) {
    try {
      result = tier();
    } catch {
      result = null;
    }
    if (result?.file) break;
  }

  if (!result?.file) {
    return {
      file: null, confidence: "low", matchedBy: "none",
      snippet: null, snippetFull: null, snippetRange: null,
      domSelector: finding.domSelector ?? null,
      meetsThreshold: false,
      error: null,
    };
  }

  const fullContent = readFileSafe(result.file);
  const snippet     = readFileWithBudget(result.file);
  const budget      = getSourceBudget(result.file);

  return {
    file:         result.file,
    confidence:   result.confidence,
    matchedBy:    result.matchedBy,
    snippet,
    snippetFull:  fullContent,
    snippetRange: fullContent ? { start: 0, end: Math.min(fullContent.length, budget) } : null,
    domSelector:  finding.domSelector ?? null,
    meetsThreshold: meetsThreshold(result.confidence, threshold),
    error: null,
  };
}

