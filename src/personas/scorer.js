import { createAuthenticatedContext, navigateAuthenticated } from "../context.js";
import { join } from "path";
import { mkdirSync } from "fs";


/* HELPERS */

function calculateScore(checks) {
  const totalWeight  = checks.reduce((sum, check) => sum + check.weight, 0);
  const earnedWeight = checks.reduce((sum, check) => sum + (check.pass ? check.weight : 0), 0);
  return totalWeight === 0 ? 100 : Math.round((earnedWeight / totalWeight) * 100);
}

function calculateCategoryScore(missions, category) {
  const relevantChecks = missions.flatMap((mission) =>
    mission.checks.filter((check) => check.category === category)
  );
  if (!relevantChecks.length) return null;
  const totalWeight  = relevantChecks.reduce((sum, check) => sum + check.weight, 0);
  const earnedWeight = relevantChecks.reduce((sum, check) => sum + (check.pass ? check.weight : 0), 0);
  return Math.round((earnedWeight / totalWeight) * 100);
}

function createCheck(id, label, category, weight, pass, detail = "", screenshot = null) {
  return { id, label, category, weight, pass, detail, screenshot };
}

async function waitForVisible(locator, timeoutMs = 3000) {
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function navigateToPage(page, url, route) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  if (route?.waitFor) {
    await page.locator(route.waitFor).waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  }
  await page.waitForTimeout(500);
}

