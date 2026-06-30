import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './integration',
  fullyParallel: true,
  retries: 0,

  reporter: [
    ['list'],
    ['html', { outputFolder: '../.playwright-report', open: 'never' }],
  ],

  // Visual regression snapshots land next to each spec file
  snapshotPathTemplate: '{testDir}/snapshots/{projectName}/{testFilePath}/{arg}{ext}',

  use: {
    baseURL:    BASE_URL,
    headless:   true,
    screenshot: 'on',
    video:      'retain-on-failure',
  },

  projects: [
    {
      name: 'mobile',
      use:  { ...devices['iPhone 14'] },
    },
    {
      name: 'tablet',
      use:  { ...devices['iPad Pro 11'] },
    },
    {
      name: 'desktop',
      use:  { viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'dark',
      use:  { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
    },
  ],
});