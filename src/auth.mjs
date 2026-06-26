/**
 * src/auth.mjs
 * UXRay — authentication handler
 *
 * Supports three auth strategies:
 *   1. Cookie file — restore a saved session (fastest, no credentials in env)
 *   2. Credential login — fill username/password form and save session
 *   3. No auth — public routes only
 *
 * Usage:
 *   const session = await createAuthSession(browser, cfg);
 *   const page = await session.newPage(); // pre-authenticated
 *   await session.save();                 // save cookies for next run
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

export class AuthSession {
  constructor(context, cfg) {
    this._context = context;
    this._cfg     = cfg;
    this._authed  = false;
  }

  async newPage() {
    return this._context.newPage();
  }

  isAuthed() { return this._authed; }

  async save() {
    const authCfg   = this._cfg.auth;
    const cookiePath = authCfg?.cookieFile
      ? resolve(authCfg.cookieFile)
      : null;

    if (!cookiePath || !this._authed) return;

    try {
      const cookies = await this._context.cookies();
      const storage = await this._context.storageState();
      writeFileSync(cookiePath, JSON.stringify({ cookies, storage }, null, 2));
      console.log(`  Session saved → ${cookiePath}`);
    } catch (err) {
      console.log(`  ⚠ Could not save session: ${err.message}`);
    }
  }

  async close() {
    await this._context.close();
  }
}

// ─── Main factory ─────────────────────────────────────────────────────────────

export async function createAuthSession(browser, cfg, viewport = { width: 1280, height: 800 }) {
  const authCfg = cfg.auth;

  // Strategy 1 — no auth required
  if (!authCfg) {
    const context = await browser.newContext({ viewport });
    return new AuthSession(context, cfg);
  }

  const cookiePath = authCfg.cookieFile ? resolve(authCfg.cookieFile) : null;

  // Strategy 2 — restore from cookie file
  if (cookiePath && existsSync(cookiePath)) {
    try {
      const saved   = JSON.parse(readFileSync(cookiePath, "utf8"));
      const context = await browser.newContext({
        viewport,
        storageState: saved.storage ?? { cookies: saved.cookies ?? [] },
      });

      // Verify session is still valid
      const page = await context.newPage();
      const baseUrl = process.env.BASE_URL ?? cfg.baseUrl;
      await page.goto(`${baseUrl}${cfg.routes[0]?.path ?? "/"}`, {
        waitUntil: "domcontentloaded",
        timeout:   10_000,
      });

      const isValid = authCfg.waitFor
        ? await page.locator(authCfg.waitFor).isVisible({ timeout: 3000 }).catch(() => false)
        : !page.url().includes(authCfg.loginUrl ?? "/login");

      await page.close();

      if (isValid) {
        console.log(`  Auth: restored from ${cookiePath}`);
        const session    = new AuthSession(context, cfg);
        session._authed  = true;
        return session;
      }

      // Session expired — fall through to credential login
      await context.close();
      console.log(`  Auth: session expired, re-logging in`);
    } catch (err) {
      console.log(`  Auth: cookie restore failed (${err.message}), re-logging in`);
    }
  }

  // Strategy 3 — credential login
  const username = authCfg.username ?? process.env.UXRAY_USER;
  const password = authCfg.password ?? process.env.UXRAY_PASS;

  if (!username || !password) {
    throw new Error(
      "Auth requires username/password. Set auth.username + auth.password in config, " +
      "or set UXRAY_USER + UXRAY_PASS environment variables."
    );
  }

  const context = await browser.newContext({ viewport });
  const page    = await context.newPage();
  const baseUrl = process.env.BASE_URL ?? cfg.baseUrl;

  console.log(`  Auth: logging in via ${authCfg.loginUrl}`);

  await page.goto(`${baseUrl}${authCfg.loginUrl}`, {
    waitUntil: "domcontentloaded",
    timeout:   15_000,
  });

  // Fill login form — use configured selectors or common defaults
  const userSel = authCfg.usernameSelector ?? "input[type='email'], input[name='username'], input[name='email'], #username, #email";
  const passSel = authCfg.passwordSelector ?? "input[type='password'], input[name='password'], #password";
  const btnSel  = authCfg.submitSelector   ?? "button[type='submit'], input[type='submit'], button:has-text('Login'), button:has-text('Sign in')";

  try {
    await page.locator(userSel).first().fill(username);
    await page.locator(passSel).first().fill(password);
    await page.locator(btnSel).first().click();

    // Wait for successful login
    if (authCfg.waitFor) {
      await page.locator(authCfg.waitFor).waitFor({ state: "visible", timeout: 10_000 });
    } else if (authCfg.successUrl) {
      await page.waitForURL(`**${authCfg.successUrl}`, { timeout: 10_000 });
    } else {
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
    }

    console.log(`  Auth: login successful`);
  } catch (err) {
    await page.close();
    throw new Error(`Login failed: ${err.message}`);
  }

  await page.close();

  const session   = new AuthSession(context, cfg);
  session._authed = true;

  // Save session immediately
  if (cookiePath) await session.save();

  return session;
}

// ─── Per-route auth helper ────────────────────────────────────────────────────

export async function openAuthenticatedPage(browser, cfg, route, viewport) {
  if (!route.requiresAuth || !cfg.auth) {
    const context = await browser.newContext({ viewport });
    return { page: await context.newPage(), context, close: () => context.close() };
  }

  const session = await createAuthSession(browser, cfg, viewport);
  const page    = await session.newPage();
  return {
    page,
    context: session._context,
    close:   () => session.close(),
  };
}