async function takeScreenshot(page, paths, name) {
  try {
    const filePath = join(paths.screenshots, `persona-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}


/* FORM MISSION RUNNER — shared across personas */

async function runFormMission(page, formConfig, interactionMode, paths) {
  const checks = [];

  if (!formConfig) return checks;

  // Check 1: Page landmark reachable
  const hasLandmark = await page.evaluate(
    () => !!document.querySelector("main, [role='main'], form")
  );
  checks.push(createCheck(
    "form-landmark",
    "Form page has main landmark",
    "accessibility",
    5,
    hasLandmark,
    hasLandmark ? "Main landmark found" : "No main landmark — screen reader users cannot navigate to content"
  ));

  // Check 2: Each configured field is discoverable by accessible name
  const labelledFields = (formConfig.fields || []).filter(
    (field) => field.name !== (formConfig.unlabeledField ?? null)
  );

  for (const field of labelledFields) {
    const locator  = page.getByRole(field.role, { name: field.name });
    const isVisible = await waitForVisible(locator);

    checks.push(createCheck(
      `field-${field.testId}`,
      `"${field.name}" discoverable by accessible name`,
      "accessibility",
      10,
      isVisible,
      isVisible
        ? `Found via role="${field.role}" name="${field.name}"`
        : `Cannot find field by role+name — screen reader users cannot locate this field`
    ));
  }

  // Check 3: The unlabelled field — the key demo moment
  if (formConfig.unlabeledField) {
    const unlabelledLocator = page.getByRole("textbox", { name: formConfig.unlabeledField });
    const isDiscoverable    = await waitForVisible(unlabelledLocator);
    const screenshotPath    = isDiscoverable ? null : await takeScreenshot(page, paths, "sr-unlabeled-field");

    checks.push(createCheck(
      "field-unlabeled",
      `"${formConfig.unlabeledField}" has accessible label`,
      "accessibility",
      20,
      isDiscoverable,
      isDiscoverable
        ? "Label found — field is accessible"
        : `"${formConfig.unlabeledField}" has no accessible label. axe-core passes this (placeholder suppresses the rule) but screen reader users cannot find or identify this field. Fix: add <label> or aria-label.`,
      screenshotPath
    ));
  }

  // Check 4: Fill the form using the correct interaction mode
  let formFilled = false;

  try {
    if (interactionMode === "keyboard") {
      // Keyboard-only: tab to each field, fill with keyboard
      await page.keyboard.press("Tab");
      await page.waitForTimeout(200);

      for (const field of formConfig.fields || []) {
        try {
          const locator = page.locator(`[data-testid="${field.testId}"]`);
          await locator.focus();
          await page.waitForTimeout(100);
          await page.keyboard.type(field.value ?? "Test value");
          await page.waitForTimeout(100);
        } catch {
          // Field not reachable via keyboard
        }
      }
      formFilled = true;
    } else {
      // Screen reader / mouse mode: use getByRole to fill
      for (const field of formConfig.fields || []) {
        try {
          const locator = page.getByRole(field.role, { name: field.name });
          const visible = await waitForVisible(locator);
          if (visible) {
            await locator.first().fill(field.value ?? "Test value");
            await page.waitForTimeout(100);
          }
        } catch {
          // Field not accessible
        }
      }
      formFilled = true;
    }
  } catch {
    formFilled = false;
  }

  checks.push(createCheck(
    "form-fill",
    `Form fields fillable via ${interactionMode}`,
    "interaction",
    15,
    formFilled,
    formFilled
      ? `All labelled fields filled using ${interactionMode}`
      : `Could not fill form fields using ${interactionMode} — users cannot complete this form`
  ));

  // Check 5: Submit button is reachable and operable
  let submitReachable = false;
  let submitScreenshot = null;

  try {
    const submitPattern = new RegExp(formConfig.submitText ?? "submit", "i");

    if (interactionMode === "keyboard") {
      const submitButton = page.getByRole("button", { name: submitPattern });
      submitReachable    = await waitForVisible(submitButton);
      if (submitReachable) {
        await submitButton.first().focus();
      }
    } else {
      const submitButton = page.getByRole("button", { name: submitPattern });
      submitReachable    = await waitForVisible(submitButton);
    }

    if (!submitReachable) {
      submitScreenshot = await takeScreenshot(page, paths, "submit-not-reachable");
    }
  } catch {
    submitReachable  = false;
    submitScreenshot = await takeScreenshot(page, paths, "submit-error");
  }

  checks.push(createCheck(
    "submit-reachable",
    `Submit button reachable via ${interactionMode}`,
    "interaction",
    10,
    submitReachable,
    submitReachable
      ? "Submit button found and focusable"
      : "Submit button not reachable — users cannot submit the form",
    submitScreenshot
  ));

  // Check 6: Actually submit and verify success
  let journeyCompleted = false;
  let journeyScreenshot = null;

  try {
    const submitPattern = new RegExp(formConfig.submitText ?? "submit", "i");
    const submitButton  = page.getByRole("button", { name: submitPattern });

    if (interactionMode === "keyboard") {
      await submitButton.first().focus();
      await page.keyboard.press("Enter");
    } else {
      await submitButton.first().click();
    }

    if (formConfig.successUrl) {
      await page.waitForURL(formConfig.successUrl, { timeout: 5000 });
      journeyCompleted = true;
    } else {
      await page.waitForTimeout(1000);
      journeyCompleted = !page.url().includes(formConfig.path ?? "/new");
    }
  } catch {
    journeyCompleted  = false;
    journeyScreenshot = await takeScreenshot(page, paths, `journey-fail-${interactionMode}`);
  }

  checks.push(createCheck(
    "journey-complete",
    `Create campaign journey completes via ${interactionMode}`,
    "completion",
    25,
    journeyCompleted,
    journeyCompleted
      ? `Form submitted successfully via ${interactionMode}`
      : `Form submission failed via ${interactionMode} — the journey cannot be completed`,
    journeyScreenshot
  ));

  return checks;
}


/* SCREEN READER PERSONA */

async function runScreenReaderPersona(page, config, paths, baseUrl) {
  const missions   = [];
  const formConfig = config.missions?.createForm;
  const formRoute  = config.routes.find((route) => route.path === formConfig?.path)
    ?? { path: formConfig?.path ?? "/", name: "Create Campaign Form" };

  if (formConfig) {
    await navigateAuthenticated(page, `${baseUrl}${formConfig.path}`, config, formRoute?.waitFor);

    const formChecks = await runFormMission(page, formConfig, "screen-reader", paths);
    missions.push({
      id:    "sr-create-form",
      title: "Create campaign (screen reader)",
      checks: formChecks,
      score:  calculateScore(formChecks),
    });
  }

  // Modal focus management mission
  const modalConfig = config.missions?.cancelModal;

  if (modalConfig) {
    const checks     = [];
    const modalRoute = config.routes.find((route) => route.path === modalConfig.path)
      ?? { path: modalConfig.path };

    await navigateAuthenticated(page, `${baseUrl}${modalConfig.path}`, config, modalRoute?.waitFor);

    try {
      await page.getByRole("button", { name: new RegExp(modalConfig.triggerText, "i") }).click();
      await page.waitForTimeout(600);

      const isDialogOpen = await waitForVisible(page.getByRole("dialog"), 2000);
      checks.push(createCheck("sr-modal-open", "Modal opens on trigger click", "accessibility", 5, isDialogOpen));

      if (isDialogOpen) {
        const focusMovedIntoDialog = await page.evaluate(() => {
          const dialog = document.querySelector("[role='dialog']");
          return dialog?.contains(document.activeElement) ?? false;
        });

        const screenshotPath = focusMovedIntoDialog
          ? null
          : await takeScreenshot(page, paths, "sr-modal-focus");

        checks.push(createCheck(
          "sr-modal-focus",
          "Focus moves into dialog on open",
          "accessibility",
          20,
          focusMovedIntoDialog,
          focusMovedIntoDialog
            ? "Focus correctly moved into dialog"
            : "Focus stayed on trigger — screen reader user is stranded outside the dialog and cannot interact with it",
          screenshotPath
        ));
      }
    } catch {}

    missions.push({
      id:     "sr-cancel-modal",
      title:  "Cancel campaign modal (screen reader)",
      checks,
      score:  calculateScore(checks),
    });
  }

  return {
    personaId:      "screen-reader",
    personaName:    "Screen Reader User",
    missions,
    categoryScores: {
      accessibility: calculateCategoryScore(missions, "accessibility"),
      interaction:   calculateCategoryScore(missions, "interaction"),
      completion:    calculateCategoryScore(missions, "completion"),
    },
    overallScore: missions.length
      ? Math.round(missions.reduce((sum, mission) => sum + mission.score, 0) / missions.length)
      : 100,
  };
}


/* KEYBOARD PERSONA */

async function runKeyboardPersona(page, config, paths, baseUrl) {
  const missions   = [];
  const formConfig = config.missions?.createForm;
  const formRoute  = config.routes.find((route) => route.path === formConfig?.path)
    ?? { path: formConfig?.path ?? "/", name: "Create Campaign Form" };

  if (formConfig) {
    await navigateAuthenticated(page, `${baseUrl}${formConfig.path}`, config, formRoute?.waitFor);

    // First Tab check
    await page.keyboard.press("Tab");
    const firstFocusedTag = await page.evaluate(
      () => document.activeElement?.tagName?.toLowerCase()
    );
    const interactiveTags = ["a", "button", "input", "select", "textarea"];

    const tabChecks = [
      createCheck(
        "kb-first-tab",
        "First Tab lands on an interactive element",
        "keyboard",
        5,
        interactiveTags.includes(firstFocusedTag ?? ""),
        `First focused element: <${firstFocusedTag}>`
      ),
    ];

    // Focus indicator check
    const hasFocusIndicator = await page.evaluate(() => {
      const button = document.querySelector("button:not([disabled])");
      if (!button) return true;
      button.focus();
      const styles = window.getComputedStyle(button);
      return parseFloat(styles.outlineWidth) > 0 || styles.boxShadow !== "none";
    });

    const focusScreenshot = hasFocusIndicator
      ? null
      : await takeScreenshot(page, paths, "kb-focus-indicator");

    tabChecks.push(createCheck(
      "kb-focus-visible",
      "Interactive elements have visible focus indicator",
      "keyboard",
      10,
      hasFocusIndicator,
      hasFocusIndicator ? "Focus indicator visible" : "No visible focus ring — WCAG 2.4.7",
      focusScreenshot
    ));

    // Re-navigate and run form mission via keyboard
    await navigateAuthenticated(page, `${baseUrl}${formConfig.path}`, config, formRoute?.waitFor);
    const formChecks = await runFormMission(page, formConfig, "keyboard", paths);

    missions.push({
      id:     "kb-create-form",
      title:  "Create campaign (keyboard only)",
      checks: [...tabChecks, ...formChecks],
      score:  calculateScore([...tabChecks, ...formChecks]),
    });
  }

  return {
    personaId:      "keyboard",
    personaName:    "Keyboard User",
    missions,
    categoryScores: {
      keyboard:    calculateCategoryScore(missions, "keyboard"),
      interaction: calculateCategoryScore(missions, "interaction"),
      completion:  calculateCategoryScore(missions, "completion"),
    },
    overallScore: missions.length
      ? Math.round(missions.reduce((sum, mission) => sum + mission.score, 0) / missions.length)
      : 100,
  };
}


/* MOBILE PERSONA */

async function runMobilePersona(browser, config, paths, baseUrl, authStorage = null) {
  const mobileViewport   = config.viewports?.mobile ?? { width: 375, height: 812 };
  const minimumTouchSize = config.thresholds?.touchPx ?? 44;
  const formConfig       = config.missions?.createForm;

  const context = await createAuthenticatedContext(browser, config, {
    width:  mobileViewport.width,
    height: mobileViewport.height,
  });
  await context.setExtraHTTPHeaders({
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  });

  const page     = await context.newPage();
  const missions = [];

  // Browse mission — overflow and touch targets on each route
  for (const route of config.routes.slice(0, 2)) {
    const checks = [];
    const formRoute = config.routes.find((r) => r.path === formConfig?.path);

    await navigateAuthenticated(page, `${baseUrl}${route.path}`, config, route?.waitFor);

    const hasOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
    const overflowScreenshot = hasOverflow
      ? await takeScreenshot(page, paths, `mob-overflow-${route.path.replace(/\//g, "-")}`)
      : null;

    checks.push(createCheck(
      "mob-overflow",
      `No horizontal overflow at ${mobileViewport.width}px`,
      "responsiveness",
      15,
      !hasOverflow,
      hasOverflow
        ? `Page overflows by ${await page.evaluate(() => document.body.scrollWidth - window.innerWidth)}px — mobile users must scroll horizontally`
        : "No overflow",
      overflowScreenshot
    ));

    const smallTargets = await page.evaluate((minimum) => {
      const tooSmall = [];
      document.querySelectorAll("button, a[href], input, [role='button']").forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.width < minimum || rect.height < minimum)) {
          tooSmall.push({
            element: element.tagName.toLowerCase(),
            width:   Math.round(rect.width),
            height:  Math.round(rect.height),
            label:   (element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 30),
          });
        }
      });
      return tooSmall.slice(0, 5);
    }, minimumTouchSize);

    const touchScreenshot = smallTargets.length
      ? await takeScreenshot(page, paths, `mob-touch-${route.path.replace(/\//g, "-")}`)
      : null;

    checks.push(createCheck(
      "mob-touch-targets",
      `Touch targets ≥ ${minimumTouchSize}px`,
      "responsiveness",
      15,
      smallTargets.length === 0,
      smallTargets.length
        ? `${smallTargets.length} element(s) too small — e.g. <${smallTargets[0].element}> "${smallTargets[0].label}" ${smallTargets[0].width}×${smallTargets[0].height}px`
        : `All touch targets meet the ${minimumTouchSize}px minimum`,
      touchScreenshot
    ));

    missions.push({
      id:    `mob-browse-${route.path.replace(/\//g, "-")}`,
      title: `Browse ${route.name} (mobile)`,
      checks,
      score: calculateScore(checks),
    });
  }

  // Form mission on mobile
  if (formConfig) {
    const formRoute = config.routes.find((r) => r.path === formConfig.path)
      ?? { path: formConfig.path, name: "Create Campaign" };

    await navigateAuthenticated(page, `${baseUrl}${formConfig.path}`, config, formRoute?.waitFor);

    const formChecks = await runFormMission(page, formConfig, "touch", paths);

    missions.push({
      id:    "mob-create-form",
      title: "Create campaign (mobile touch)",
      checks: formChecks,
      score:  calculateScore(formChecks),
    });
  }

  await context.close();

  return {
    personaId:      "mobile",
    personaName:    "Mobile User",
    missions,
    categoryScores: {
      responsiveness: calculateCategoryScore(missions, "responsiveness"),
      interaction:    calculateCategoryScore(missions, "interaction"),
      completion:     calculateCategoryScore(missions, "completion"),
    },
    overallScore: missions.length
      ? Math.round(missions.reduce((sum, mission) => sum + mission.score, 0) / missions.length)
      : 100,
  };
}


