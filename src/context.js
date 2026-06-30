import { existsSync, readFileSync } from "fs";
import { resolve } from "path";


/**
 * Creates an authenticated browser context.
 *
 * Some apps store auth tokens in sessionStorage, which Playwright's
 * storageState() does not capture. To handle this reliably, a full login
 * is performed inside each new context rather than injecting storage state.
 */

async function performLogin(page, authConfig, baseUrl) {
  const username = authConfig.username || process.env.UXRAY_USER;
  const password = authConfig.password || process.env.UXRAY_PASS;

  await page.goto(`${baseUrl}${authConfig.loginUrl}`, {
    waitUntil: "domcontentloaded",
    timeout:   15000,
  });

  const usernameSelector = authConfig.usernameSelector
    ?? "input[type='email'], input[name='username'], #username, #email";
  const passwordSelector = authConfig.passwordSelector
    ?? "input[type='password'], #password";
  const submitSelector   = authConfig.submitSelector
    ?? "button[type='submit'], input[type='submit']";

  await page.locator(usernameSelector).first().fill(username);
  await page.locator(passwordSelector).first().fill(password);
  await page.locator(submitSelector).first().click();

  if (authConfig.successUrl) {
    await page.waitForURL(`**${authConfig.successUrl.replace("**", "")}`, { timeout: 10000 });
  } else if (authConfig.waitFor) {
    await page.locator(authConfig.waitFor).waitFor({ state: "visible", timeout: 10000 });
  } else {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  }
}

export async function createAuthenticatedContext(browser, config, viewport = { width: 1280, height: 800 }) {
  const authConfig = config?.auth;

  if (!authConfig) {
    return browser.newContext({ viewport });
  }

  const context = await browser.newContext({ viewport });

  // Create a page, login, then close it — the context retains the session
  const loginPage = await context.newPage();

  try {
    const baseUrl = process.env.BASE_URL || config.baseUrl;
    await performLogin(loginPage, authConfig, baseUrl);
  } catch (error) {
    await loginPage.close();
    throw new Error(`Auth failed in new context: ${error.message}`);
  }

  await loginPage.close();
  return context;
}

/**
 * Navigate to a URL and ensure the page is authenticated.
 * If the app redirects to login, perform login and re-navigate.
 */
export async function navigateAuthenticated(page, url, config, waitFor = null) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

  const loginUrl = config?.auth?.loginUrl ?? "/login";

  if (page.url().includes(loginUrl)) {
    const baseUrl = process.env.BASE_URL || config.baseUrl;
    await performLogin(page, config.auth, baseUrl);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  }

  if (waitFor) {
    await page.locator(waitFor).waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  }

  await page.waitForTimeout(400);
}
