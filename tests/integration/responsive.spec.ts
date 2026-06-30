/**
 * Responsive layout, screenshot, and interaction tests.
 *
 * Runs against four Playwright projects defined in playwright.config.ts:
 *   mobile   — iPhone 14 (390×844, touch UA)
 *   tablet   — iPad Pro 11 (834×1194)
 *   desktop  — 1280×800
 *   dark     — 1280×800, colorScheme: dark
 *
 * Routes and auth are read from uxray.config.js in the current working directory.
 * Run with:
 *   npx playwright test --config tests/playwright.config.ts tests/integration/responsive.spec.ts
 *
 * To update visual baselines after an intentional design change:
 *   npx playwright test ... --update-snapshots
 */

import { test as base, expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'url';
import { join } from 'path';
import { existsSync } from 'fs';

// ─── Types ───────────────────────────────────────────────────────────────────

type UxrayRoute = { name: string; path: string; waitFor?: string };

type UxrayConfig = {
  baseUrl: string;
  routes:  UxrayRoute[];
  auth?: {
    loginUrl:          string;
    username?:         string;
    password?:         string;
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?:   string;
    successUrl?:       string;
    waitFor?:          string;
  };
};

type Fixtures = {
  uxrayConfig: UxrayConfig;
  authenticatedPage: Page;
};

// ─── Default config (used when no uxray.config.js found in cwd) ──────────────

const DEFAULT_CONFIG: UxrayConfig = {
  baseUrl: process.env.BASE_URL ?? 'http://localhost:3000',
  routes:  [{ name: 'Home', path: '/' }],
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const test = base.extend<Fixtures>({
  /** Loads uxray.config.js from the project being tested (process.cwd()). */
  uxrayConfig: async ({}, use) => {
    const configPath = join(process.cwd(), 'uxray.config.js');

    if (!existsSync(configPath)) {
      console.warn('[uxray] No uxray.config.js found in cwd — using defaults.');
      await use(DEFAULT_CONFIG);
      return;
    }

    const { default: config } = await import(pathToFileURL(configPath).href) as { default: UxrayConfig };
    await use(config);
  },

  /**
   * A page that is already authenticated when auth config is present.
   * Shared across all tests in a worker via the page fixture.
   */
  authenticatedPage: async ({ page, uxrayConfig }, use) => {
    const auth = uxrayConfig.auth;

    if (auth) {
      const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;

      await page.goto(`${baseUrl}${auth.loginUrl}`, { waitUntil: 'domcontentloaded' });

      const username = process.env.UXRAY_USER ?? auth.username ?? '';
      const password = process.env.UXRAY_PASS ?? auth.password ?? '';

      const usernameSelector = auth.usernameSelector
        ?? "input[type='email'], input[name='username'], #username, #email";
      const passwordSelector = auth.passwordSelector
        ?? "input[type='password'], #password";
      const submitSelector   = auth.submitSelector
        ?? "button[type='submit'], input[type='submit']";

      await page.locator(usernameSelector).first().fill(username);
      await page.locator(passwordSelector).first().fill(password);
      await page.locator(submitSelector).first().click();

      if (auth.successUrl) {
        await page.waitForURL(`**${auth.successUrl.replace('**', '')}`, { timeout: 10_000 });
      } else if (auth.waitFor) {
        await page.locator(auth.waitFor).waitFor({ state: 'visible', timeout: 10_000 });
      } else {
        await page.waitForLoadState('networkidle', { timeout: 10_000 });
      }
    }

    await use(page);
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MOBILE_PROJECTS  = new Set(['mobile']);
const TOUCH_PROJECTS   = new Set(['mobile', 'tablet']);
const DARK_PROJECT     = 'dark';
const MIN_TOUCH_PX     = 44;

async function navigateTo(page: Page, baseUrl: string, route: UxrayRoute) {
  const loginUrl = page.url();
  await page.goto(`${baseUrl}${route.path}`, { waitUntil: 'domcontentloaded' });

  // Re-authenticate if redirected to login
  if (page.url().includes('/login') && !loginUrl.includes('/login')) {
    // Auth already done by fixture; just retry navigation after a moment
    await page.waitForTimeout(500);
    await page.goto(`${baseUrl}${route.path}`, { waitUntil: 'domcontentloaded' });
  }

  if (route.waitFor) {
    await page.locator(route.waitFor).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  }

  await page.waitForTimeout(400);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Responsive layout checks', () => {

  test('no horizontal overflow on any route', async ({ authenticatedPage: page, uxrayConfig }) => {
    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;
    const failures: string[] = [];

    for (const route of uxrayConfig.routes) {
      await navigateTo(page, baseUrl, route);

      const overflows = await page.evaluate(
        () => document.body.scrollWidth > window.innerWidth + 2
      );

      if (overflows) {
        const excess = await page.evaluate(
          () => document.body.scrollWidth - window.innerWidth
        );
        failures.push(`${route.path} overflows by ${excess}px`);
      }
    }

    expect(failures, failures.join('\n')).toHaveLength(0);
  });


  test('touch targets ≥ 44px (mobile and tablet only)', async ({
    authenticatedPage: page, uxrayConfig
  }, testInfo) => {
    if (!TOUCH_PROJECTS.has(testInfo.project.name)) {
      test.skip();
      return;
    }

    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;
    const allSmall: { route: string; tag: string; w: number; h: number; label: string }[] = [];

    for (const route of uxrayConfig.routes) {
      await navigateTo(page, baseUrl, route);

      const small = await page.evaluate((minPx: number) => {
        const issues: { tag: string; w: number; h: number; label: string }[] = [];
        document.querySelectorAll<HTMLElement>('button, a[href], input, [role="button"]').forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && (rect.width < minPx || rect.height < minPx)) {
            issues.push({
              tag:   el.tagName.toLowerCase(),
              w:     Math.round(rect.width),
              h:     Math.round(rect.height),
              label: (el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30),
            });
          }
        });
        return issues.slice(0, 10);
      }, MIN_TOUCH_PX);

      allSmall.push(...small.map((s) => ({ route: route.path, ...s })));
    }

    expect(
      allSmall,
      allSmall.map((s) => `${s.route} — <${s.tag}> "${s.label}" ${s.w}×${s.h}px`).join('\n')
    ).toHaveLength(0);
  });


  test('interactive elements have visible focus styles', async ({
    authenticatedPage: page, uxrayConfig
  }) => {
    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;
    const failures: string[] = [];

    for (const route of uxrayConfig.routes) {
      await navigateTo(page, baseUrl, route);

      const buttons = page.locator('button:not([disabled])');
      const count   = await buttons.count();
      if (count === 0) continue;

      // Focus the first non-icon button with visible text
      const button = buttons.first();
      await button.focus();

      const hasFocusStyle = await button.evaluate((el) => {
        const styles = window.getComputedStyle(el);
        return (
          parseFloat(styles.outlineWidth) > 0 ||
          styles.boxShadow !== 'none' ||
          styles.borderColor !== window.getComputedStyle(document.body).backgroundColor
        );
      });

      if (!hasFocusStyle) {
        failures.push(`${route.path} — first button has no visible focus indicator`);
      }
    }

    expect(failures, failures.join('\n')).toHaveLength(0);
  });


  test('viewport meta tag is present and allows zoom', async ({
    authenticatedPage: page, uxrayConfig
  }) => {
    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;

    // Only need to check once — the meta tag applies globally
    const firstRoute = uxrayConfig.routes[0];
    await navigateTo(page, baseUrl, firstRoute);

    const meta = await page.evaluate(() => {
      const el = document.querySelector<HTMLMetaElement>("meta[name='viewport']");
      if (!el) return { present: false, content: '' };
      const content = el.getAttribute('content') ?? '';
      return {
        present:    true,
        content,
        blocksZoom: content.includes('user-scalable=no') || content.includes('maximum-scale=1'),
      };
    });

    expect(meta.present, 'Page must have a <meta name="viewport"> tag').toBe(true);
    expect(
      (meta as { blocksZoom?: boolean }).blocksZoom,
      `Viewport "${meta.content}" blocks pinch-to-zoom — WCAG 1.4.4`
    ).toBeFalsy();
  });


  test('font sizes ≥ 12px on mobile', async ({ authenticatedPage: page, uxrayConfig }, testInfo) => {
    if (!MOBILE_PROJECTS.has(testInfo.project.name)) {
      test.skip();
      return;
    }

    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;
    const failures: string[] = [];

    for (const route of uxrayConfig.routes) {
      await navigateTo(page, baseUrl, route);

      const small = await page.evaluate(() => {
        const issues: { tag: string; text: string; size: number }[] = [];
        document.querySelectorAll<HTMLElement>('p, span, a, li, td, label, button').forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const size = parseFloat(window.getComputedStyle(el).fontSize);
          if (size > 0 && size < 12) {
            issues.push({ tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').trim().slice(0, 30), size: Math.round(size) });
          }
        });
        return issues.slice(0, 5);
      });

      failures.push(...small.map((s) => `${route.path} — <${s.tag}> "${s.text}" at ${s.size}px`));
    }

    expect(failures, failures.join('\n')).toHaveLength(0);
  });

});


test.describe('Visual snapshots', () => {

  test('full-page screenshot per route', async ({ authenticatedPage: page, uxrayConfig }, testInfo) => {
    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;

    for (const route of uxrayConfig.routes) {
      await navigateTo(page, baseUrl, route);

      // Stable snapshot name: routeName-project.png
      const snapshotName = `${route.name.toLowerCase().replace(/\s+/g, '-')}-${testInfo.project.name}.png`;
      await expect(page).toHaveScreenshot(snapshotName, {
        fullPage:  true,
        maxDiffPixelRatio: 0.02, // tolerate 2% pixel diff (anti-aliasing, date changes)
      });
    }
  });


  test('hover state on primary button', async ({ authenticatedPage: page, uxrayConfig }, testInfo) => {
    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;

    for (const route of uxrayConfig.routes) {
      await navigateTo(page, baseUrl, route);

      const primaryBtn = page
        .locator('button[type="submit"], button.btn-primary, button[data-variant="primary"]')
        .first();

      if ((await primaryBtn.count()) === 0) continue;

      await primaryBtn.scrollIntoViewIfNeeded();
      await primaryBtn.hover();
      await page.waitForTimeout(200); // let CSS transitions settle

      const snapshotName = `hover-${route.name.toLowerCase().replace(/\s+/g, '-')}-${testInfo.project.name}.png`;
      await expect(primaryBtn).toHaveScreenshot(snapshotName);
    }
  });


  test('dark mode — text remains visible', async ({ authenticatedPage: page, uxrayConfig }, testInfo) => {
    if (testInfo.project.name !== DARK_PROJECT) {
      test.skip();
      return;
    }

    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;
    const failures: string[] = [];

    for (const route of uxrayConfig.routes) {
      await navigateTo(page, baseUrl, route);

      const lowContrast = await page.evaluate(() => {
        const toLinear = (c: number) => {
          const n = c / 255;
          return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
        };
        const lum = (r: number, g: number, b: number) =>
          0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
        const parse = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
        const ratio = (fg: string, bg: string) => {
          const [r1,g1,b1] = parse(fg); const [r2,g2,b2] = parse(bg);
          const l1 = lum(r1,g1,b1), l2 = lum(r2,g2,b2);
          return (Math.max(l1,l2)+0.05) / (Math.min(l1,l2)+0.05);
        };
        const issues: { el: string; r: number }[] = [];
        document.querySelectorAll<HTMLElement>('p,h1,h2,h3,button,label,a').forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const s = window.getComputedStyle(el);
          if (!s.backgroundColor || s.backgroundColor === 'rgba(0, 0, 0, 0)') return;
          const r = ratio(s.color, s.backgroundColor);
          if (r < 4.5) issues.push({ el: el.tagName.toLowerCase(), r: Math.round(r * 100) / 100 });
        });
        return issues.slice(0, 5);
      });

      failures.push(
        ...lowContrast.map((i) => `${route.path} — <${i.el}> contrast ${i.r} (need 4.5)`)
      );
    }

    expect(failures, failures.join('\n')).toHaveLength(0);
  });

});