/* SENIOR PERSONA */

async function runSeniorPersona(page, config, paths, baseUrl) {
  const missions       = [];
  const minimumContrast = config.thresholds?.contrast ?? 4.5;
  const formConfig     = config.missions?.createForm;

  for (const route of config.routes.slice(0, 2)) {
    const checks = [];

    await navigateAuthenticated(page, `${baseUrl}${route.path}`, config, route?.waitFor);

    // Contrast check
    const contrastFailures = await page.evaluate((minimum) => {
      const toLinear = (channel) => {
        const normalised = channel / 255;
        return normalised <= 0.03928 ? normalised / 12.92 : Math.pow((normalised + 0.055) / 1.055, 2.4);
      };
      const getLuminance = (red, green, blue) =>
        0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);
      const parseColor = (colorString) => (colorString.match(/\d+/g) || []).map(Number);
      const getContrastRatio = (foreground, background) => {
        const [r1, g1, b1] = parseColor(foreground);
        const [r2, g2, b2] = parseColor(background);
        const lum1 = getLuminance(r1, g1, b1);
        const lum2 = getLuminance(r2, g2, b2);
        return (Math.max(lum1, lum2) + 0.05) / (Math.min(lum1, lum2) + 0.05);
      };

      const failures = [];
      document.querySelectorAll("p, span, h1, h2, h3, td, th, label, a, button").forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const styles = window.getComputedStyle(element);
        if (!styles.backgroundColor || styles.backgroundColor === "rgba(0, 0, 0, 0)") return;
        const ratio = getContrastRatio(styles.color, styles.backgroundColor);
        if (ratio < minimum) {
          failures.push({
            element:   element.tagName.toLowerCase(),
            className: element.className?.toString().slice(0, 40),
            ratio:     Math.round(ratio * 100) / 100,
          });
        }
      });

      return failures.slice(0, 5);
    }, minimumContrast);

    const contrastScreenshot = contrastFailures.length
      ? await takeScreenshot(page, paths, `sen-contrast-${route.path.replace(/\//g, "-")}`)
      : null;

    checks.push(createCheck(
      "sen-contrast",
      `Text contrast meets 4.5:1 ratio`,
      "accessibility",
      15,
      contrastFailures.length === 0,
      contrastFailures.length
        ? `${contrastFailures.length} element(s) fail — e.g. .${contrastFailures[0]?.className} ratio=${contrastFailures[0]?.ratio}`
        : "All text passes contrast check",
      contrastScreenshot
    ));

    // Alt text check
    const imagesWithoutAlt = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .filter((image) => !image.getAttribute("alt") && !image.getAttribute("aria-label")).length
    );

    const altScreenshot = imagesWithoutAlt
      ? await takeScreenshot(page, paths, `sen-alt-${route.path.replace(/\//g, "-")}`)
      : null;

    checks.push(createCheck(
      "sen-img-alt",
      "All images have descriptive alt text",
      "accessibility",
      10,
      imagesWithoutAlt === 0,
      imagesWithoutAlt ? `${imagesWithoutAlt} image(s) missing alt text` : "All images have alt text",
      altScreenshot
    ));

    // 200% zoom reflow check
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForTimeout(300);
    const zoomOverflows = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 2);
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

    const zoomScreenshot = zoomOverflows
      ? await takeScreenshot(page, paths, `sen-zoom-${route.path.replace(/\//g, "-")}`)
      : null;

    checks.push(createCheck(
      "sen-zoom-reflow",
      "Content reflows at 200% zoom without horizontal scroll",
      "responsiveness",
      10,
      !zoomOverflows,
      zoomOverflows
        ? "Content overflows at 200% font size — seniors who increase text size lose content"
        : "Content reflows correctly at 200% zoom",
      zoomScreenshot
    ));

    missions.push({
      id:    `sen-browse-${route.path.replace(/\//g, "-")}`,
      title: `Browse ${route.name} (senior)`,
      checks,
      score: calculateScore(checks),
    });
  }

  // Form mission at 200% zoom
  if (formConfig) {
    const formRoute = config.routes.find((r) => r.path === formConfig.path)
      ?? { path: formConfig.path, name: "Create Campaign" };

    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await navigateAuthenticated(page, `${baseUrl}${formConfig.path}`, config, formRoute?.waitFor);

    const formChecks = await runFormMission(page, formConfig, "screen-reader", paths);

    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

    missions.push({
      id:    "sen-create-form",
      title: "Create campaign (200% zoom)",
      checks: formChecks,
      score:  calculateScore(formChecks),
    });
  }

  return {
    personaId:      "senior",
    personaName:    "Senior User",
    missions,
    categoryScores: {
      accessibility:  calculateCategoryScore(missions, "accessibility"),
      responsiveness: calculateCategoryScore(missions, "responsiveness"),
      interaction:    calculateCategoryScore(missions, "interaction"),
      completion:     calculateCategoryScore(missions, "completion"),
    },
    overallScore: missions.length
      ? Math.round(missions.reduce((sum, mission) => sum + mission.score, 0) / missions.length)
      : 100,
  };
}


