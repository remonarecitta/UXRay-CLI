/**
 * src/index.mjs
 * UXRay — public API exports
 * For use when importing uxray as a module rather than a CLI.
 */

export { loadConfig, validateConfig, resolveOutputPaths, DEFAULTS } from "./config.mjs";
export { createAuthSession, AuthSession } from "./auth.mjs";
export { runAxeChecks }          from "./checks/axe.mjs";
export { runKeyboardChecks }     from "./checks/keyboard.mjs";
export { runScreenReaderChecks } from "./checks/screenReader.mjs";
export { runResponsiveChecks }   from "./checks/responsive.mjs";
export { runErrorChecks }        from "./checks/errors.mjs";
export { runWcagExtendedChecks, getExtendedManualGaps } from "./checks/wcag-extended.mjs";
export { runPersonas }           from "./personas/scorer.mjs";
export { generateHtmlReport }    from "./report/html.mjs";
