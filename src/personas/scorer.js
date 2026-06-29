import { join } from "path";
import { mkdirSync } from "fs";

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
    await page.locator(route.waitFor)
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
  }

  await page.waitForTimeout(400);
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

async function runScreenReaderPersona(page, config, paths, baseUrl) {
  const missions = [];
  const formConfig = config.missions?.createForm;
  const formRoute = config.routes.find((route) => route.path === formConfig?.path)
    ?? { path: formConfig?.path ?? "/", name: "Form" };

  if (formConfig) {
    const checks = [];
    await navigateToPage(page, `${baseUrl}${formConfig.path}`, formRoute);

    const hasMainLandmark = await page.evaluate(
      () => !!document.querySelector("main, [role='main'], form")
    );
    checks.push(createCheck("sr-landmark", "Page has main landmark", "accessibility", 8, hasMainLandmark, "", ""));

    const checkableFields = (formConfig.fields || []).filter(
      (field) => field.name !== (formConfig.unlabeledField ?? null)
    );

    for (const field of checkableFields) {
      const locator = page.getByRole(field.role, { name: field.name });
      const isVisible = await waitForVisible(locator);

      if (!isVisible) {
        const screenshotPath = await takeScreenshot(page, paths, `sr-field-${field.testId}`);
        checks.push(createCheck(
          `sr-field-${field.testId}`,
          `"${field.name}" discoverable by SR`,
          "accessibility",
          8,
          false,
          `getByRole('${field.role}', { name: '${field.name}' }) not found`,
          screenshotPath
        ));
      } else {
        checks.push(createCheck(
          `sr-field-${field.testId}`,
          `"${field.name}" discoverable by SR`,
          "accessibility",
          8,
          true,
          "Found by role+name"
        ));
      }
    }

    if (formConfig.unlabeledField) {
      const locator = page.getByRole("textbox", { name: formConfig.unlabeledField });
      const isVisible = await waitForVisible(locator);
      const screenshotPath = isVisible ? null : await takeScreenshot(page, paths, "sr-unlabeled");

      checks.push(createCheck(
        "sr-unlabeled",
        `"${formConfig.unlabeledField}" has accessible label`,
        "accessibility",
        15,
        isVisible,
        isVisible
          ? "Label found"
          : `"${formConfig.unlabeledField}" has no accessible label — axe passes (placeholder), SR fails`,
        screenshotPath
      ));
    }

    if (formConfig.submitText) {
      const isVisible = await waitForVisible(
        page.getByRole("button", { name: new RegExp(formConfig.submitText, "i") })
      );
      checks.push(createCheck("sr-submit", "Submit button has accessible name", "accessibility", 8, isVisible));
    }

    missions.push({ id: "create-form-sr", title: "Create form", checks, score: calculateScore(checks) });
  }

  const modalConfig = config.missions?.cancelModal;

  if (modalConfig) {
    const checks = [];
    const modalRoute = config.routes.find((route) => route.path === modalConfig.path)
      ?? { path: modalConfig.path };

    await navigateToPage(page, `${baseUrl}${modalConfig.path}`, modalRoute);

    try {
      await page.getByRole("button", { name: new RegExp(modalConfig.triggerText, "i") }).click();
      await page.waitForTimeout(600);

      const isDialogOpen = await waitForVisible(page.getByRole("dialog"), 2000);
      checks.push(createCheck("sr-modal-open", "Modal opens", "accessibility", 5, isDialogOpen));

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
          "Focus moves into dialog",
          "accessibility",
          15,
          focusMovedIntoDialog,
          focusMovedIntoDialog
            ? "Focus inside dialog"
            : "Focus stayed on trigger — SR user cannot interact with modal",
          screenshotPath
        ));
      }
    } catch {}

    missions.push({ id: "cancel-modal-sr", title: "Cancel modal", checks, score: calculateScore(checks) });
  }

  return {
    personaId:      "screen-reader",
    personaName:    "Screen Reader User",
    missions,
    categoryScores: {
      accessibility: calculateCategoryScore(missions, "accessibility"),
      completion:    calculateCategoryScore(missions, "completion"),
    },
    overallScore: missions.length
      ? Math.round(missions.reduce((sum, mission) => sum + mission.score, 0) / missions.length)
      : 100,
  };
}