/* MAIN EXPORT */

export async function runPersonas(browser, config, paths, authStorage = null) {
  mkdirSync(paths.screenshots, { recursive: true });

  const baseUrl         = process.env.BASE_URL || config.baseUrl;
  const enabledPersonas = config.personas ?? {
    screenReader: true,
    keyboard:     true,
    mobile:       true,
    senior:       true,
  };

  const desktopContext = await createAuthenticatedContext(browser, config);
  const desktopPage    = await desktopContext.newPage();
  const results        = [];

  if (enabledPersonas.screenReader?.enabled ?? enabledPersonas.screenReader) {
    process.stdout.write("   persona: screen reader...");
    try {
      results.push(await runScreenReaderPersona(desktopPage, config, paths, baseUrl));
      console.log(" done");
    } catch (error) {
      console.log(` ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  if (enabledPersonas.keyboard?.enabled ?? enabledPersonas.keyboard) {
    process.stdout.write("   persona: keyboard...");
    try {
      results.push(await runKeyboardPersona(desktopPage, config, paths, baseUrl));
      console.log(" done");
    } catch (error) {
      console.log(` ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  await desktopContext.close();

  if (enabledPersonas.mobile?.enabled ?? enabledPersonas.mobile) {
    process.stdout.write("   persona: mobile...");
    try {
      results.push(await runMobilePersona(browser, config, paths, baseUrl, authStorage));
      console.log(" done");
    } catch (error) {
      console.log(` ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  const seniorContext = await createAuthenticatedContext(browser, config);
  const seniorPage    = await seniorContext.newPage();

  if (enabledPersonas.senior?.enabled ?? enabledPersonas.senior) {
    process.stdout.write("   persona: senior...");
    try {
      results.push(await runSeniorPersona(seniorPage, config, paths, baseUrl));
      console.log(" done");
    } catch (error) {
      console.log(` ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  await seniorContext.close();

  const allMissions  = results.flatMap((persona) => persona.missions);
  const overallScore = results.length
    ? Math.round(results.reduce((sum, persona) => sum + persona.overallScore, 0) / results.length)
    : 100;

  const categoryMap = {};
  for (const persona of results) {
    for (const [category, categoryScore] of Object.entries(persona.categoryScores)) {
      if (categoryScore !== null) {
        categoryMap[category] = categoryMap[category] ?? [];
        categoryMap[category].push(categoryScore);
      }
    }
  }

  const categoryAverages = {};
  for (const [category, scores] of Object.entries(categoryMap)) {
    categoryAverages[category] = Math.round(
      scores.reduce((sum, score) => sum + score, 0) / scores.length
    );
  }

  const missionTable = allMissions.map((mission) => {
    const persona = results.find((p) => p.missions.includes(mission));
    return {
      persona:  persona?.personaName ?? "",
      mission:  mission.title,
      score:    mission.score,
      checks:   mission.checks.length,
      passed:   mission.checks.filter((check) => check.pass).length,
      failed:   mission.checks.filter((check) => !check.pass).length,
      failures: mission.checks
        .filter((check) => !check.pass)
        .map((check) => ({
          id:         check.id,
          label:      check.label,
          detail:     check.detail,
          screenshot: check.screenshot,
        })),
    };
  });

  return {
    generatedAt:      new Date().toISOString(),
    target:           baseUrl,
    overallScore,
    categoryAverages,
    personas:         results,
    missionTable,
  };
}