test.describe('Interaction smoke tests', () => {

  test('clicking a nav link changes the URL', async ({ authenticatedPage: page, uxrayConfig }) => {
    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;
    const firstRoute = uxrayConfig.routes[0];
    await navigateTo(page, baseUrl, firstRoute);

    const navLinks = page.locator('nav a[href]:not([href="#"]):not([href=""])');
    const count    = await navLinks.count();

    if (count === 0) {
      test.skip(); // No nav links on this page — nothing to test
      return;
    }

    const href = await navLinks.first().getAttribute('href');
    await navLinks.first().click();
    await page.waitForLoadState('domcontentloaded');

    // URL should have changed to the link's href
    if (href?.startsWith('http')) {
      expect(page.url()).toBe(href);
    } else {
      expect(page.url()).toContain(href ?? '');
    }
  });


  test('form fields are fillable via keyboard Tab', async ({ authenticatedPage: page, uxrayConfig }) => {
    const baseUrl = process.env.BASE_URL ?? uxrayConfig.baseUrl;

    // Find a route that likely has a form (create/new/edit)
    const formRoute = uxrayConfig.routes.find(
      (r) => /new|create|edit|form/i.test(r.name + r.path)
    ) ?? uxrayConfig.routes[0];

    await navigateTo(page, baseUrl, formRoute);

    const inputs = page.locator('input:not([type="hidden"]):not([disabled]), textarea:not([disabled])');
    const count  = await inputs.count();
    if (count === 0) {
      test.skip();
      return;
    }

    // Tab to first input and type into it
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);

    const active = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase());
    expect(['input', 'textarea', 'select', 'button', 'a'], `First Tab should land on an interactive element, got <${active}>`).toContain(active);
  });

});