async function runKeyboardPersona(page, config, paths, baseUrl) {
  const missions = [];
  const formConfig = config.missions?.createForm;

  if (formConfig) {
    const checks = [];
    const formRoute = config.routes.find((route) => route.path === formConfig.path)
      ?? { path: formConfig.path };

    await navigateToPage(page, `${baseUrl}${formConfig.path}`, formRoute);

    await page.keyboard.press("Tab");
    const firstFocusedTag = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase());
    const interactiveTags = ["a", "button", "input", "select", "textarea"];

    checks.push(createCheck(
      "kb-first-tab",
      "First Tab hits a control",
      "keyboard",
      8,
      interactiveTags.includes(firstFocusedTag),
      `first: <${firstFocusedTag}>`
    ));

    const hasFocusIndicator = await page.evaluate(() => {
      const button = document.querySelector("button:not([disabled])");
      if (!button) return true;
      button.focus();
      const styles = window.getComputedStyle(button);
      return parseFloat(styles.outlineWidth) > 0 || (styles.boxShadow && styles.boxShadow !== "none");
    });

    const focusScreenshot = hasFocusIndicator ? null : await takeScreenshot(page, paths, "kb-focus");

    checks.push(createCheck(
      "kb-focus-visible",
      "Buttons have visible focus ring",
      "keyboard",
      15,
      hasFocusIndicator,
      hasFocusIndicator ? "Visible" : "No outline or box-shadow — WCAG 2.4.7",
      focusScreenshot
    ));

    let formSubmitted = false;

    try {
      if (formConfig.fields?.[0]) {
        const firstField = formConfig.fields[0];
        await page.locator(`[data-testid='${firstField.testId}']`)
          .fill(firstField.value ?? "Test")
          .catch(() => {});
      }

      const submitButton = page.getByRole("button", {
        name: new RegExp(formConfig.submitText ?? "submit", "i"),
      });

      await submitButton.first().focus();
      await page.keyboard.press("Enter");

      if (formConfig.successUrl) {
        await page.waitForURL(formConfig.successUrl, { timeout: 4000 });
      }

      formSubmitted = true;
    } catch {}

    const submitScreenshot = formSubmitted ? null : await takeScreenshot(page, paths, "kb-submit");

    checks.push(createCheck("kb-submit", "Form submittable via keyboard", "keyboard", 15, formSubmitted, "", submitScreenshot));
    checks.push(createCheck("kb-complete", "Keyboard journey completes", "completion", 20, formSubmitted));

    missions.push({ id: "create-form-kb", title: "Create form", checks, score: calculateScore(checks) });
  }

  return {
    personaId:      "keyboard",
    personaName:    "Keyboard User",
    missions,
    categoryScores: {
      keyboard:   calculateCategoryScore(missions, "keyboard"),
      completion: calculateCategoryScore(missions, "completion"),
    },
    overallScore: missions.length
      ? Math.round(missions.reduce((sum, mission) => sum + mission.score, 0) / missions.length)
      : 100,
  };
}

async function runMobilePersona(browser, config, paths, baseUrl) {
  const mobileViewport = config.viewports?.mobile ?? { width: 375, height: 812 };
  const minimumTouchSize = config.thresholds?.touchPx ?? 44;

  const context = await browser.newContext({
    viewport: { width: mobileViewport.width, height: mobileViewport.height },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  });

  const page = await context.newPage();
  const missions = [];

  for (const route of config.routes.slice(0, 2)) {
    const checks = [];
    await navigateToPage(page, `${baseUrl}${route.path}`, route);

    const hasOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
    const overflowScreenshot = hasOverflow
      ? await takeScreenshot(page, paths, `mob-overflow-${route.path.replace(/\//g, "-")}`)
      : null;

    checks.push(createCheck(
      "mob-overflow",
      `No overflow at ${mobileViewport.width}px`,
      "responsiveness",
      20,
      !hasOverflow,
      hasOverflow ? `scrollWidth exceeds ${mobileViewport.width}px` : "No overflow",
      overflowScreenshot
    ));

    const smallTargets = await page.evaluate((minimumPx) => {
      const tooSmall = [];
      document.querySelectorAll("button, a[href], input, [role='button']").forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.width < minimumPx || rect.height < minimumPx)) {
          tooSmall.push({
            element: element.tagName.toLowerCase(),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
      });
      return tooSmall.slice(0, 5);
    }, minimumTouchSize);

    const touchScreenshot = smallTargets.length
      ? await takeScreenshot(page, paths, `mob-touch-${route.path.replace(/\//g, "-")}`)
      : null;

    checks.push(createCheck(
      "mob-touch",
      `Touch targets ≥${minimumTouchSize}px`,
      "responsiveness",
      20,
      smallTargets.length === 0,
      smallTargets.length
        ? `${smallTargets.length} small: <${smallTargets[0].element}> ${smallTargets[0].width}×${smallTargets[0].height}px`
        : `All ≥${minimumTouchSize}px`,
      touchScreenshot
    ));

    const formConfig = config.missions?.createForm;

    if (formConfig && route.path === formConfig.path) {
      let journeyCompleted = false;

      try {
        for (const field of (formConfig.fields || []).slice(0, 4)) {
          await page.locator(`[data-testid='${field.testId}']`)
            .fill(field.value ?? "Test")
            .catch(() => {});
        }

        await page.getByRole("button", { name: new RegExp(formConfig.submitText ?? "submit", "i") })
          .first()
          .click();

        if (formConfig.successUrl) {
          await page.waitForURL(formConfig.successUrl, { timeout: 4000 });
        }

        journeyCompleted = true;
      } catch {}

      checks.push(createCheck("mob-complete", "Mobile journey completes", "completion", 20, journeyCompleted));
    }

    missions.push({
      id:     `browse-${route.path.replace(/\//g, "-")}`,
      title:  route.name,
      checks,
      score:  calculateScore(checks),
    });
  }

  await context.close();

  return {
    personaId:      "mobile",
    personaName:    "Mobile User",
    missions,
    categoryScores: {
      responsiveness: calculateCategoryScore(missions, "responsiveness"),
      completion:     calculateCategoryScore(missions, "completion"),
    },
    overallScore: missions.length
      ? Math.round(missions.reduce((sum, mission) => sum + mission.score, 0) / missions.length)
      : 100,
  };
}

