import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

export class AuthSession {
  constructor(context, config) {
    this._context = context;
    this._config  = config;
    this._authed  = false;
  }

  async newPage() {
    return this._context.newPage();
  }

  isAuthed() {
    return this._authed;
  }

  async save() {
    const authConfig = this._config.auth;
    const cookiePath = authConfig?.cookieFile ? resolve(authConfig.cookieFile) : null;

    if (!cookiePath || !this._authed) return;

    try {
      const cookies = await this._context.cookies();
      const storage = await this._context.storageState();
      writeFileSync(cookiePath, JSON.stringify({ cookies, storage }, null, 2));
    } catch (error) {
      console.log(`  ⚠ Could not save session: ${error.message}`);
    }
  }

  async close() {
    await this._context.close();
  }
}

export async function createAuthSession(browser, config, viewport = { width: 1280, height: 800 }) {
  const authConfig = config.auth;

  if (!authConfig) {
    const context = await browser.newContext({ viewport });
    return new AuthSession(context, config);
  }

  const cookiePath = authConfig.cookieFile ? resolve(authConfig.cookieFile) : null;

  if (cookiePath && existsSync(cookiePath)) {
    try {
      const savedSession = JSON.parse(readFileSync(cookiePath, "utf8"));

      const context = await browser.newContext({
        viewport,
        storageState: savedSession.storage ?? { cookies: savedSession.cookies ?? [] },
      });

      const page = await context.newPage();
      const baseUrl = process.env.BASE_URL || config.baseUrl;

      await page.goto(`${baseUrl}${config.routes[0]?.path ?? "/"}`, {
        waitUntil: "domcontentloaded",
        timeout:   10000,
      });

      const isSessionValid = authConfig.waitFor
        ? await page.locator(authConfig.waitFor).isVisible({ timeout: 3000 }).catch(() => false)
        : !page.url().includes(authConfig.loginUrl ?? "/login");

      await page.close();

      if (isSessionValid) {
        const session = new AuthSession(context, config);
        session._authed = true;
        return session;
      }

      await context.close();
    } catch (error) {
      console.log(`  ⚠ Cookie restore failed: ${error.message}`);
    }
  }

  const username = authConfig.username || process.env.UXRAY_USER;
  const password = authConfig.password || process.env.UXRAY_PASS;

  if (!username || !password) {
    throw new Error(
      "Auth requires username and password. " +
      "Set UXRAY_USER and UXRAY_PASS environment variables, " +
      "or set auth.username and auth.password in uxray.config.js."
    );
  }

  const context = await browser.newContext({ viewport });
  const page    = await context.newPage();
  const baseUrl = process.env.BASE_URL || config.baseUrl;

  await page.goto(`${baseUrl}${authConfig.loginUrl}`, {
    waitUntil: "domcontentloaded",
    timeout:   15000,
  });

  const usernameSelector = authConfig.usernameSelector
    ?? "input[type='email'], input[name='username'], input[name='email'], #username, #email";
  const passwordSelector = authConfig.passwordSelector
    ?? "input[type='password'], input[name='password'], #password";
  const submitSelector   = authConfig.submitSelector
    ?? "button[type='submit'], input[type='submit']";

  try {
    await page.locator(usernameSelector).first().fill(username);
    await page.locator(passwordSelector).first().fill(password);
    await page.locator(submitSelector).first().click();

    if (authConfig.waitFor) {
      await page.locator(authConfig.waitFor).waitFor({ state: "visible", timeout: 10000 });
    } else if (authConfig.successUrl) {
      await page.waitForURL(`**${authConfig.successUrl}`, { timeout: 10000 });
    } else {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    }
  } catch (error) {
    await page.close();
    throw new Error(`Login failed: ${error.message}`);
  }

  await page.close();

  const session = new AuthSession(context, config);
  session._authed = true;

  if (cookiePath) await session.save();

  return session;
}

export async function openAuthenticatedPage(browser, config, route, viewport) {
  if (!route.requiresAuth || !config.auth) {
    const context = await browser.newContext({ viewport });
    return {
      page:    await context.newPage(),
      context,
      close:   () => context.close(),
    };
  }

  const session = await createAuthSession(browser, config, viewport);
  const page    = await session.newPage();

  return {
    page,
    context: session._context,
    close:   () => session.close(),
  };
}