async function runSeniorPersona(page, config, paths, baseUrl) {
  const missions = [];
  const minimumContrast = config.thresholds?.contrast ?? 4.5;

  for (const route of config.routes.slice(0, 2)) {
    const checks = [];
    await navigateToPage(page, `${baseUrl}${route.path}`, route);

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
      document.querySelectorAll("p,span,h1,h2,h3,td,th,label,a,button").forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const styles = window.getComputedStyle(element);
        if (!styles.backgroundColor || styles.backgroundColor === "rgba(0, 0, 0, 0)") return;
        const ratio = getContrastRatio(styles.color, styles.backgroundColor);
        if (ratio < minimum) {
          failures.push({
            element:   element.tagName.toLowerCase(),
            className: element.className?.toString().slice(0, 30),
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
      "Text meets 4.5:1 contrast",
      "accessibility",
      20,
      contrastFailures.length === 0,
      contrastFailures.length
        ? `${contrastFailures.length} fail — e.g. .${contrastFailures[0]?.className} ratio=${contrastFailures[0]?.ratio}`
        : "All pass",
      contrastScreenshot
    ));

    const imagesWithoutAlt = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img")).filter(
        (image) => !image.getAttribute("alt") && !image.getAttribute("aria-label")
      ).length
    );

    const altScreenshot = imagesWithoutAlt
      ? await takeScreenshot(page, paths, `sen-alt-${route.path.replace(/\//g, "-")}`)
      : null;

    checks.push(createCheck(
      "sen-img-alt",
      "All images have alt text",
      "accessibility",
      10,
      imagesWithoutAlt === 0,
      imagesWithoutAlt ? `${imagesWithoutAlt} image(s) missing alt` : "All have alt",
      altScreenshot
    ));

    const smallTextCount = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll("p, td, li, span, label").forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && parseFloat(window.getComputedStyle(element).fontSize) < 14) {
          count++;
        }
      });
      return count;
    });

    checks.push(createCheck(
      "sen-font-size",
      "Body text ≥14px",
      "accessibility",
      10,
      smallTextCount === 0,
      smallTextCount ? `${smallTextCount} element(s) below 14px` : "All text ≥14px"
    ));

    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForTimeout(300);
    const zoomOverflows = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 2);
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

    const zoomScreenshot = zoomOverflows
      ? await takeScreenshot(page, paths, `sen-zoom-${route.path.replace(/\//g, "-")}`)
      : null;

    checks.push(createCheck(
      "sen-zoom",
      "Content reflows at 200% zoom",
      "responsiveness",
      15,
      !zoomOverflows,
      zoomOverflows ? "Content overflows at 200% font size" : "Reflows cleanly",
      zoomScreenshot
    ));

    missions.push({
      id:    `senior-${route.path.replace(/\//g, "-")}`,
      title: route.name,
      checks,
      score: calculateScore(checks),
    });
  }

  return {
    personaId:      "senior",
    personaName:    "Senior User",
    missions,
    categoryScores: {
      accessibility:  calculateCategoryScore(missions, "accessibility"),
      responsiveness: calculateCategoryScore(missions, "responsiveness"),
    },
    overallScore: missions.length
      ? Math.round(missions.reduce((sum, mission) => sum + mission.score, 0) / missions.length)
      : 100,
  };
}

export async function runPersonas(browser, config, paths) {
  mkdirSync(paths.screenshots, { recursive: true });

  const baseUrl = process.env.BASE_URL || config.baseUrl;
  const enabledPersonas = config.personas ?? {
    screenReader: true,
    keyboard:     true,
    mobile:       true,
    senior:       true,
  };

  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const desktopPage = await desktopContext.newPage();
  const results = [];

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
      results.push(await runMobilePersona(browser, config, paths, baseUrl));
      console.log(" done");
    } catch (error) {
      console.log(` ⚠ ${error.message.split("\n")[0]}`);
    }
  }

  const seniorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const seniorPage = await seniorContext.newPage();

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

  const allMissions = results.flatMap((persona) => persona.missions);
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
